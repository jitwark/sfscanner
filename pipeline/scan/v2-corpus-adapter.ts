import { createHash } from 'node:crypto';
import {
  DEFAULT_SCANNER_LIMITS_V2,
  type ScannerLimitsV2,
} from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import {
  scanWorkflowV2,
  type ScanWorkflowV2FailureCode,
  type ScanWorkflowV2Result,
} from '@hub/scanner-core/v2';
import type { EntrySecurity } from '@hub/contracts';
import { v2ResultToEntrySecurity } from './v2-security-summary.js';
import {
  ADMITTED_ENGINE_VERSION,
  ADMITTED_PROFILE_ID,
  ADMITTED_PROFILE_VERSION,
  BUILTIN_RULESET_AUTHORITY_V2,
  BUILTIN_SEMANTICS_AUTHORITY_V2,
  ENGINE_BUILD_DIGEST_V2,
} from '../../packages/scanner-core/src/v2/admitted-registry.js';

export const ENTRY_SECURITY_PROJECTION_VERSION = 'v2-entry-security-1' as const;
export { v2ResultToEntrySecurity } from './v2-security-summary.js';

export type V2RescanRecord = Readonly<{
  entryId: string; sourceDigest: string; inputSha256: string;
  scannerVersion: string; engineBuildDigest: string;
  profileId: string; profileVersion: string;
  rulesetDigest: string; semanticsDigest: string; limitsDigest: string;
  analysisStatus: 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE';
  resultDigest?: string; findingIds: readonly string[]; grade?: string;
  rightsClass: 'redistributable' | 'link_only' | 'excluded'; ok: boolean;
  securityProjectionVersion?: string; securitySha256?: string;
}>;
export type V2CorpusAdapterOptions = Readonly<{
  scan?: (request: unknown) => ScanWorkflowV2Result;
  limits?: ScannerLimitsV2;
}>;

export type V2Grade = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** The admitted identity tuple of `catalogue-scan-evidence`: every CURRENT row is compared against it. */
export type V2ScanIdentity = Readonly<{
  scannerVersion: string;
  engineBuildDigest: string;
  profileId: string;
  profileVersion: string;
  rulesetDigest: string;
  semanticsDigest: string;
  limitsDigest: string;
}>;

/**
 * What C2a requires a retention interface to keep: the identity tuple, the digest of the exact bytes
 * scanned, the canonical result digest, the analysis status with its diagnostic codes, and a null
 * assessment whenever the engine published none. Never a grade the engine did not produce.
 */
export type V2RetainedScanEvidence = Readonly<{
  entryId: string;
  rightsClass: V2RescanRecord['rightsClass'];
  ok: boolean;
  identity: V2ScanIdentity;
  bodySha256: string;
  resultDigest: string | null;
  analysisStatus: V2RescanRecord['analysisStatus'];
  assessment: Readonly<{ grade: V2Grade; score: number }> | null;
  diagnosticCodes: readonly string[];
  findingIds: readonly string[];
  /**
   * The canonical corpus security summary derived from this exact result. Findings and counts are
   * the engine's real output even when `assessment` is null; only grade/score fall back to the
   * `UNKNOWN`/`0` sentinel.
   */
  security: EntrySecurity;
  /** The engine's own closed refusal code when it produced one; null if the adapter aborted. */
  refusalCode: ScanWorkflowV2FailureCode | null;
}>;

const PROFILE = Object.freeze({ id: ADMITTED_PROFILE_ID, version: ADMITTED_PROFILE_VERSION });
const ADMITTED_AUTHORITY = Object.freeze({
  scannerVersion: ADMITTED_ENGINE_VERSION,
  engineBuildDigest: ENGINE_BUILD_DIGEST_V2,
  profileId: ADMITTED_PROFILE_ID,
  profileVersion: ADMITTED_PROFILE_VERSION,
  rulesetDigest: BUILTIN_RULESET_AUTHORITY_V2.digest,
  semanticsDigest: BUILTIN_SEMANTICS_AUTHORITY_V2.digest,
});
const RIGHTS: Record<V2RescanRecord['rightsClass'], true> = { redistributable: true, link_only: true, excluded: true };
const IDENTITY_FIELDS = Object.freeze(Object.keys(ADMITTED_AUTHORITY).concat('limitsDigest') as (keyof V2ScanIdentity)[]);

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export const ADMITTED_V2_SCAN_IDENTITY: V2ScanIdentity = Object.freeze({
  ...ADMITTED_AUTHORITY,
  limitsDigest: sha256(canonicalizeJson(DEFAULT_SCANNER_LIMITS_V2)),
});

/** True only for the tuple the admitted registry stands behind; a retired stamp never passes. */
export function isAdmittedV2ScanIdentity(identity: V2ScanIdentity): boolean {
  return IDENTITY_FIELDS.every((field) => identity[field] === ADMITTED_V2_SCAN_IDENTITY[field]);
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array) || Object.getPrototypeOf(bytes) !== Uint8Array.prototype) {
    throw new TypeError('Scanner input must be a Uint8Array.');
  }
  return Uint8Array.prototype.slice.call(bytes) as Uint8Array;
}

function findingIdsFromResult(result: Extract<ScanWorkflowV2Result, { ok: true }>['result']): readonly string[] {
  const maximum = result.limits.usage.find((item) => item.id === 'maxFindings')?.maximum ?? result.findings.length;
  const ids = [...new Set(result.findings.map((finding) => finding.findingId)
    .filter((id) => id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id)
      && !/(?:https?|ftp):\/\/|(?:password|secret|token|api[ _-]*key)\s*[:=]/i.test(id)))].sort(compareCanonicalStrings).slice(0, maximum);
  return Object.freeze(ids);
}

