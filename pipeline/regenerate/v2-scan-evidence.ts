import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import type { CorpusV2InputInventory, CorpusV2InputReceipt, CorpusV2InputReceiptStatus } from '../../scripts/lib/corpus-v2-input-inventory.js';
import {
  isAdmittedV2ScanIdentity,
  retainCorpusWorkflowV2Evidence,
  type V2CorpusAdapterOptions,
  type V2Grade,
  type V2RescanRecord,
  type V2RetainedScanEvidence,
} from '../scan/v2-corpus-adapter.js';

export const V2_SCAN_EVIDENCE_SCHEMA_VERSION = 'v2-scan-evidence-v1' as const;

/** The five scan-freshness states, decided from the row's own evidence. */
export type ScanFreshness = 'CURRENT' | 'NO_RESULT' | 'HISTORICAL' | 'UNSCANNED' | 'SOURCE_UNAVAILABLE';

/** A row's own stored verdict from a retired identity. Never admitted, never rendered as current. */
export type V2RetainedVerdict = Readonly<{
  scannerVersion: string;
  grade: V2Grade | null;
  analysisStatus: V2RescanRecord['analysisStatus'] | null;
}>;

export type V2ScanEvidenceRecord = Readonly<{
  schemaVersion: typeof V2_SCAN_EVIDENCE_SCHEMA_VERSION;
  entryId: string;
  scanFreshness: ScanFreshness;
  rightsClass: V2RescanRecord['rightsClass'];
  /** The input inventory receipt this record was derived from; a different one makes it stale. */
  inventorySha256: string;
  /** The admitted scan receipt, or null when this row's bytes were never read. */
  scan: V2RetainedScanEvidence | null;
  /** Retained only while the row is HISTORICAL, so no state borrows a retired identity's authority. */
  retainedVerdict: V2RetainedVerdict | null;
  /** The inventory's own reason for a row it never scanned (e.g. `RULING-1`). */
  receiptReasonCode: string | null;
}>;

export type V2ScanEvidenceOptions = Readonly<{
  /** The corpus entry's rights posture. Required: a default here is how rights get silently wrong. */
  rightsClassOf: (entryId: string) => V2RescanRecord['rightsClass'];
  /** Reads a row's body. Called only for rows the inventory classified `AVAILABLE`. */
  readBytes: (entryId: string) => Uint8Array | undefined;
  retainedVerdictOf?: (entryId: string) => V2RetainedVerdict | undefined;
  scan?: V2CorpusAdapterOptions['scan'];
  limits?: V2CorpusAdapterOptions['limits'];
}>;

export const V2_SCAN_EVIDENCE_OPTION_KEYS = Object.freeze([
  'limits', 'readBytes', 'retainedVerdictOf', 'rightsClassOf', 'scan',
] as const);

const FRESHNESS: Record<ScanFreshness, true> = { CURRENT: true, NO_RESULT: true, HISTORICAL: true, UNSCANNED: true, SOURCE_UNAVAILABLE: true };
const RIGHTS: Record<V2RescanRecord['rightsClass'], true> = { redistributable: true, link_only: true, excluded: true };
const STATUSES: Record<CorpusV2InputReceiptStatus, true> = { AVAILABLE: true, MISSING: true, SOURCE_UNAVAILABLE: true, UNPARSEABLE: true, REJECTED: true };
const DIGEST = /^[0-9a-f]{64}$/;

function assertOptions(options: V2ScanEvidenceOptions): void {
  const unknown = Object.keys(options).filter((key) => !V2_SCAN_EVIDENCE_OPTION_KEYS.includes(key as typeof V2_SCAN_EVIDENCE_OPTION_KEYS[number]));
  // No option may relabel a state: the derivation is a function of the receipts alone.
  if (unknown.length > 0) throw new TypeError(`v2 scan evidence: unknown option(s): ${unknown.sort(compareCanonicalStrings).join(', ')}`);
  if (typeof options.rightsClassOf !== 'function' || typeof options.readBytes !== 'function') {
    throw new TypeError('v2 scan evidence: rightsClassOf and readBytes are required.');
  }
}

function assertInventory(inventory: CorpusV2InputInventory): void {
  if (inventory === null || typeof inventory !== 'object' || inventory.schemaVersion !== 'corpus-v2-input-inventory-v1') {
    throw new TypeError('v2 scan evidence: unsupported inventory schema version.');
  }
  if (typeof inventory.inventorySha256 !== 'string' || !DIGEST.test(inventory.inventorySha256)) {
    throw new TypeError('v2 scan evidence: inventory digest is malformed.');
  }
  if (!Array.isArray(inventory.rows)) throw new TypeError('v2 scan evidence: inventory rows are malformed.');
}

