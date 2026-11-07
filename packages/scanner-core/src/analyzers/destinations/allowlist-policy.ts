import type { DestinationInventoryRecord, DestinationInventoryResult } from './inventory';
export type { DestinationInventoryRecord } from './inventory';

export type DestinationComplianceStatus = 'APPROVED' | 'REJECTED' | 'UNKNOWN' | 'DISABLED';
export type DestinationComplianceDecision = Readonly<{
  nodeIdentity: string; parameterPath: string; status: DestinationComplianceStatus;
}>;
export type AllowlistComplianceError = Readonly<{
  code: 'INVALID_ALLOWLIST' | 'UNKNOWN_AUTHORITY' | 'INVENTORY_INCOMPLETE' | 'UNSAFE_INPUT';
  nodeIdentity: string | null; parameterPath: string | null;
}>;
export type AllowlistComplianceResult = Readonly<{
  status: 'CLEAN' | 'NON_COMPLIANT' | 'UNKNOWN' | 'DISABLED' | 'UNSAFE_INPUT';
  decisions: readonly DestinationComplianceDecision[];
  errors: readonly AllowlistComplianceError[];
  counters: Readonly<{ recordsExamined: number; approved: number; rejected: number; unknown: number }>;
}>;
export type DestinationAllowlistInput = readonly DestinationInventoryRecord[] | DestinationInventoryResult;

type MutableCounters = { recordsExamined: number; approved: number; rejected: number; unknown: number };
const RECORD_KEYS = ['nodeIdentity', 'parameterPath', 'scheme', 'hostname', 'authorityState', 'valueMode', 'evidence', 'reason', 'omitted', 'inventoryStatus'];

export function evaluateDestinationAllowlist(input: DestinationAllowlistInput, approvedDomains?: readonly string[]): AllowlistComplianceResult {
  const records = readRecords(input);
  if (records === undefined) return finish('UNSAFE_INPUT', [], [{ code: 'UNSAFE_INPUT', nodeIdentity: null, parameterPath: null }], emptyCounters());
  if (approvedDomains === undefined) return finish('DISABLED', records.map((record) => decision(record, 'DISABLED')), [], counters(records.length, 0, 0, 0));
  if (!Array.isArray(approvedDomains) || !denseArray(approvedDomains) || !approvedDomains.every((domain) => typeof domain === 'string')) return finish('UNSAFE_INPUT', [], [{ code: 'INVALID_ALLOWLIST', nodeIdentity: null, parameterPath: null }], emptyCounters());
  if (approvedDomains.length === 0) return finish('DISABLED', records.map((record) => decision(record, 'DISABLED')), [], counters(records.length, 0, 0, 0));
  const allowed = new Set<string>();
  for (const domain of approvedDomains) {
    const canonical = canonicalHost(domain);
    if (canonical === undefined) return finish('UNSAFE_INPUT', [], [{ code: 'INVALID_ALLOWLIST', nodeIdentity: null, parameterPath: null }], emptyCounters());
    allowed.add(canonical);
  }
  const output: DestinationComplianceDecision[] = []; const errors: AllowlistComplianceError[] = []; const counts = emptyCounters();
  const inventory = Array.isArray(input) ? undefined : input as DestinationInventoryResult;
  const incomplete = inventory !== undefined && inventory.status !== 'COMPLETE';
  if (incomplete) errors.push({ code: 'INVENTORY_INCOMPLETE', nodeIdentity: null, parameterPath: null });
  for (const record of records) {
    counts.recordsExamined += 1;
    if (record.authorityState !== 'KNOWN' || record.hostname === null || record.valueMode === 'UNKNOWN') {
      output.push(decision(record, 'UNKNOWN')); counts.unknown += 1; errors.push({ code: 'UNKNOWN_AUTHORITY', nodeIdentity: record.nodeIdentity, parameterPath: record.parameterPath }); continue;
    }
    const hostname = canonicalHost(record.hostname);
    if (hostname === undefined) { output.push(decision(record, 'UNKNOWN')); counts.unknown += 1; errors.push({ code: 'UNKNOWN_AUTHORITY', nodeIdentity: record.nodeIdentity, parameterPath: record.parameterPath }); continue; }
    const state = allowed.has(hostname) ? 'APPROVED' : 'REJECTED'; output.push(decision(record, state)); const counter: 'approved' | 'rejected' = state === 'APPROVED' ? 'approved' : 'rejected'; counts[counter] += 1;
  }
  const status = counts.rejected > 0 ? 'NON_COMPLIANT' : incomplete || counts.unknown > 0 ? 'UNKNOWN' : 'CLEAN';
  return finish(status, output, errors, counts);
}

