import { DEFAULT_SCANNER_LIMITS_V2, type ScannerLimitsV2 } from '@hub/contracts';
import type { ScanWorkflowV2FailureCode, ScanWorkflowV2Result } from '@hub/scanner-core/v2';
import { ADMITTED_PROFILE_V2, loadExplicitConfig, type ConfigLoadResult, type ScanConfigV2 } from './config';
import { SCAN_CONFIG_V2_MAX_CONCURRENCY } from './contracts';
import { readInputBytes, type CliStdin, type InputReadHost, type ReadInputFailure, type ReadInputResult } from './input-read';
import type { SelectedInputV2 } from './input-selection';
import { runScanInWorker, type ScanWorkerFactory } from './scan-worker-host';
import { createSigintController, runHostedScan, type SigintSource, type WorkerHostRun } from './worker-host';

export type BatchErrorCodeV2 = ScanWorkflowV2FailureCode | 'INPUT_READ_FAILED' | 'WORKER_CRASH' | 'WORKER_RESOURCE_LIMIT';
export type BatchItemStatusV2 = 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT';
export type BatchItemV2 = Readonly<{ label: string; status: BatchItemStatusV2; result?: ScanWorkflowV2Result; error?: Readonly<{ code: BatchErrorCodeV2 }>; rawWorkflow?: unknown }>;
export type BatchResultV2 =
  | Readonly<{ ok: true; items: readonly BatchItemV2[]; cancelled: boolean; completed: number; failed: number; concurrency: number }>
  | Readonly<{ ok: false; code: 'INVALID_CONFIG' | 'CANCELLED'; message: string }>;
export type BatchScanOptionsV2 = Readonly<{ target?: unknown; limits?: ScannerLimitsV2; approvedDomains?: readonly string[]; advisoryRequest?: unknown }>;
export type BatchScanV2 = (bytes: Uint8Array, item: SelectedInputV2, options?: BatchScanOptionsV2) => ScanWorkflowV2Result | PromiseLike<ScanWorkflowV2Result>;
export type BatchReadV2 = (item: SelectedInputV2) => Uint8Array | ReadInputResult | PromiseLike<Uint8Array | ReadInputResult>;
export type BatchRunnerInput = Readonly<{ items: readonly SelectedInputV2[]; config: ScanConfigV2; scan?: BatchScanV2; read?: BatchReadV2; stdin?: CliStdin; readHost?: InputReadHost; baseDirectory?: string; maxInputBytes?: number; limitsDocument?: ScannerLimitsV2; targetDocument?: unknown; approvedDomains?: readonly string[]; scanWorker?: ScanWorkerFactory; timeoutMs?: number; signal?: AbortSignal; sigint?: SigintSource; now?: () => number; advisoryRequest?: unknown; includeReadiness?: boolean }>;

type NormalizedInput = Readonly<{ item: SelectedInputV2; invalid: boolean }>;
const failureCodes: Readonly<Record<string, true>> = Object.freeze({
  UTF8_DECODING_FAILED: true, INVALID_JSON: true, MALFORMED_WORKFLOW: true, WORKFLOW_TOO_LARGE: true, WORKFLOW_TOO_COMPLEX: true,
  INVALID_CONFIG: true, UNKNOWN_CONFIGURATION_KEY: true, PROFILE_NOT_ADMITTED: true, SEMANTIC_CATALOGUE_INVALID: true,
  SEMANTIC_CATALOGUE_AMBIGUOUS: true, RULE_PACK_INVALID: true, RULE_PACK_UNTRUSTED: true, TOOL_INVARIANT_FAILED: true,
  SERIALIZATION_FAILED: true, SCAN_TIMEOUT: true, SCAN_CANCELLED: true, INPUT_READ_FAILED: true, WORKER_CRASH: true, WORKER_RESOURCE_LIMIT: true,
});

