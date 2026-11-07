import { ADVISORY_APPLICABILITY_V3, ADVISORY_EVALUATION_V1, ADVISORY_PACKAGE_COVERAGE_V1, ADVISORY_OMISSION_REASONS_V1 } from '@hub/contracts/scanner-v2-advisory';
import { createAdvisoryCatalogueDigest, admitAdvisoryCatalogue } from './advisory-admission';
import { createAdvisoryFactV1 as fact, buildAdvisoryFactsV1 } from './advisory-evaluation';
import { evaluateAdvisoryApplicabilityDetail } from './advisory-applicability';
import { validateTargetContextV3, type TargetContextV3 } from '../semantics/target-context';
import type { SafeFactV2 } from '../capabilities/scheduler';
import type { AdvisoryRecordV2 } from './advisory-schema';
import { validateAdvisoryCoherenceV1 } from '@hub/contracts/scanner-v2-advisory-coherence';

export type SyntheticAdvisoryAdmissionV3 = Readonly<{
  sourceId: string; pinDigest: string; coverageDigest: string; rightsReceiptDigest: string;
  provenanceReceiptDigest: string; boundsDigest: string; admissionReceiptDigest: string;
  pinnedSnapshotSha256: string; snapshotSha256: string; capturedAt: string; admittedAt: string;
  evaluatedAt: string; catalogueVersion: string; catalogueDigest: string; coverageClaimed: boolean;
  coveredPairs: readonly Readonly<{ packageName: string; packageVersion: string | null }>[];
  records: readonly AdvisoryRecordV2[];
  bounds: Readonly<{ maxPackages: number; maxRowsPerPackage: number; maxRows: number; maxAgeMs: number }>;
}>;
const compare = (a: string, b: string): number => a === b ? 0 : a < b ? -1 : 1;
const pairs = (target: TargetContextV3) => target.communityPackages.map(({ name, version }) => ({ packageName: name, packageVersion: version ?? null }));
type EvaluationState = 'PARTIAL' | 'COMPLETE';
/** TEST-ONLY admission seam. Production callers never pass receipt-shaped input here. */
export function buildSyntheticAdmittedAdvisoryFactsV3(input: Readonly<{
  target: TargetContextV3; admission: SyntheticAdvisoryAdmissionV3;
}>): readonly SafeFactV2[] {
  const target = validateTargetContextV3(input.target);
  const admission = input.admission;
  const declared = pairs(target);
  if (declared.length === 0) return buildAdvisoryFactsV1({ target, request: { requested: true, inventoryState: 'DECLARED' } });
  const b = admission.bounds;
  if (!b || ![b.maxPackages, b.maxRowsPerPackage, b.maxRows, b.maxAgeMs].every((n) => Number.isSafeInteger(n) && n > 0)
    || b.maxAgeMs > 604800000) return refused(target, 'BOUNDS_INVALID');
  for (const time of [admission.capturedAt, admission.admittedAt, admission.evaluatedAt]) {
    if (!Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time) throw new TypeError('Invalid evaluation clock');
  }
  if (admission.evaluatedAt < admission.capturedAt) return refused(target, 'EVALUATED_AT_BEFORE_CAPTURE', admission);
  if (Date.parse(admission.evaluatedAt) - Date.parse(admission.capturedAt) > b.maxAgeMs) return refused(target, 'SNAPSHOT_STALE_AT_EVALUATION', admission);
  const catalogueBody = { schemaVersion: 'scanner-advisories-v2', version: admission.catalogueVersion, records: admission.records };
  const catalogue = admitAdvisoryCatalogue({ ...catalogueBody, digest: createAdvisoryCatalogueDigest(catalogueBody) });
  if (admission.catalogueDigest !== catalogue.digest) throw new TypeError('Catalogue digest mismatch');
  const visited = declared.slice(0, b.maxPackages);
  const coveredKeys = new Set(admission.coveredPairs.map((pair) => `${pair.packageName}\u0000${pair.packageVersion ?? ''}`));
  const coverageFacts = visited.map((pair) => {
    const covered = admission.coverageClaimed && pair.packageVersion !== null && coveredKeys.has(`${pair.packageName}\u0000${pair.packageVersion ?? ''}`);
    return fact(ADVISORY_PACKAGE_COVERAGE_V1, {
      packageName: pair.packageName, packageVersion: pair.packageVersion,
      coverageState: covered ? 'COVERED' : 'UNKNOWN',
      coverageReason: pair.packageVersion === null ? 'VERSION_MISSING' : !admission.coverageClaimed ? 'NO_COMPLETENESS_PROOF' : covered ? 'DECLARED' : 'PACKAGE_NOT_IN_COVERAGE',
    });
  });
  const rows: SafeFactV2[] = [];
  const omission = new Set<'PACKAGE_LIMIT' | 'ROW_LIMIT' | 'VERSION_UNKNOWN'>();
  if (visited.length < declared.length) omission.add('PACKAGE_LIMIT');
  let examined = 0;
  const orderedRecords = [...catalogue.records].sort((left, right) => compare(left.packageName, right.packageName) || compare(left.id, right.id));
  for (const pair of visited) {
    let perPackage = 0;
    for (const advisory of orderedRecords) {
      if (advisory.packageName !== pair.packageName) continue;
      examined += 1;
      if (pair.packageVersion === null) { omission.add('VERSION_UNKNOWN'); continue; }
      if (perPackage >= b.maxRowsPerPackage || rows.length >= b.maxRows
        || advisory.prerequisites.length > 1000) { omission.add('ROW_LIMIT'); continue; }
      const verdict = evaluateAdvisoryApplicabilityDetail(advisory, target, pair.packageVersion);
      rows.push(fact(ADVISORY_APPLICABILITY_V3, {
        advisoryId: advisory.id, packageName: pair.packageName, installedVersion: pair.packageVersion,
        reviewState: advisory.reviewState, applicability: verdict.applicability, rowReason: verdict.reason,
        matchedPrerequisites: verdict.matchedPrerequisites, unknownPrerequisites: verdict.unknownPrerequisites,
      }));
      perPackage += 1;
    }
  }
  rows.sort((left, right) => compare(String(left.properties.packageName), String(right.properties.packageName))
    || compare(String(left.properties.installedVersion), String(right.properties.installedVersion))
    || compare(String(left.properties.advisoryId), String(right.properties.advisoryId)));
  const applicable = rows.filter((row) => row.properties.applicability === 'APPLICABLE').length;
  const notApplicable = rows.filter((row) => row.properties.applicability === 'NOT_APPLICABLE').length;
  const unknown = rows.filter((row) => row.properties.applicability === 'UNKNOWN').length;
  const packagesCovered = coverageFacts.filter((item) => item.properties.coverageState === 'COVERED').length;
  const omissionReasons = [...omission].sort((left, right) => ADVISORY_OMISSION_REASONS_V1.indexOf(left) - ADVISORY_OMISSION_REASONS_V1.indexOf(right));
  const complete = admission.coverageClaimed && packagesCovered === declared.length && omissionReasons.length === 0 && unknown === 0 && declared.length > 0;
  const state: EvaluationState = complete ? 'COMPLETE' : 'PARTIAL';
  const aggregate = fact(ADVISORY_EVALUATION_V1, {
    evaluationState: state, evaluationReason: 'NONE', targetDigest: input.target.contextDigest,
    sourceId: admission.sourceId, pinDigest: admission.pinDigest, coverageDigest: admission.coverageDigest,
    rightsReceiptDigest: admission.rightsReceiptDigest, provenanceReceiptDigest: admission.provenanceReceiptDigest,
    boundsDigest: admission.boundsDigest, admissionReceiptDigest: admission.admissionReceiptDigest,
    pinnedSnapshotSha256: admission.pinnedSnapshotSha256, snapshotSha256: admission.snapshotSha256,
    capturedAt: admission.capturedAt, admittedAt: admission.admittedAt, evaluatedAt: admission.evaluatedAt,
    catalogueVersion: admission.catalogueVersion, catalogueDigest: admission.catalogueDigest,
    coverageClaimed: admission.coverageClaimed, packagesRequested: declared.length,
    packagesCovered, packageRowsOmitted: declared.length - visited.length, recordsExamined: examined,
    recordsApplicable: applicable, recordsNotApplicable: notApplicable, recordsUnknown: unknown,
    omissionReasons,
  });
  const facts = Object.freeze([aggregate, ...coverageFacts, ...rows].sort((left, right) => compare(left.kind, right.kind) || compare(left.factId, right.factId)));
  if (validateAdvisoryCoherenceV1(target, facts).length) throw new TypeError('Incoherent synthetic advisory evaluation');
  return facts;
}

