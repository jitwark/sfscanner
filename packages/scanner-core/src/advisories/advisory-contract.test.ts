import { describe, expect, it } from 'vitest';
import { validateScannerResultV2 } from '@hub/contracts/scanner-v2-result';
import { validateTargetContextV3 } from '../semantics/target-context';
import { scanWorkflowV2 } from '../v2/scan-workflow';
import { projectResultV2ToV1 } from '../compat/v1-projector';
import { createAdvisoryCatalogueDigest } from './advisory-admission';
import { buildSyntheticAdmittedAdvisoryFactsV3, type SyntheticAdvisoryAdmissionV3 } from './synthetic-advisory-evaluation';
import type { AdvisoryRecordV2 } from './advisory-schema';
import vectors from '../../../../docs/superpowers/plans/2026-10-21-scanner-deepseek/Q08-ADVISORY-VECTORS.json';

const target = validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: [
  { name: 'pkg', version: '1.2.3' }, { name: 'pkg', version: '2.0.0' },
] });
const record: AdvisoryRecordV2 = {
  id: 'FIXTURE-1', aliases: ['FIXTURE-1'], packageName: 'pkg', rawAffectedRange: '<2.0.0',
  affected: { clauses: [[{ op: 'LT', version: '2.0.0' }]] }, fixedVersions: [], fixedBranches: [],
  prerequisites: [], sourceUrl: 'https://example.invalid/frozen', sourceDigest: 'a'.repeat(64),
  reviewedAt: '2026-11-03T00:00:00.000Z', reviewer: 'fixture', reviewState: 'ADMITTED',
};
function receipt(records: readonly AdvisoryRecordV2[] = [record], overrides: Partial<SyntheticAdvisoryAdmissionV3> = {}): SyntheticAdvisoryAdmissionV3 {
  return {
    sourceId: 'fixture', pinDigest: 'b'.repeat(64), coverageDigest: 'c'.repeat(64), rightsReceiptDigest: 'd'.repeat(64),
    provenanceReceiptDigest: 'e'.repeat(64), boundsDigest: 'f'.repeat(64), admissionReceiptDigest: '1'.repeat(64),
    pinnedSnapshotSha256: '2'.repeat(64), snapshotSha256: '2'.repeat(64), capturedAt: '2026-11-03T00:00:00.000Z',
    admittedAt: '2026-11-03T00:00:01.000Z', evaluatedAt: '2026-11-03T00:00:02.000Z', catalogueVersion: '1.0.0',
    catalogueDigest: createAdvisoryCatalogueDigest({ schemaVersion: 'scanner-advisories-v2', version: '1.0.0', records }),
    coverageClaimed: true, coveredPairs: target.communityPackages.map((p) => ({ packageName: p.name, packageVersion: p.version! })),
    bounds: { maxPackages: 100, maxRowsPerPackage: 100, maxRows: 100, maxAgeMs: 60_000 }, records, ...overrides,
  };
}
const run = (admission: SyntheticAdvisoryAdmissionV3, context = target) => buildSyntheticAdmittedAdvisoryFactsV3({ target: context, admission });
const aggregate = (facts: ReturnType<typeof run>) => facts.find((f) => f.kind === 'advisory.evaluation.v1')!.properties;