export async function runBatchV2(input: BatchRunnerInput): Promise<BatchResultV2> {
  let loaded: ConfigLoadResult;
  try { loaded = loadExplicitConfig(input?.config); } catch { return invalidConfig(); }
  if (!loaded.ok || !Array.isArray(input?.items) || input.items.length === 0 || input.items.length > 100_000) return invalidConfig();
  const config = loaded.config;
  if (config.rules !== 'builtin' || config.catalogue !== 'builtin') return invalidConfig();
  if (config.limits !== 'builtin' && input.limitsDocument === undefined) return invalidConfig();
  const limitsDocument = input.limitsDocument;
  if (limitsDocument !== undefined && (
    !Number.isSafeInteger(limitsDocument.maxBytes) || limitsDocument.maxBytes < 0
    || !Number.isSafeInteger(limitsDocument.workerDeadlineMs) || limitsDocument.workerDeadlineMs < 0
  )) return invalidConfig();
  const maxBytes = input.maxInputBytes ?? limitsDocument?.maxBytes ?? DEFAULT_SCANNER_LIMITS_V2.maxBytes;
  const timeoutMs = input.timeoutMs ?? limitsDocument?.workerDeadlineMs ?? DEFAULT_SCANNER_LIMITS_V2.workerDeadlineMs;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) return invalidConfig();
  const normalized = normalizeItems(input.items);
  if (!normalized || (normalized.some(({ item }) => item.isStdin) && normalized.length > 1)) return invalidConfig();
  const ordered = [...normalized].sort((a, b) => compareItems(a.item, b.item));
  const sigint = input.sigint === undefined ? undefined : createSigintController(input.sigint);
  const combined = combineSignals(input.signal, sigint?.signal);
  const results = new Array<BatchItemV2 | undefined>(ordered.length);
  let next = 0;
  const concurrency = Math.min(config.concurrency ?? 1, SCAN_CONFIG_V2_MAX_CONCURRENCY, ordered.length);
  const scan = input.scan;
  const work = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= ordered.length) return;
      const current = ordered[index]!;
      results[index] = combined.signal?.aborted ? cancelled(current.item.label) : await scanOne(current, scan, input, config, maxBytes, timeoutMs, combined.signal, input.now ?? Date.now);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => work().catch(() => undefined)));
  for (let index = 0; index < results.length; index += 1) if (!results[index]) results[index] = failed(ordered[index]!.item.label, 'TOOL_INVARIANT_FAILED');
  combined.dispose(); sigint?.dispose();
  const items = Object.freeze(results.map((item) => Object.freeze(item ?? cancelled('input'))));
  const completed = items.filter(({ status }) => status === 'COMPLETED').length;
  const failedCount = items.filter(({ status }) => status !== 'COMPLETED' && status !== 'CANCELLED').length;
  return Object.freeze({ ok: true as const, items, cancelled: items.some(({ status }) => status === 'CANCELLED'), completed, failed: failedCount, concurrency });
}

