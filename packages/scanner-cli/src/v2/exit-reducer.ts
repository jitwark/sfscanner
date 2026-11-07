import type { BatchItemV2, BatchResultV2 } from './batch-runner';
import type { ScanSeverityV2 } from './contracts';

export type ExitReasonV2 = 'UNDER_THRESHOLD' | 'FINDING_THRESHOLD' | 'REQUIRE_COMPLETE' | 'ITEM_FAILURE' | 'USAGE' | 'INTERNAL' | 'CANCELLED';
export type ExitCodeV2 = 0 | 1 | 2 | 3 | 4 | 130;
export type ExitReductionV2 = Readonly<{ reason: ExitReasonV2; code: ExitCodeV2 }>;
export type ExitReducerOptionsV2 = Readonly<{ failOn?: ScanSeverityV2; requireComplete?: boolean; interrupted?: boolean; outputFailed?: boolean }>;
export type ExitReducerInputV2 = Readonly<{ batch: BatchResultV2; failOn?: ScanSeverityV2; requireComplete?: boolean; interrupted?: boolean; outputFailed?: boolean }>;

const EXITS: Readonly<Record<ExitReasonV2, ExitReductionV2>> = Object.freeze({
  UNDER_THRESHOLD: Object.freeze({ reason: 'UNDER_THRESHOLD', code: 0 }),
  FINDING_THRESHOLD: Object.freeze({ reason: 'FINDING_THRESHOLD', code: 1 }),
  REQUIRE_COMPLETE: Object.freeze({ reason: 'REQUIRE_COMPLETE', code: 1 }),
  ITEM_FAILURE: Object.freeze({ reason: 'ITEM_FAILURE', code: 3 }),
  USAGE: Object.freeze({ reason: 'USAGE', code: 2 }),
  INTERNAL: Object.freeze({ reason: 'INTERNAL', code: 4 }),
  CANCELLED: Object.freeze({ reason: 'CANCELLED', code: 130 }),
});
const SEVERITY: Readonly<Record<ScanSeverityV2, number>> = Object.freeze({ CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 });
const USAGE_CODES: Readonly<Record<string, true>> = Object.freeze({
  INVALID_CONFIG: true, UNKNOWN_CONFIGURATION_KEY: true, PROFILE_NOT_ADMITTED: true,
  SEMANTIC_CATALOGUE_INVALID: true, SEMANTIC_CATALOGUE_AMBIGUOUS: true, RULE_PACK_INVALID: true, RULE_PACK_UNTRUSTED: true,
});
const INTERNAL_CODES: Readonly<Record<string, true>> = Object.freeze({ TOOL_INVARIANT_FAILED: true, SERIALIZATION_FAILED: true, OUTPUT_WRITE_FAILED: true });

export function reduceExitV2(batch: BatchResultV2, options?: ExitReducerOptionsV2): ExitReductionV2;
export function reduceExitV2(input: ExitReducerInputV2): ExitReductionV2;
export function reduceExitV2(value: unknown, supplied?: ExitReducerOptionsV2): ExitReductionV2 {
  try { return reduceExitV2Unsafe(value, supplied); } catch { return EXITS.USAGE; }
}
function reduceExitV2Unsafe(value: unknown, supplied?: ExitReducerOptionsV2): ExitReductionV2 {
  const parsed = readInput(value, supplied);
  if (!parsed) return EXITS.USAGE;
  const { batch, options } = parsed;
  if (options.interrupted === true) return EXITS.CANCELLED;
  if (hasCancellation(value)) return EXITS.CANCELLED;
  if (options.outputFailed === true) return EXITS.INTERNAL;
  if (options.failOn !== undefined && !Object.prototype.hasOwnProperty.call(SEVERITY, options.failOn)) return EXITS.USAGE;
  if (options.requireComplete !== undefined && typeof options.requireComplete !== 'boolean') return EXITS.USAGE;

  if (!isRecord(batch) || typeof batch.ok !== 'boolean') return EXITS.USAGE;
  if (!batch.ok) {
    const code = typeof batch.code === 'string' ? batch.code : '';
    return code === 'CANCELLED' ? EXITS.CANCELLED : INTERNAL_CODES[code] ? EXITS.INTERNAL : EXITS.USAGE;
  }
  if (!Array.isArray(batch.items)) return EXITS.USAGE;

  let threshold = false;
  let degraded = false;
  let itemFailure = false;
  let usage = false;
  let internal = false;
  let cancelled = batch.cancelled === true;
  for (const item of batch.items) {
    if (!isRecord(item)) { usage = true; continue; }
    const status = item.status;
    if (status === 'CANCELLED') { cancelled = true; continue; }
    if (status !== 'COMPLETED' && status !== 'FAILED' && status !== 'TIMEOUT') { usage = true; continue; }
    const errorCode = readErrorCode(item);
    if (errorCode === 'SCAN_CANCELLED') { cancelled = true; continue; }
    if (INTERNAL_CODES[errorCode]) { internal = true; continue; }
    if (USAGE_CODES[errorCode]) { itemFailure = true; continue; }
    if (status !== 'COMPLETED') { itemFailure = true; continue; }
    const scan = isRecord(item.result) && item.result.ok === true && isRecord(item.result.result) ? item.result.result : undefined;
    if (!scan) { itemFailure = true; continue; }
    const analysis = isRecord(scan.analysis) ? scan.analysis : undefined;
    if (analysis?.status === 'INDETERMINATE') itemFailure = true;
    else if (analysis?.status === 'DEGRADED') degraded = true;
    else if (analysis?.status !== 'COMPLETE') itemFailure = true;
    if (Array.isArray(scan.findings)) {
      const failOn = options.failOn ?? 'INFO';
      const minimum = SEVERITY[failOn];
      for (const finding of scan.findings) {
        if (isRecord(finding) && typeof finding.severity === 'string' && SEVERITY[finding.severity as ScanSeverityV2] >= minimum) threshold = true;
      }
    }
  }
  if (cancelled) return EXITS.CANCELLED;
  if (internal) return EXITS.INTERNAL;
  if (usage) return EXITS.USAGE;
  if (threshold) return EXITS.FINDING_THRESHOLD;
  if (degraded && options.requireComplete === true) return EXITS.REQUIRE_COMPLETE;
  if (itemFailure) return EXITS.ITEM_FAILURE;
  return EXITS.UNDER_THRESHOLD;
}

function readInput(value: unknown, supplied?: ExitReducerOptionsV2): { batch: unknown; options: ExitReducerOptionsV2 } | undefined {
  if (isRecord(value) && 'batch' in value) {
    const input = value as Record<string, unknown>;
    return { batch: input.batch, options: { failOn: input.failOn as ScanSeverityV2 | undefined, requireComplete: input.requireComplete as boolean | undefined, interrupted: input.interrupted as boolean | undefined, outputFailed: input.outputFailed as boolean | undefined } };
  }
  return supplied === undefined || isRecord(supplied) ? { batch: value, options: supplied ?? {} } : undefined;
}
function readErrorCode(item: Record<string, unknown>): string { const error = item.error; return isRecord(error) && typeof error.code === 'string' ? error.code : ''; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hasCancellation(value: unknown): boolean {
  const candidate = isRecord(value) && 'batch' in value ? value.batch : value;
  if (!isRecord(candidate)) return false;
  if (candidate.ok === false && candidate.code === 'CANCELLED') return true;
  if (candidate.cancelled === true) return true;
  return Array.isArray(candidate.items) && candidate.items.some((item) => isRecord(item) && (item.status === 'CANCELLED' || isRecord(item.error) && item.error.code === 'SCAN_CANCELLED'));
}