function refused(target: TargetContextV3, reason: string, admission?: SyntheticAdvisoryAdmissionV3): readonly SafeFactV2[] {
  const unavailable = buildAdvisoryFactsV1({ target, request: { requested: true, inventoryState: 'DECLARED' } });
  const aggregate = unavailable.find((item) => item.kind === ADVISORY_EVALUATION_V1)!;
  const identity = admission === undefined ? {} : {
    sourceId: admission.sourceId, pinDigest: admission.pinDigest, coverageDigest: admission.coverageDigest,
    rightsReceiptDigest: admission.rightsReceiptDigest, provenanceReceiptDigest: admission.provenanceReceiptDigest,
    boundsDigest: admission.boundsDigest, admissionReceiptDigest: admission.admissionReceiptDigest,
    pinnedSnapshotSha256: admission.pinnedSnapshotSha256, snapshotSha256: admission.snapshotSha256,
    capturedAt: admission.capturedAt, admittedAt: admission.admittedAt,
    catalogueVersion: admission.catalogueVersion, catalogueDigest: admission.catalogueDigest,
  };
  return Object.freeze(unavailable.map((item) => item === aggregate
    ? fact(item.kind, { ...item.properties, ...identity, evaluationState: 'REFUSED', evaluationReason: reason } as Parameters<typeof fact>[1])
    : fact(item.kind, { ...item.properties, coverageReason: 'EVALUATION_REFUSED' } as Parameters<typeof fact>[1])));
}
