import { createAdvisoryCatalogueDigest } from './advisory-admission';
import { describe, expect, it } from 'vitest';
import { validateAdvisoryCoherenceV1 } from '@hub/contracts/scanner-v2-advisory-coherence';
import { SAFE_FACT_REGISTRY_V2 } from '../facts/safe-fact-registry';
import { validateSafeFact } from '../facts/safe-fact-validator';
import { createSafeFactAdmissionSnapshotV2 } from '../admission/snapshot';
import { validateTargetContextV3 } from '../semantics/target-context';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import type { AdvisoryRecordV2 } from './advisory-schema';
import { buildAdvisoryFactsV1 } from './advisory-evaluation';
import { buildSyntheticAdmittedAdvisoryFactsV3, type SyntheticAdvisoryAdmissionV3 } from './synthetic-advisory-evaluation';

const digest = (value: string) => value.repeat(64);
const target = validateTargetContextV3({
  schemaVersion: 'scanner-target-v3', n8nVersion: '1.0.0', edition: 'COMMUNITY', deployment: 'SELF_HOSTED', role: 'OWNER', taskRunner: 'NATIVE',
  communityPackages: [{ name: 'pkg', version: '2.0.0' }, { name: 'pkg', version: '1.2.3' }], configuration: [],
});
const advisory: AdvisoryRecordV2 = Object.freeze({
  id: 'ADVISORY-1', aliases: Object.freeze(['ADVISORY-1']), packageName: 'pkg', rawAffectedRange: '>=1.0.0 <2.0.0',
  affected: Object.freeze({ clauses: Object.freeze([Object.freeze([
    Object.freeze({ op: 'GTE', version: '1.0.0' }), Object.freeze({ op: 'LT', version: '2.0.0' }),
  ])]) }), fixedVersions: Object.freeze([]), fixedBranches: Object.freeze([]), prerequisites: Object.freeze([]),
  sourceUrl: 'https://example.test/advisory/ADVISORY-1', sourceDigest: digest('a'), reviewedAt: '2026-11-03',
  reviewer: 'fixture', reviewState: 'ADMITTED',
});
const admission: SyntheticAdvisoryAdmissionV3 = Object.freeze({
  bounds: { maxPackages: 100, maxRowsPerPackage: 100, maxRows: 100, maxAgeMs: 60_000 },
  sourceId: 'fixture-source', pinDigest: digest('b'), coverageDigest: digest('c'), rightsReceiptDigest: digest('d'),
  provenanceReceiptDigest: digest('e'), boundsDigest: digest('f'), admissionReceiptDigest: digest('1'),
  pinnedSnapshotSha256: digest('2'), snapshotSha256: digest('2'), capturedAt: '2026-11-03T00:00:00.000Z',
  admittedAt: '2026-11-03T00:00:01.000Z', evaluatedAt: '2026-11-03T00:00:02.000Z', catalogueVersion: '1.0.0',
  catalogueDigest: createAdvisoryCatalogueDigest({ schemaVersion: 'scanner-advisories-v2', version: '1.0.0', records: [advisory] }), coverageClaimed: true,
  coveredPairs: Object.freeze([{ packageName: 'pkg', packageVersion: '1.2.3' }, { packageName: 'pkg', packageVersion: '2.0.0' }]),
  records: Object.freeze([advisory]),
});

function evaluation(facts: ReturnType<typeof buildAdvisoryFactsV1>) {
  return facts.find((fact) => fact.kind === 'advisory.evaluation.v1')!;
}