export const evaluateAllowlistCompliance = evaluateDestinationAllowlist;

function readRecords(input: DestinationAllowlistInput): readonly DestinationInventoryRecord[] | undefined {
  if (Array.isArray(input)) return denseArray(input) && input.every(safeRecord) ? input : undefined;
  if (!plainFrozen(input) || !['status', 'records', 'counters', 'errors'].every((key) => Object.prototype.hasOwnProperty.call(input, key)) || !denseArray(input.records) || !input.records.every(safeRecord)) return undefined;
  return input.records;
}
function safeRecord(value: unknown): value is DestinationInventoryRecord {
  if (!plainFrozen(value) || Object.getOwnPropertyNames(value).some((key) => !RECORD_KEYS.includes(key)) || RECORD_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false;
  const record = value as DestinationInventoryRecord;
  return typeof record.nodeIdentity === 'string' && typeof record.parameterPath === 'string' && ['HTTP', 'HTTPS', 'UNKNOWN'].includes(record.scheme)
    && (record.hostname === null || typeof record.hostname === 'string') && ['KNOWN', 'UNKNOWN'].includes(record.authorityState)
    && ['LITERAL', 'DYNAMIC', 'UNKNOWN'].includes(record.valueMode) && ['OBSERVED', 'MISSING_PATH', 'MALFORMED_PATH'].includes(record.evidence)
    && ['NONE', 'DYNAMIC', 'UNSUPPORTED', 'OVERSIZED', 'MISSING_PATH', 'MALFORMED_PATH'].includes(record.reason)
    && Number.isSafeInteger(record.omitted) && record.omitted >= 0
    && ['COMPLETE', 'UNKNOWN', 'LIMIT_EXCEEDED', 'UNSAFE_INPUT'].includes(record.inventoryStatus);
}
function canonicalHost(value: string): string | undefined {
  if (value.length === 0 || value !== value.trim() || /[/:?#@\s]/.test(value)) return undefined;
  try { const url = new URL(`http://${value}`); if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return undefined; return url.hostname.toLowerCase().replace(/\.$/, '') || undefined; } catch { return undefined; }
}
function decision(record: DestinationInventoryRecord, status: DestinationComplianceStatus): DestinationComplianceDecision { return Object.freeze({ nodeIdentity: record.nodeIdentity, parameterPath: record.parameterPath, status }); }
function counters(recordsExamined: number, approved: number, rejected: number, unknown: number): MutableCounters { return { recordsExamined, approved, rejected, unknown }; }
function emptyCounters(): MutableCounters { return counters(0, 0, 0, 0); }
function finish(status: AllowlistComplianceResult['status'], decisions: readonly DestinationComplianceDecision[], errors: readonly AllowlistComplianceError[], counts: MutableCounters): AllowlistComplianceResult { return Object.freeze({ status, decisions: Object.freeze([...decisions]), errors: Object.freeze(errors.map((error) => Object.freeze({ ...error }))), counters: Object.freeze({ ...counts }) }); }
function plainFrozen(value: unknown): value is Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) return false; return Object.getOwnPropertyNames(value).every((name) => { const descriptor = Object.getOwnPropertyDescriptor(value, name); return descriptor !== undefined && 'value' in descriptor; }); }
function denseArray(value: unknown): value is readonly unknown[] { if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false; return Object.getOwnPropertyNames(value).length === value.length + 1 && Object.getOwnPropertyNames(value).every((name) => { if (name === 'length') return true; const descriptor = Object.getOwnPropertyDescriptor(value, name); return /^(0|[1-9]\d*)$/.test(name) && descriptor !== undefined && 'value' in descriptor; }); }
