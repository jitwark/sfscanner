import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import {
  ENTRY_SECURITY_PROJECTION_VERSION,
  type V2RescanRecord,
  type V2ScanIdentity,
} from './v2-corpus-adapter.js';
import type { EntrySecurity } from '@hub/contracts';
import { isV2RescanRecordCacheEligible } from './v2-rescan-manifest.js';
import { type V2SourceReceipt, validateV2SourceReceipt } from './v2-source-receipt.js';

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export type V2FastForwardResult =
  | { kind: 'HIT'; security: EntrySecurity; record: V2RescanRecord }
  | { kind: 'MISS'; reason: string };

export type V2FastForwardReceiptContext = Readonly<{
  currentReceipt?: V2SourceReceipt | null;
  previousReceipt?: V2SourceReceipt | null;
  requireSourceReceipt?: boolean;
}>;
/**
 * Pure exact-byte and exact-authority cache fast-forward decision function.
 * Evaluates candidate input bytes, rights class, previous manifest record,
 * previous security summary, and current scanner authority.
 *
 * Any divergence, omission, tampering, or non-COMPLETE status returns a MISS
 * forcing the candidate to undergo fresh scanner execution.
 */
export function evaluateV2FastForward(
  candidateBytes: Uint8Array,
  entryId: string,
  rightsClass: V2RescanRecord['rightsClass'],
  previousRecord: V2RescanRecord | undefined,
  previousSecurity: EntrySecurity | undefined,
  currentIdentity: V2ScanIdentity,
  receiptContext?: V2FastForwardReceiptContext,
): V2FastForwardResult {
  if (!previousRecord) return { kind: 'MISS', reason: 'PREVIOUS_RECORD_MISSING' };
  if (!previousSecurity) return { kind: 'MISS', reason: 'PREVIOUS_SECURITY_MISSING' };
  if (previousRecord.entryId !== entryId) return { kind: 'MISS', reason: 'ENTRY_ID_MISMATCH' };
  if (previousRecord.rightsClass !== rightsClass) return { kind: 'MISS', reason: 'RIGHTS_CLASS_MISMATCH' };

  if (!isV2RescanRecordCacheEligible(previousRecord)) {
    if (!previousRecord.ok) return { kind: 'MISS', reason: 'PREVIOUS_RECORD_NOT_OK' };
    if (previousRecord.analysisStatus !== 'COMPLETE') return { kind: 'MISS', reason: 'PREVIOUS_ANALYSIS_NOT_COMPLETE' };
    if (previousRecord.securityProjectionVersion !== ENTRY_SECURITY_PROJECTION_VERSION) {
      return { kind: 'MISS', reason: 'PROJECTION_VERSION_MISMATCH' };
    }
    return { kind: 'MISS', reason: 'SECURITY_DIGEST_INVALID' };
  }

  // Compare every authority field:
  for (const field of [
    'scannerVersion',
    'engineBuildDigest',
    'profileId',
    'profileVersion',
    'rulesetDigest',
    'semanticsDigest',
    'limitsDigest',
  ] as const) {
    if (previousRecord[field] !== currentIdentity[field]) {
      return { kind: 'MISS', reason: `AUTHORITY_MISMATCH_${field.toUpperCase()}` };
    }
  }

  // Exact bytes SHA-256 match on original pre-sanitization bytes:
  const candidateDigest = sha256(candidateBytes);
  if (previousRecord.inputSha256 !== candidateDigest || previousRecord.sourceDigest !== candidateDigest) {
    return { kind: 'MISS', reason: 'INPUT_DIGEST_MISMATCH' };
  }

  // Verify that the loaded previous security object actually matches previousRecord.securitySha256:
  const securityDigest = sha256(canonicalizeJson(previousSecurity));
  if (securityDigest !== previousRecord.securitySha256) {
    return { kind: 'MISS', reason: 'SECURITY_PAYLOAD_TAMPERED' };
  }
  if (receiptContext !== undefined && receiptContext.requireSourceReceipt !== false) {
    if (!receiptContext.previousReceipt) {
      return { kind: 'MISS', reason: 'PREVIOUS_RECEIPT_MISSING' };
    }
    if (!receiptContext.currentReceipt) {
      return { kind: 'MISS', reason: 'CURRENT_RECEIPT_MISSING' };
    }
    try {
      validateV2SourceReceipt(receiptContext.previousReceipt);
    } catch {
      return { kind: 'MISS', reason: 'PREVIOUS_RECEIPT_INVALID' };
    }
    try {
      validateV2SourceReceipt(receiptContext.currentReceipt);
    } catch {
      return { kind: 'MISS', reason: 'CURRENT_RECEIPT_INVALID' };
    }
    if (receiptContext.previousReceipt.sourceBuildDigest !== receiptContext.currentReceipt.sourceBuildDigest) {
      return { kind: 'MISS', reason: 'SOURCE_BUILD_DIGEST_MISMATCH' };
    }
  }

  return { kind: 'HIT', security: previousSecurity, record: previousRecord };
}
