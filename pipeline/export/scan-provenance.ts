import type { Entry } from '@hub/contracts';
import type { PublicWorkflowScanEvidence } from '@hub/contracts/public-data-model';
import {
  isAdmittedV2ScanIdentity,
  type V2ScanIdentity,
} from '../scan/v2-corpus-adapter.js';

/**
 * An authentic scan receipt for one workflow: the entry it scanned, the full engine identity tuple,
 * the digest of the exact bytes it read, and the canonical result digest. The projection's
 * `bodySha256ByWorkflowId` is a different fact — the hash of a public sanitized pack — and is never
 * usable as a scan body digest.
 */
export type PublicScanReceipt = {
  entryId: string;
  identity: V2ScanIdentity;
  outcome: 'RESULT' | 'REFUSED';
  analysisStatus: 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE' | null;
  bodySha256: string;
  resultDigest: string | null;
};

export type ScanProvenanceOptions = {
  /** Receipts keyed by workflow id. A row absent here has no receipt: no digest, and not current. */
  scanReceiptsByWorkflowId?: Readonly<Record<string, PublicScanReceipt | undefined>>;
  /**
   * The identity tuple this export calls `CURRENT`, passed by the driver from
   * `ADMITTED_V2_SCAN_IDENTITY`. A tuple the admitted registry does not stand behind is refused
   * rather than trusted, and every receipt field must equal it exactly.
   */
  admittedIdentity?: V2ScanIdentity;
};

const HASH = /^[0-9a-f]{64}$/;
/** Stamps that mark "no scan produced this row's verdict"; they are not engine identities. */
const NO_SCAN_STAMPS: Record<string, true> = { unscanned: true, 'not-scanned': true };
const IDENTITY_FIELDS: readonly (keyof V2ScanIdentity)[] = Object.freeze([
  'scannerVersion', 'engineBuildDigest', 'profileId', 'profileVersion', 'rulesetDigest', 'semanticsDigest', 'limitsDigest',
]);

function receiptBinds(receipt: PublicScanReceipt, entryId: string, admitted: V2ScanIdentity): boolean {
  return receipt.entryId === entryId
    && receipt.analysisStatus !== null
    && HASH.test(receipt.bodySha256)
    && IDENTITY_FIELDS.every((field) => receipt.identity[field] === admitted[field]);
}

/** A native accepted result: the only receipt that may produce a CURRENT public row. */
function receiptCurrent(receipt: PublicScanReceipt): boolean {
  return receipt.outcome === 'RESULT' && receipt.resultDigest !== null && HASH.test(receipt.resultDigest);
}

/** A current-identity refusal: bytes read, no result, no grade, and never CURRENT or HISTORICAL. */
function receiptRefused(receipt: PublicScanReceipt): boolean {
  return receipt.outcome === 'REFUSED' && receipt.resultDigest === null && receipt.analysisStatus === 'INDETERMINATE';
}

/**
 * One row's scan state, decided from that row's own stored evidence in this precedence: an owner
 * ruling, then a current admitted scan, then a retained verdict, then nothing scanned. A title, a
 * URL, the release's own scanner identity and the redistribution rights answer other questions and
 * are never consulted. A grade is published only for a current scan or a retained verdict that
 * `scanFreshness` labels historical — never for an unscanned or owner-ruled row.
 *
 * Admission needs the full identity tuple, the receipt's entry id, the scanned body digest and the
 * result digest. A matching version string alone never makes a row current, and a partial tuple is
 * treated as no receipt at all.
 */
export function scanEvidence(entry: Entry, options: ScanProvenanceOptions): PublicWorkflowScanEvidence {
  const security = entry.security;
  if (security.stampReason === 'source_unavailable') {
    return { scannerVersion: null, analysisStatus: null, scanFreshness: 'SOURCE_UNAVAILABLE', scanBodySha256: null };
  }
  const receipt = options.scanReceiptsByWorkflowId?.[entry.id];
  const admitted = options.admittedIdentity;
  if (security.noResult === true
    && !(receipt !== undefined && admitted !== undefined && isAdmittedV2ScanIdentity(admitted) && receiptBinds(receipt, entry.id, admitted) && receiptRefused(receipt))) {
    throw new Error(`Scan provenance: ${entry.id} records an engine refusal without a bound refusal receipt.`);
  }
  if (receipt !== undefined && admitted !== undefined && isAdmittedV2ScanIdentity(admitted) && receiptBinds(receipt, entry.id, admitted)) {
    if (receiptCurrent(receipt) && entry.readiness?.analysis !== 'unscanned') {
      return {
        scannerVersion: receipt.identity.scannerVersion,
        analysisStatus: receipt.analysisStatus,
        scanFreshness: 'CURRENT',
        scanBodySha256: receipt.bodySha256,
      };
    }
    if (receiptRefused(receipt)) {
      return {
        scannerVersion: receipt.identity.scannerVersion,
        analysisStatus: 'INDETERMINATE',
        scanFreshness: 'NO_RESULT',
        scanBodySha256: receipt.bodySha256,
      };
    }
  }
  const retained = NO_SCAN_STAMPS[security.scannerVersion] !== true
    && (security.grade !== 'UNKNOWN' || security.analysisStatus !== undefined);
  if (retained) {
    return {
      scannerVersion: security.scannerVersion,
      analysisStatus: security.analysisStatus ?? null,
      scanFreshness: 'HISTORICAL',
      scanBodySha256: null,
    };
  }
  return { scannerVersion: null, analysisStatus: null, scanFreshness: 'UNSCANNED', scanBodySha256: null };
}