function diagnosticCodesFrom(result: Extract<ScanWorkflowV2Result, { ok: true }>['result']): readonly string[] {
  return Object.freeze([...new Set(result.analysis.diagnostics.map((diagnostic) => diagnostic.code))].sort(compareCanonicalStrings));
}

function validateArguments(entryId: string, rightsClass: V2RescanRecord['rightsClass']): void {
  if (typeof entryId !== 'string' || entryId.trim().length === 0 || entryId.includes('\0')) {
    throw new TypeError('Scanner entry identity is malformed.');
  }
  if (!RIGHTS[rightsClass]) throw new TypeError('Scanner rights class is malformed.');
}

/**
 * A refused or thrown scan is a truthful outcome, not a grade: it keeps the attempted identity and
 * the body digest, and reports INDETERMINATE with no result digest, no assessment and no codes.
 */
function refusedEvidence(
  entryId: string,
  inputSha256: string,
  rightsClass: V2RescanRecord['rightsClass'],
  limits: ScannerLimitsV2,
  refusalCode: ScanWorkflowV2FailureCode | null,
): V2RetainedScanEvidence {
  return Object.freeze({
    entryId,
    rightsClass,
    ok: false,
    identity: Object.freeze({ ...ADMITTED_AUTHORITY, limitsDigest: sha256(canonicalizeJson(limits)) }),
    bodySha256: inputSha256,
    resultDigest: null,
    analysisStatus: 'INDETERMINATE',
    assessment: null,
    diagnosticCodes: Object.freeze([]),
    findingIds: Object.freeze([]),
    refusalCode,
    security: Object.freeze({
      schemaVersion: 'scanner-result-v2' as const,
      grade: 'UNKNOWN' as const,
      score: 0,
      counts: Object.freeze({ critical: 0, high: 0, medium: 0, low: 0, info: 0 }),
      findings: [],
      hardenedExtra: 0,
      scannerVersion: ADMITTED_ENGINE_VERSION,
      profile: 'beta-default' as const,
      analysisStatus: 'INDETERMINATE' as const,
      ...(refusalCode === null ? {} : { noResult: true as const, noResultCode: refusalCode }),
    }),
  });
}

export function retainCorpusWorkflowV2Evidence(
  bytes: Uint8Array,
  entryId: string,
  rightsClass: V2RescanRecord['rightsClass'],
  options: V2CorpusAdapterOptions = {},
): V2RetainedScanEvidence {
  validateArguments(entryId, rightsClass);
  const input = copyBytes(bytes);
  const inputSha256 = sha256(input);
  const limits = options.limits ?? DEFAULT_SCANNER_LIMITS_V2;
  const request = Object.freeze({ bytes: input, profile: PROFILE, ...(options.limits === undefined ? {} : { limits }) });

  let outcome: ScanWorkflowV2Result;
  try {
    outcome = (options.scan ?? scanWorkflowV2)(request);
  } catch {
    return refusedEvidence(entryId, inputSha256, rightsClass, limits, null);
  }
  if (!outcome.ok) return refusedEvidence(entryId, inputSha256, rightsClass, limits, outcome.code);

  const result = outcome.result;
  return Object.freeze({
    entryId,
    rightsClass,
    ok: true,
    identity: Object.freeze({
      scannerVersion: result.engine.version,
      engineBuildDigest: result.engine.buildDigest,
      profileId: result.profile.id,
      profileVersion: result.profile.version,
      rulesetDigest: result.ruleset.digest,
      semanticsDigest: result.semantics.digest,
      limitsDigest: result.limits.digest,
    }),
    bodySha256: inputSha256,
    resultDigest: sha256(canonicalizeJson(result)),
    analysisStatus: result.analysis.status,
    assessment: result.assessment === null ? null : Object.freeze({ grade: result.assessment.grade, score: result.assessment.score }),
    diagnosticCodes: diagnosticCodesFrom(result),
    findingIds: findingIdsFromResult(result),
    security: v2ResultToEntrySecurity(result),
    refusalCode: null,
  });
}

/**
 * The existing summary boundary, unchanged for its current consumers. It is now the projection of
 * the retention above, so both paths report the same identity, statuses and digests.
 */
export function rescanRecordOfEvidence(evidence: V2RetainedScanEvidence): V2RescanRecord {
  return Object.freeze({
    entryId: evidence.entryId,
    sourceDigest: evidence.bodySha256,
    inputSha256: evidence.bodySha256,
    ...evidence.identity,
    analysisStatus: evidence.analysisStatus,
    ...(evidence.resultDigest === null ? {} : { resultDigest: evidence.resultDigest }),
    findingIds: evidence.findingIds,
    ...(evidence.assessment === null ? {} : { grade: evidence.assessment.grade }),
    rightsClass: evidence.rightsClass,
    ok: evidence.ok,
    securityProjectionVersion: ENTRY_SECURITY_PROJECTION_VERSION,
    securitySha256: sha256(canonicalizeJson(evidence.security)),
  });
}

export function scanCorpusWorkflowV2(
  bytes: Uint8Array,
  entryId: string,
  rightsClass: V2RescanRecord['rightsClass'],
  options: V2CorpusAdapterOptions = {},
): V2RescanRecord {
  return rescanRecordOfEvidence(retainCorpusWorkflowV2Evidence(bytes, entryId, rightsClass, options));
}
