import fs from 'node:fs';
import type { V2ScanIdentity } from '../../pipeline/scan/v2-corpus-adapter.js';
import type { PublicScanReceipt } from '../../pipeline/export/scan-provenance.js';

/**
 * Reads the retained v2 receipt sidecar the apply run wrote beside the candidate catalogue.
 *
 * The sidecar is the run's own evidence (`v2-scan-evidence-v1`), one JSON object per line. This
 * loader is deliberately strict about the facts admission depends on and ignores everything else:
 * a row is a receipt only if it has an entry id, a scan result with a full identity tuple, a body
 * digest and a result digest. Rows without a scan (missing input, owner ruling) contribute no
 * receipt, so their state is derived from the entry, never invented here.
 */
export type ReceiptSidecar = Readonly<{
  inventorySha256: string;
  receiptsByWorkflowId: Readonly<Record<string, PublicScanReceipt | undefined>>;
}>;

type SidecarScan = {
  entryId?: unknown;
  ok?: unknown;
  identity?: Partial<Record<keyof V2ScanIdentity, unknown>>;
  bodySha256?: unknown;
  resultDigest?: unknown;
  analysisStatus?: unknown;
};

type SidecarRecord = {
  entryId?: unknown;
  inventorySha256?: unknown;
  scan?: SidecarScan | null;
};

const IDENTITY_FIELDS: readonly (keyof V2ScanIdentity)[] = Object.freeze([
  'scannerVersion', 'engineBuildDigest', 'profileId', 'profileVersion', 'rulesetDigest', 'semanticsDigest', 'limitsDigest',
]);
const STATUSES: Record<string, true> = { COMPLETE: true, DEGRADED: true, INDETERMINATE: true };
const HASH = /^[0-9a-f]{64}$/;

function identityOf(value: SidecarScan['identity']): V2ScanIdentity | null {
  if (value === null || typeof value !== 'object') return null;
  for (const field of IDENTITY_FIELDS) if (typeof value[field] !== 'string' || value[field].length === 0) return null;
  return value as V2ScanIdentity;
}

export function readV2ScanReceipts(path: string): ReceiptSidecar {
  const text = fs.readFileSync(path, 'utf8');
  const receipts: Record<string, PublicScanReceipt> = {};
  let inventorySha256: string | null = null;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line) as SidecarRecord;
    if (typeof record.entryId !== 'string' || record.entryId.length === 0) {
      throw new Error(`v2 receipt sidecar ${path}: a record carries no entryId`);
    }
    if (typeof record.inventorySha256 !== 'string') {
      throw new Error(`v2 receipt sidecar ${path}: ${record.entryId} carries no inventory digest`);
    }
    if (inventorySha256 !== null && inventorySha256 !== record.inventorySha256) {
      throw new Error(`v2 receipt sidecar ${path}: records disagree on the inventory digest`);
    }
    inventorySha256 = record.inventorySha256;

    const scan = record.scan;
    if (scan === null || scan === undefined) continue;
    if (scan.entryId !== record.entryId) {
      throw new Error(`v2 receipt sidecar ${path}: scan entry ${String(scan.entryId)} is bound to record ${record.entryId}`);
    }
    const identity = identityOf(scan.identity);
    if (identity === null) throw new Error(`v2 receipt sidecar ${path}: ${record.entryId} carries an incomplete identity tuple`);
    if (typeof scan.bodySha256 !== 'string' || !HASH.test(scan.bodySha256)) {
      throw new Error(`v2 receipt sidecar ${path}: ${record.entryId} carries no valid body digest`);
    }
    if (typeof scan.analysisStatus !== 'string' || STATUSES[scan.analysisStatus] !== true) {
      throw new Error(`v2 receipt sidecar ${path}: ${record.entryId} carries an invalid analysis status`);
    }
    if (receipts[record.entryId] !== undefined) {
      throw new Error(`v2 receipt sidecar ${path}: duplicate receipt for ${record.entryId}`);
    }
    if (scan.ok === true) {
      if (typeof scan.resultDigest !== 'string' || !HASH.test(scan.resultDigest)) {
        throw new Error(`v2 receipt sidecar ${path}: ${record.entryId} claims a result without a valid digest`);
      }
      receipts[record.entryId] = {
        entryId: record.entryId,
        identity,
        outcome: 'RESULT',
        analysisStatus: scan.analysisStatus as PublicScanReceipt['analysisStatus'],
        bodySha256: scan.bodySha256,
        resultDigest: scan.resultDigest,
      };
    } else if (scan.ok === false && scan.resultDigest === null && scan.analysisStatus === 'INDETERMINATE') {
      receipts[record.entryId] = {
        entryId: record.entryId,
        identity,
        outcome: 'REFUSED',
        analysisStatus: 'INDETERMINATE',
        bodySha256: scan.bodySha256,
        resultDigest: null,
      };
    } else {
      throw new Error(`v2 receipt sidecar ${path}: ${record.entryId} carries an inconsistent scan outcome`);
    }
  }
  if (inventorySha256 === null) throw new Error(`v2 receipt sidecar ${path}: no records`);
  return Object.freeze({ inventorySha256, receiptsByWorkflowId: Object.freeze(receipts) });
}