async function scanOne(current: NormalizedInput, scan: BatchScanV2 | undefined, input: BatchRunnerInput, config: ScanConfigV2, maxBytes: number, timeoutMs: number, signal: AbortSignal | undefined, now: () => number): Promise<BatchItemV2> {
  if (current.invalid) return failed(current.item.label, 'INVALID_CONFIG');
  const deadline = timeoutMs === 0 ? now() : now() + timeoutMs;
  const remaining = (): number => Math.max(0, deadline - now());
  let read: Uint8Array | ReadInputFailure;
  let inputRun: WorkerHostRun<Uint8Array | ReadInputResult>;
  try {
    inputRun = await runHostedScan(
      () => input.read
        ? input.read(current.item)
        : readInputBytes(current.item, { stdin: input.stdin, maxBytes, baseDirectory: input.baseDirectory, host: input.readHost }),
      { signal, timeoutMs: remaining(), now },
    );
  } catch { return failed(current.item.label, 'INPUT_READ_FAILED'); }
  if (inputRun.status === 'CANCELLED') return cancelled(current.item.label);
  if (inputRun.status === 'TIMEOUT') return failed(current.item.label, 'SCAN_TIMEOUT');
  if (inputRun.status !== 'COMPLETED') return failed(current.item.label, 'INPUT_READ_FAILED');
  try {
    const value = inputRun.value;
    if (value instanceof Uint8Array) read = value;
    else if (value && typeof value === 'object' && value.ok === true && value.bytes instanceof Uint8Array) read = value.bytes;
    else if (value && typeof value === 'object' && value.ok === false) read = value as ReadInputFailure;
    else return failed(current.item.label, 'INPUT_READ_FAILED');
  } catch { return failed(current.item.label, 'INPUT_READ_FAILED'); }
  if (!(read instanceof Uint8Array)) return failed(current.item.label, safeReadCode(read.code));
  if (read.byteLength > maxBytes) return failed(current.item.label, 'WORKFLOW_TOO_LARGE');
  const rawWorkflow = input.includeReadiness === true ? parseRawWorkflow(read) : undefined;
  let completed: WorkerHostRun<ScanWorkflowV2Result>;
  if (scan !== undefined) {
    try {
      completed = await runHostedScan(() => scan(read, current.item, { target: input.targetDocument, limits: input.limitsDocument, approvedDomains: input.approvedDomains, advisoryRequest: input.advisoryRequest }), { signal, timeoutMs: remaining(), now });
    } catch { return failed(current.item.label, 'TOOL_INVARIANT_FAILED'); }
  } else {
    completed = await runScanInWorker<ScanWorkflowV2Result>(
      {
        bytes: read,
        profile: { id: ADMITTED_PROFILE_V2.id, version: ADMITTED_PROFILE_V2.version },
        ...(input.targetDocument === undefined ? {} : { target: input.targetDocument }),
        ...(input.limitsDocument === undefined ? {} : { limits: input.limitsDocument }),
        ...(input.approvedDomains === undefined ? {} : { approvedDomains: input.approvedDomains }),
        ...(input.advisoryRequest === undefined ? {} : { advisoryRequest: input.advisoryRequest }),
      },
      { signal, timeoutMs: remaining(), workerFactory: input.scanWorker, recordMemory: true },
    );
  }
  if (completed.status === 'CANCELLED') return cancelled(current.item.label);
  if (completed.status === 'TIMEOUT') return failed(current.item.label, 'SCAN_TIMEOUT');
  if (completed.status === 'CRASH') return failed(current.item.label, 'WORKER_CRASH');
  if (completed.status === 'RESOURCE_LIMIT') return failed(current.item.label, 'WORKER_RESOURCE_LIMIT');
  if (completed.status !== 'COMPLETED') return failed(current.item.label, 'TOOL_INVARIANT_FAILED');
  return toBatchItem(current.item.label, completed.value, config, rawWorkflow);
}

