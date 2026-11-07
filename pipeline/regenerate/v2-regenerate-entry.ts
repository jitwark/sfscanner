import type { EntryReadiness } from '@hub/contracts';
import {
  isAdmittedV2ScanIdentity,
  type V2Grade,
  type V2RescanRecord,
} from '../scan/v2-corpus-adapter.js';
import type { ScanFreshness, V2ScanEvidenceRecord } from './v2-scan-evidence.js';

export const V2_ENTRY_PLAN_SCHEMA_VERSION = 'v2-entry-regeneration-plan-v1' as const;

/** The derived artifact families an entry carries. Each one is a function of the same body. */
export type V2ArtifactGroup = 'readiness' | 'status' | 'analytics' | 'facets' | 'search' | 'detail';
export const V2_ARTIFACT_GROUPS: readonly V2ArtifactGroup[] = Object.freeze([
  'readiness', 'status', 'analytics', 'facets', 'search', 'detail',
]);

/**
 * What regeneration may do with an artifact group: recompute it from an admitted receipt, keep the
 * dated value under an explicit historical label, or leave it absent. A group whose input the record
 * does not support is never freshly stamped.
 */
export type V2ArtifactDisposition = 'regenerated' | 'historical' | 'unavailable';

/** Why a plan holds its state. A closed code, never prose and never a scanner message. */
export type V2PlanReason =
  | 'admitted-receipt'
  | 'readiness-contradiction'
  | 'unadmitted-receipt'
  | 'no-result'
  | 'retained-verdict'
  | 'no-receipt'
  | 'owner-ruling';

export type V2PlanAssessment = Readonly<{
  /** `CURRENT` when an admitted receipt produced these values; `HISTORICAL` when only dated evidence survives. */
  label: 'CURRENT' | 'HISTORICAL';
  /** `null` whenever the producing analysis published no grade — never substituted with `LOW` or `UNKNOWN`. */
  grade: V2Grade | null;
  analysisStatus: V2RescanRecord['analysisStatus'] | null;
  diagnosticCodes: readonly string[];
  /** The scanner identity that produced these values; a provenance label, never an admission. */
  producingIdentity: string;
}>;

export type V2ArtifactPlan = Readonly<{
  group: V2ArtifactGroup;
  disposition: V2ArtifactDisposition;
}>;

/**
 * What one entry's derived artifacts would carry, derived from the retained evidence record for it.
 *
 * The plan is a record, not a write: it carries no body, no path and no value the record does not
 * support. A committed entry's own `security` stamp is never an input — only whether its facts were
 * ever derived from a body, which is the readiness contradiction the contract's CURRENT clause names.
 */
export type V2EntryRegenerationPlan = Readonly<{
  schemaVersion: typeof V2_ENTRY_PLAN_SCHEMA_VERSION;
  entryId: string;
  state: ScanFreshness;
  stateReason: V2PlanReason;
  rightsClass: V2ScanEvidenceRecord['rightsClass'];
  /** The catalogue binding the record was derived from; a plan made from a stale binding is stale. */
  inventorySha256: string;
  assessment: V2PlanAssessment | null;
  bodySha256: string | null;
  resultDigest: string | null;
  receiptReasonCode: string | null;
  artifacts: readonly V2ArtifactPlan[];
}>;

/** The entry fields a plan may consult: its identity, and whether a body ever produced its facts. */
export type V2RegenerationSubject = Readonly<{
  id: string;
  readiness?: Pick<EntryReadiness, 'analysis'>;
}>;

const FRESHNESS: Record<ScanFreshness, true> = {
  CURRENT: true, NO_RESULT: true, HISTORICAL: true, UNSCANNED: true, SOURCE_UNAVAILABLE: true,
};
const DIGEST = /^[0-9a-f]{64}$/;
const NO_CODES: readonly string[] = Object.freeze([]);

const artifacts = (disposition: V2ArtifactDisposition): readonly V2ArtifactPlan[] => Object.freeze(
  V2_ARTIFACT_GROUPS.map((group) => Object.freeze({ group, disposition })),
);

/** Built once per state: a plan never re-allocates the group list, and two plans may share it. */
const ARTIFACTS_PER_STATE: Record<ScanFreshness, readonly V2ArtifactPlan[]> = Object.freeze({
  CURRENT: artifacts('regenerated'),
  NO_RESULT: artifacts('unavailable'),
  HISTORICAL: artifacts('historical'),
  UNSCANNED: artifacts('unavailable'),
  SOURCE_UNAVAILABLE: artifacts('unavailable'),
});