describe('canonical advisory evaluation', () => {
  it('distinguishes NOT_REQUESTED, explicit empty scope, and unverified inventory', () => {
    expect(evaluation(buildAdvisoryFactsV1({ target })).properties).toMatchObject({ evaluationState: 'NOT_REQUESTED', evaluationReason: 'NONE', packagesRequested: 0 });
    const empty = validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: [], configuration: [] });
    expect(evaluation(buildAdvisoryFactsV1({ target: empty, request: { requested: true, inventoryState: 'DECLARED' } })).properties)
      .toMatchObject({ evaluationState: 'NO_DECLARED_PACKAGES', evaluationReason: 'NONE', packagesRequested: 0 });
    const refused = buildAdvisoryFactsV1({ target, request: { requested: true, inventoryState: 'UNVERIFIED' } });
    expect(evaluation(refused).properties).toMatchObject({ evaluationState: 'REFUSED', evaluationReason: 'INVENTORY_UNVERIFIED', packagesRequested: 0 });
    expect(refused.filter((fact) => fact.kind === 'advisory.package-coverage.v1')).toHaveLength(0);
  });

  it('emits one UNKNOWN coverage fact per declared pair and no invented rows without a receipt', () => {
    const facts = buildAdvisoryFactsV1({ target, request: { requested: true, inventoryState: 'DECLARED' } });
    expect(evaluation(facts).properties).toMatchObject({ evaluationState: 'UNAVAILABLE', evaluationReason: 'NO_ADMITTED_SNAPSHOT', packagesRequested: 2, recordsUnknown: 0 });
    expect(facts.filter((fact) => fact.kind === 'advisory.package-coverage.v1').map((fact) => fact.properties)).toEqual([
      { packageName: 'pkg', packageVersion: '1.2.3', coverageState: 'UNKNOWN', coverageReason: 'SNAPSHOT_UNAVAILABLE' },
      { packageName: 'pkg', packageVersion: '2.0.0', coverageState: 'UNKNOWN', coverageReason: 'SNAPSHOT_UNAVAILABLE' },
    ]);
    expect(facts.some((fact) => fact.kind === 'advisory.applicability.v3')).toBe(false);
    expect(validateAdvisoryCoherenceV1(target, facts)).toEqual([]);
    for (const fact of facts) {
      const result = validateSafeFact(createSafeFactAdmissionSnapshotV2(fact), SAFE_FACT_REGISTRY_V2.schemas.find((schema) => schema.kind === fact.kind)!, DEFAULT_SCANNER_LIMITS_V2);
      expect(result, JSON.stringify({ properties: fact.properties, result })).toMatchObject({ ok: true });
    }
  });

  it('keeps the same advisory separate across two installed versions', () => {
    const facts = buildSyntheticAdmittedAdvisoryFactsV3({ target, admission });
    const rows = facts.filter((fact) => fact.kind === 'advisory.applicability.v3');
    expect([...rows].sort((a, b) => String(a.properties.installedVersion).localeCompare(String(b.properties.installedVersion))).map((fact) => fact.properties)).toEqual([
      expect.objectContaining({ advisoryId: 'ADVISORY-1', installedVersion: '1.2.3', applicability: 'APPLICABLE', rowReason: 'IN_AFFECTED_RANGE' }),
      expect.objectContaining({ advisoryId: 'ADVISORY-1', installedVersion: '2.0.0', applicability: 'NOT_APPLICABLE', rowReason: 'OUTSIDE_AFFECTED_RANGE' }),
    ]);
    expect(new Set(rows.map((fact) => fact.factId)).size).toBe(2);
    expect(evaluation(facts).properties).toMatchObject({ evaluationState: 'COMPLETE', packagesRequested: 2, packagesCovered: 2, recordsExamined: 2, recordsApplicable: 1, recordsNotApplicable: 1, recordsUnknown: 0 });
    expect(validateAdvisoryCoherenceV1(target, facts)).toEqual([]);
  });

  it('fails final composition when counts, target identity, or row facts disagree', () => {
    const facts = buildSyntheticAdmittedAdvisoryFactsV3({ target, admission });
    const badDigest = facts.map((fact) => fact.kind === 'advisory.evaluation.v1' ? { ...fact, properties: { ...fact.properties, targetDigest: digest('9') } } : fact);
    expect(validateAdvisoryCoherenceV1(target, badDigest)).toContain('advisory targetDigest disagrees with result target');
    const missingRow = facts.filter((fact) => fact.kind !== 'advisory.applicability.v3');
    expect(validateAdvisoryCoherenceV1(target, missingRow)).toContain('advisory APPLICABLE row count disagrees with facts');
  });
});