function toBatchItem(label: string, result: ScanWorkflowV2Result, config: ScanConfigV2, rawWorkflow: unknown): BatchItemV2 {
  try {
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') return failed(label, 'TOOL_INVARIANT_FAILED');
    if (!result.ok) return failed(label, safeScanCode(result.code));
    const profile = result.result && typeof result.result === 'object' ? result.result.profile : undefined;
    if (!profile || profile.id !== config.profile || profile.version !== ADMITTED_PROFILE_V2.version) return failed(label, 'TOOL_INVARIANT_FAILED');
    return Object.freeze({ label, status: 'COMPLETED' as const, result: freezeValue(result), ...(rawWorkflow === undefined ? {} : { rawWorkflow }) });
  } catch { return failed(label, 'TOOL_INVARIANT_FAILED'); }
}
/** Readiness is projected from the export the scan already admitted, so unreadable bytes simply leave the document absent. */
function parseRawWorkflow(bytes: Uint8Array): unknown {
  try { return freezeValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); } catch { return undefined; }
}
function normalizeItems(items: readonly SelectedInputV2[]): NormalizedInput[] | undefined {
  try {
    const output: NormalizedInput[] = [];
    for (const raw of items) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
      const value = raw as Record<string, unknown>;
      const names = Object.getOwnPropertyNames(value);
      const closed = Object.getOwnPropertySymbols(value).length === 0 && names.every((name) => { const descriptor = Object.getOwnPropertyDescriptor(value, name); return descriptor !== undefined && 'value' in descriptor; });
      const valid = closed && typeof value.label === 'string' && value.label.length > 0 && value.label.length <= 4096 && typeof value.isStdin === 'boolean' && (value.isStdin ? value.label === '-' && value.realPath === undefined : value.label !== '-') && (value.realPath === undefined || typeof value.realPath === 'string') && names.every((key) => key === 'label' || key === 'realPath' || key === 'isStdin') && !/[\u0000-\u001f\u007f]/.test(value.label) && !/^(?:[a-z][a-z\d+.-]*:|\/|[a-z]:|\\)|(?:^|[/\\])\.\.(?:[/\\]|$)/i.test(value.label);
      const item = valid ? Object.freeze({ label: value.label as string, ...(typeof value.realPath === 'string' ? { realPath: value.realPath } : {}), isStdin: value.isStdin as boolean }) : Object.freeze({ label: 'input', isStdin: false });
      output.push({ item, invalid: !valid });
    }
    return output;
  } catch { return undefined; }
}
function compareItems(a: SelectedInputV2, b: SelectedInputV2): number { return a.label < b.label ? -1 : a.label > b.label ? 1 : (a.realPath ?? '') < (b.realPath ?? '') ? -1 : (a.realPath ?? '') > (b.realPath ?? '') ? 1 : 0; }
function failed(label: string, code: BatchErrorCodeV2): BatchItemV2 { return Object.freeze({ label, status: code === 'SCAN_TIMEOUT' ? 'TIMEOUT' as const : 'FAILED' as const, error: Object.freeze({ code }) }); }
function cancelled(label: string): BatchItemV2 { return Object.freeze({ label, status: 'CANCELLED' as const, error: Object.freeze({ code: 'SCAN_CANCELLED' as const }) }); }
function safeScanCode(code: unknown): BatchErrorCodeV2 { return typeof code === 'string' && failureCodes[code] === true ? code as BatchErrorCodeV2 : 'TOOL_INVARIANT_FAILED'; }
function safeReadCode(code: unknown): BatchErrorCodeV2 { return code === 'WORKFLOW_TOO_LARGE' || code === 'INPUT_READ_FAILED' || code === 'INVALID_CONFIG' ? code : 'INPUT_READ_FAILED'; }
function invalidConfig(): BatchResultV2 { return Object.freeze({ ok: false as const, code: 'INVALID_CONFIG' as const, message: 'Configuration is invalid.' }); }
function combineSignals(first?: AbortSignal, second?: AbortSignal): { signal?: AbortSignal; dispose: () => void } {
  if (!first) return { signal: second, dispose: () => undefined };
  if (!second) return { signal: first, dispose: () => undefined };
  const controller = new AbortController(); const abort = (): void => controller.abort();
  if (first.aborted || second.aborted) controller.abort();
  first.addEventListener('abort', abort, { once: true }); second.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, dispose: (): void => { first.removeEventListener('abort', abort); second.removeEventListener('abort', abort); } };
}
function freezeValue<T>(value: T, seen = new WeakSet<object>()): T { if (value !== null && typeof value === 'object') { if (seen.has(value)) return value; seen.add(value); for (const key of Object.getOwnPropertyNames(value)) freezeValue((value as Record<string, unknown>)[key], seen); Object.freeze(value); } return value; }
