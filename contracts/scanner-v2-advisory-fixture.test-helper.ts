import type { SafeFactV2 } from './scanner-v2-evidence';
export function notRequestedAdvisoryFixture(targetDigest = '0'.repeat(64)): SafeFactV2 {
  return { factId: 'a1'.repeat(32), kind: 'advisory.evaluation.v1', subject: { kind: 'WORKFLOW' }, properties: {
    evaluationState: 'NOT_REQUESTED', evaluationReason: 'NONE', targetDigest, sourceId: null, pinDigest: null,
    coverageDigest: null, rightsReceiptDigest: null, provenanceReceiptDigest: null, boundsDigest: null,
    admissionReceiptDigest: null, pinnedSnapshotSha256: null, snapshotSha256: null, capturedAt: null,
    admittedAt: null, evaluatedAt: null, catalogueVersion: null, catalogueDigest: null, coverageClaimed: false,
    packagesRequested: 0, packagesCovered: 0, packageRowsOmitted: 0, recordsExamined: 0,
    recordsApplicable: 0, recordsNotApplicable: 0, recordsUnknown: 0, omissionReasons: [],
  } };
}