describe('Q08 canonical contract controls', () => {
  it.each(vectors.targetBoundary)('implements the frozen target vector $id', (vector) => {
    const input = { schemaVersion: 'scanner-target-v3', ...vector.input };
    if (vector.id === 'strict-raw-version') expect(() => validateTargetContextV3(input)).toThrow('INVALID_PACKAGE_VERSION');
    else {
      const admitted = validateTargetContextV3(input);
      expect(admitted.communityPackages).toEqual(vector.input.communityPackages);
      expect(admitted.schemaVersion).toBe('scanner-target-v3');
    }
  });

  it('keeps native feature-off projection and workflow-specific advisory IDs distinct', () => {
    const request = { bytes: new TextEncoder().encode('{"nodes":[],"connections":{}}'), profile: { id: 'beta-default', version: '2.0.0' }, target };
    const off = scanWorkflowV2(request);
    expect(off.ok).toBe(true); if (!off.ok) return;
    expect(projectResultV2ToV1(off.result).ok).toBe(true);
    const first = scanWorkflowV2({ ...request, advisoryRequest: { requested: true, inventoryState: 'DECLARED' } });
    const second = scanWorkflowV2({ ...request, bytes: new TextEncoder().encode('{"name":"other","nodes":[],"connections":{}}'), advisoryRequest: { requested: true, inventoryState: 'DECLARED' } });
    expect(first.ok && second.ok).toBe(true); if (!first.ok || !second.ok) return;
    const ids = (facts: typeof first.result.facts) => facts.filter((f) => f.kind.startsWith('advisory.')).map((f) => f.factId);
    expect(ids(first.result.facts).some((id) => ids(second.result.facts).includes(id))).toBe(false);
  });

  it('cannot promote an empty catalogue or matching name to complete coverage without exact proof', () => {
    expect(aggregate(run(receipt([], { coverageClaimed: false }))).evaluationState).toBe('PARTIAL');
    expect(aggregate(run(receipt([], { coveredPairs: [{ packageName: 'pkg', packageVersion: '1.2.3' }] }))))
      .toMatchObject({ evaluationState: 'PARTIAL', packagesCovered: 1 });
    expect(aggregate(run(receipt([])))).toMatchObject({ evaluationState: 'COMPLETE', recordsExamined: 0, packagesCovered: 2 });
  });

  it('reports actual visited pairs and examined rows under package and row bounds', () => {
    const packageLimit = run(receipt([record], { bounds: { maxPackages: 1, maxRowsPerPackage: 5, maxRows: 5, maxAgeMs: 60_000 } }));
    expect(aggregate(packageLimit)).toMatchObject({ evaluationState: 'PARTIAL', packageRowsOmitted: 1, recordsExamined: 1, omissionReasons: ['PACKAGE_LIMIT'] });
    const rowLimit = run(receipt([record], { bounds: { maxPackages: 2, maxRowsPerPackage: 5, maxRows: 1, maxAgeMs: 60_000 } }));
    expect(aggregate(rowLimit)).toMatchObject({ evaluationState: 'PARTIAL', recordsExamined: 2, recordsApplicable: 1, recordsNotApplicable: 0, omissionReasons: ['ROW_LIMIT'] });
  });

  it('keeps withdrawn/rejected records UNKNOWN and names unresolved scoped prerequisites', () => {
    for (const reviewState of ['WITHDRAWN', 'REJECTED'] as const) {
      const facts = run(receipt([{ ...record, reviewState }]));
      expect(aggregate(facts)).toMatchObject({ evaluationState: 'PARTIAL', recordsUnknown: 2 });
      for (const row of facts.filter((f) => f.kind === 'advisory.applicability.v3')) expect(row.properties)
        .toMatchObject({ rowReason: 'ADVISORY_NOT_ADMITTED', unknownPrerequisites: ['advisoryReviewState'] });
    }
    const facts = run(receipt([{ ...record, prerequisites: [{ key: 'package:@scope/name', expected: '1.0.0' }] }]));
    expect(facts.find((f) => f.kind === 'advisory.applicability.v3')?.properties)
      .toMatchObject({ applicability: 'UNKNOWN', rowReason: 'TARGET_PREREQUISITE_UNKNOWN', unknownPrerequisites: ['package:@scope/name'] });
  });

  it('omits rows for missing versions and refuses stale/evaluation-before-capture/invalid bounds truthfully', () => {
    const missing = validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: [{ name: 'pkg' }] });
    const facts = run(receipt(), missing);
    expect(aggregate(facts)).toMatchObject({ evaluationState: 'PARTIAL', recordsExamined: 1, recordsUnknown: 0, omissionReasons: ['VERSION_UNKNOWN'] });
    expect(facts.filter((f) => f.kind === 'advisory.applicability.v3')).toHaveLength(0);
    for (const [change, reason] of [
      [{ evaluatedAt: '2026-11-03T00:02:00.000Z' }, 'SNAPSHOT_STALE_AT_EVALUATION'],
      [{ evaluatedAt: '2026-11-02T23:59:59.000Z' }, 'EVALUATED_AT_BEFORE_CAPTURE'],
      [{ bounds: { maxPackages: 0, maxRows: 1, maxRowsPerPackage: 1, maxAgeMs: 1 } }, 'BOUNDS_INVALID'],
    ] as const) expect(aggregate(run(receipt([record], change)))).toMatchObject({ evaluationState: 'REFUSED', evaluationReason: reason, recordsExamined: 0, evaluatedAt: null });
  });

  it('fails final read and projection when requested metadata is forged or omitted', () => {
    const scanned = scanWorkflowV2({ bytes: new TextEncoder().encode('{"nodes":[],"connections":{}}'), profile: { id: 'beta-default', version: '2.0.0' }, target, advisoryRequest: { requested: true, inventoryState: 'DECLARED' } });
    expect(scanned.ok).toBe(true); if (!scanned.ok) return;
    expect(projectResultV2ToV1(scanned.result)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
    const index = scanned.result.facts.findIndex((f) => f.kind === 'advisory.evaluation.v1');
    for (const mutation of ([{ targetDigest: 'f'.repeat(64) }, { packagesRequested: 1 }, { recordsUnknown: 1 }, { snapshotSha256: 'b'.repeat(64) }, { evaluationReason: 'NONE' }, { extra: 'private payload' }] as Record<string, string | number>[])) {
      const changed = structuredClone(scanned.result);
      changed.facts[index].properties = { ...changed.facts[index].properties, ...mutation };
      expect(validateScannerResultV2(changed).ok, JSON.stringify(mutation)).toBe(false);
    }
    expect(validateScannerResultV2({ ...scanned.result, facts: scanned.result.facts.filter((f) => !f.kind.startsWith('advisory.')) }).ok).toBe(false);
    const partialCoverage = { ...scanned.result, facts: scanned.result.facts.filter((f) => f.kind !== 'advisory.package-coverage.v1') };
    expect(validateScannerResultV2(partialCoverage).ok).toBe(false);
  });
});