/**
 * The contract's CURRENT preconditions as this consumer can check them. The record's own label is a
 * ceiling — it is never promoted — and a row whose committed readiness says no body was read cannot
 * be planned current while it still says so.
 */
function deriveState(
  record: V2ScanEvidenceRecord,
  readinessDerived: boolean,
): Readonly<{ state: ScanFreshness; stateReason: V2PlanReason }> {
  if (record.scanFreshness === 'SOURCE_UNAVAILABLE') return { state: 'SOURCE_UNAVAILABLE', stateReason: 'owner-ruling' };
  const scan = record.scan;
  if (record.scanFreshness === 'NO_RESULT') return { state: 'NO_RESULT', stateReason: 'no-result' };
  if (record.scanFreshness === 'CURRENT') {
    if (!readinessDerived) return { state: 'HISTORICAL', stateReason: 'readiness-contradiction' };
    const admitted = scan !== null
      && scan.ok
      && scan.entryId === record.entryId
      && scan.resultDigest !== null
      && DIGEST.test(scan.resultDigest)
      && DIGEST.test(scan.bodySha256)
      && isAdmittedV2ScanIdentity(scan.identity);
    return admitted
      ? { state: 'CURRENT', stateReason: 'admitted-receipt' }
      : { state: 'HISTORICAL', stateReason: 'unadmitted-receipt' };
  }
  if (scan === null && record.retainedVerdict === null) return { state: 'UNSCANNED', stateReason: 'no-receipt' };
  return { state: 'HISTORICAL', stateReason: record.retainedVerdict === null ? 'unadmitted-receipt' : 'retained-verdict' };
}

/** The row's own retained verdict outranks a receipt that is not current; neither may be rendered current. */
function assessmentFor(state: ScanFreshness, record: V2ScanEvidenceRecord): V2PlanAssessment | null {
  const scan = record.scan;
  if (state === 'CURRENT' && scan !== null) {
    return Object.freeze({
      label: 'CURRENT',
      grade: scan.assessment === null ? null : scan.assessment.grade,
      analysisStatus: scan.analysisStatus,
      diagnosticCodes: scan.diagnosticCodes,
      producingIdentity: scan.identity.scannerVersion,
    });
  }
  if (state !== 'HISTORICAL') return null;
  const verdict = record.retainedVerdict;
  if (verdict !== null) {
    return Object.freeze({
      label: 'HISTORICAL',
      grade: verdict.grade,
      analysisStatus: verdict.analysisStatus,
      diagnosticCodes: NO_CODES,
      producingIdentity: verdict.scannerVersion,
    });
  }
  if (scan === null) return null;
  return Object.freeze({
    label: 'HISTORICAL',
    grade: scan.assessment === null ? null : scan.assessment.grade,
    analysisStatus: scan.analysisStatus,
    diagnosticCodes: scan.diagnosticCodes,
    producingIdentity: scan.identity.scannerVersion,
  });
}

/**
 * Plan one entry's derived artifacts from its retained evidence record, purely: no clock, no I/O, and
 * the same inputs always yield byte-identical frozen output.
 */
export function planV2EntryRegeneration(
  subject: V2RegenerationSubject,
  record: V2ScanEvidenceRecord,
): V2EntryRegenerationPlan {
  if (typeof subject?.id !== 'string' || subject.id.length === 0 || subject.id !== record.entryId) {
    throw new TypeError('v2 entry regeneration plan: the entry does not match the retained record.');
  }
  if (!FRESHNESS[record.scanFreshness]) {
    throw new TypeError(`v2 entry regeneration plan: unknown scan freshness "${String(record.scanFreshness)}".`);
  }

  const { state, stateReason } = deriveState(record, subject.readiness?.analysis === 'derived');
  // Digests travel only with the state whose receipt supports them; dated digests stay in the record.
  const current = state === 'CURRENT' ? record.scan : null;

  return Object.freeze({
    schemaVersion: V2_ENTRY_PLAN_SCHEMA_VERSION,
    entryId: record.entryId,
    state,
    stateReason,
    rightsClass: record.rightsClass,
    inventorySha256: record.inventorySha256,
    assessment: assessmentFor(state, record),
    bodySha256: current === null ? null : current.bodySha256,
    resultDigest: current === null ? null : current.resultDigest,
    receiptReasonCode: record.receiptReasonCode,
    artifacts: ARTIFACTS_PER_STATE[state],
  });
}