/**
 * The CURRENT predicate of the contract, re-derived from stored evidence and the live receipts:
 * an owner ruling wins first, then an admitted identity with an agreeing body digest, a matching
 * inventory digest and a result receipt. A stored label is never an input.
 */
export function classifyV2ScanFreshness(
  record: V2ScanEvidenceRecord,
  receipt: CorpusV2InputReceipt,
  inventorySha256: string,
): ScanFreshness {
  if (record.entryId !== receipt.entryId || record.inventorySha256 !== inventorySha256) {
    throw new TypeError(`v2 scan evidence: record for ${record.entryId} is bound to another entry or inventory.`);
  }
  if (receipt.status === 'SOURCE_UNAVAILABLE') return 'SOURCE_UNAVAILABLE';
  const scan = record.scan;
  if (scan !== null) {
    // One admission gate for live scans, replayed records and impostor labels: the full tuple, the
    // entry id and the inventory's own body digest. A stored `scanFreshness` is never consulted.
    if (!isAdmittedV2ScanIdentity(scan.identity)) {
      throw new TypeError(`v2 scan evidence: ${record.entryId} carries an unadmitted identity tuple.`);
    }
    if (scan.entryId !== record.entryId || !DIGEST.test(scan.bodySha256)) {
      throw new TypeError(`v2 scan evidence: ${record.entryId} carries a malformed scan identity or body digest.`);
    }
    if (receipt.status !== 'AVAILABLE' || receipt.bodySha256 === null || scan.bodySha256 !== receipt.bodySha256) {
      throw new TypeError(`v2 scan evidence: ${record.entryId} carries a body that is not the inventory's input.`);
    }
    if (scan.ok) {
      if (scan.resultDigest === null || !DIGEST.test(scan.resultDigest)) throw new TypeError(`v2 scan evidence: ${record.entryId} claims a result without a valid digest.`);
      return 'CURRENT';
    }
    if (scan.resultDigest !== null || scan.analysisStatus !== 'INDETERMINATE') {
      throw new TypeError(`v2 scan evidence: ${record.entryId} claims a result from a refused scan.`);
    }
    return 'NO_RESULT';
  }
  if (record.retainedVerdict !== null) return 'HISTORICAL';
  return 'UNSCANNED';
}

/**
 * Classifies every row the inventory gives it — no fixed corpus totals, no read for a row the
 * inventory did not mark `AVAILABLE`. Never fails to produce a record: an absent scan is a state.
 */
export function buildV2ScanEvidence(
  inventory: CorpusV2InputInventory,
  options: V2ScanEvidenceOptions,
): readonly V2ScanEvidenceRecord[] {
  assertOptions(options);
  assertInventory(inventory);
  const adapterOptions: V2CorpusAdapterOptions = Object.freeze({
    ...(options.scan === undefined ? {} : { scan: options.scan }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const bound = new Set<string>();

  const records = inventory.rows.map((receipt) => {
    if (!STATUSES[receipt.status]) throw new TypeError(`v2 scan evidence: unknown inventory status "${String(receipt.status)}".`);
    if (bound.has(receipt.entryId)) throw new TypeError(`v2 scan evidence: duplicate inventory entry: ${receipt.entryId}`);
    bound.add(receipt.entryId);

    const rightsClass = options.rightsClassOf(receipt.entryId);
    if (!RIGHTS[rightsClass]) throw new TypeError(`v2 scan evidence: unknown rights class for ${receipt.entryId}.`);
    const bytes = receipt.status === 'AVAILABLE' ? options.readBytes(receipt.entryId) : undefined;
    const retainedVerdict = options.retainedVerdictOf?.(receipt.entryId) ?? null;
    const draft: V2ScanEvidenceRecord = Object.freeze({
      schemaVersion: V2_SCAN_EVIDENCE_SCHEMA_VERSION,
      entryId: receipt.entryId,
      scanFreshness: 'UNSCANNED',
      rightsClass,
      inventorySha256: inventory.inventorySha256,
      scan: bytes === undefined ? null : retainCorpusWorkflowV2Evidence(bytes, receipt.entryId, rightsClass, adapterOptions),
      retainedVerdict,
      receiptReasonCode: receipt.reasonCode ?? null,
    });
    const scanFreshness = classifyV2ScanFreshness(draft, receipt, inventory.inventorySha256);
    if (!FRESHNESS[scanFreshness]) throw new TypeError(`v2 scan evidence: derived an unknown state for ${receipt.entryId}.`);
    return Object.freeze({
      ...draft,
      scanFreshness,
      retainedVerdict: scanFreshness === 'HISTORICAL' ? retainedVerdict : null,
    });
  }).sort((left, right) => compareCanonicalStrings(left.entryId, right.entryId));

  return Object.freeze(records);
}
