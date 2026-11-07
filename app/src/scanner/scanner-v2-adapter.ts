import { validateScannerResultV2, type ScannerResultV2 } from '@hub/contracts/scanner-v2-result';
import { DEFAULT_SCANNER_LIMITS } from '@hub/contracts';
import { exceedsWorkflowByteLimit } from './scanner-input-validation';
import type { ScanWorkerRequest, ScanWorkerResponse } from './scan.worker';

export type BrowserScanRequestV2 = Readonly<{
  json: string;
  profile: 'beta-default';
  approvedDomains: readonly string[];
  signal?: AbortSignal;
  deadlineMs?: number;
  onProgress?: (phase: 'parse' | 'analyse' | 'render', pct: number) => void;
}>;

export type BrowserScanOutcomeV2 =
  | Readonly<{ ok: true; result: ScannerResultV2 }>
  | Readonly<{ ok: false; code: string; message: string }>;

type Resolve = (outcome: BrowserScanOutcomeV2) => void;
type PlainRecord = Record<string, unknown>;

const V2_FAILURE_CODES = [
  'UTF8_DECODING_FAILED', 'INVALID_JSON', 'MALFORMED_WORKFLOW', 'WORKFLOW_TOO_LARGE', 'WORKFLOW_TOO_COMPLEX',
  'INVALID_CONFIG', 'UNKNOWN_CONFIGURATION_KEY', 'PROFILE_NOT_ADMITTED', 'SEMANTIC_CATALOGUE_INVALID',
  'SEMANTIC_CATALOGUE_AMBIGUOUS', 'RULE_PACK_INVALID', 'RULE_PACK_UNTRUSTED', 'TOOL_INVARIANT_FAILED',
  'SERIALIZATION_FAILED', 'SCAN_TIMEOUT', 'SCAN_CANCELLED', 'INTERNAL',
] as const;

let workerInstance: Worker | null = null;
let activeId: string | null = null;
let activeResolve: Resolve | null = null;
let activeProgress: BrowserScanRequestV2['onProgress'] | null = null;
let activeAbortCleanup: (() => void) | null = null;
let activeDeadlineCleanup: (() => void) | null = null;
let lastProgress = -1;
let sequence = 0;
let workerStartupFailure: string | null = null;

function failure(code: string, message: string): BrowserScanOutcomeV2 {
  return Object.freeze({ ok: false as const, code, message });
}

function plainRecord(value: unknown): PlainRecord | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
    }
    return value as PlainRecord;
  } catch {
    return undefined;
  }
}

function closedRecord(value: PlainRecord, keys: readonly string[], required: readonly string[]): boolean {
  const names = Object.getOwnPropertyNames(value);
  return names.every((name) => keys.includes(name)) && required.every((name) => names.includes(name));
}

function parseWorkerResponse(value: unknown): Extract<ScanWorkerResponse, { kind: 'progress' | 'result-v2' | 'error-v2' }> | undefined {
  const record = plainRecord(value);
  if (!record || typeof record.kind !== 'string' || typeof record.id !== 'string') return undefined;
  if (record.kind === 'progress') {
    if (!closedRecord(record, ['kind', 'id', 'phase', 'pct'], ['kind', 'id', 'phase', 'pct'])
      || !['parse', 'analyse', 'render'].includes(record.phase as string)
      || typeof record.pct !== 'number' || !Number.isFinite(record.pct)) return undefined;
    return record as unknown as Extract<ScanWorkerResponse, { kind: 'progress' }>;
  }
  if (record.kind === 'result-v2') {
    if (!closedRecord(record, ['kind', 'id', 'result'], ['kind', 'id', 'result'])) return undefined;
    return record as unknown as Extract<ScanWorkerResponse, { kind: 'result-v2' }>;
  }
  if (record.kind === 'error-v2') {
    if (!closedRecord(record, ['kind', 'id', 'code', 'message'], ['kind', 'id', 'code', 'message'])
      || typeof record.code !== 'string'
      || !(V2_FAILURE_CODES as readonly string[]).includes(record.code)
      || typeof record.message !== 'string') return undefined;
    return record as unknown as Extract<ScanWorkerResponse, { kind: 'error-v2' }>;
  }
  return undefined;
}
function cleanup(): void {
  activeAbortCleanup?.();
  activeDeadlineCleanup?.();
  activeId = null;
  activeResolve = null;
  activeProgress = null;
  activeAbortCleanup = null;
  activeDeadlineCleanup = null;
  lastProgress = -1;
}

function terminateActive(): void {
  workerInstance?.terminate();
  workerInstance = null;
  cleanup();
}

function cancelActive(): void {
  const resolve = activeResolve;
  if (!resolve) return;
  terminateActive();
  resolve(failure('SCAN_CANCELLED', 'Scan was cancelled.'));
}

function timeoutActive(id: string, deadlineMs: number): void {
  if (id !== activeId || !activeResolve) return;
  const resolve = activeResolve;
  terminateActive();
  resolve(failure('TIMEOUT', `Scan exceeded the ${deadlineMs}ms worker deadline.`));
}

function workerFailure(source: Worker, message: string): void {
  if (source !== workerInstance) return;
  const resolve = activeResolve;
  terminateActive();
  if (resolve) resolve(failure('INTERNAL', message));
  else workerStartupFailure = message;
}

function handleMessage(source: Worker, event: MessageEvent<ScanWorkerResponse>): void {
  if (source !== workerInstance || !activeId) return;
  const message = parseWorkerResponse(event.data);
  if (!message) {
    workerFailure(source, 'Scanner worker returned an invalid v2 response.');
    return;
  }
  if (message.id !== activeId) return;
  if (message.kind === 'progress') {
    if (message.pct < 0 || message.pct > 100 || message.pct < lastProgress) return;
    lastProgress = message.pct;
    activeProgress?.(message.phase, message.pct);
    return;
  }

  const resolve = activeResolve;
  if (!resolve) return;
  cleanup();
  if (message.kind === 'result-v2') {
    const checked = validateScannerResultV2(message.result);
    if (!checked.ok) {
      source.terminate();
      workerInstance = null;
      resolve(failure('INVALID_RESULT', 'Scanner worker returned a malformed v2 result.'));
      return;
    }
    resolve(Object.freeze({ ok: true as const, result: checked.result }));
    return;
  }
  resolve(failure(message.code, `Scanner v2 worker rejected the scan (${message.code}).`));
}

function getWorker(): Worker {
  if (workerInstance) return workerInstance;
  const worker = new Worker(new URL('./scan.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => handleMessage(worker, event);
  worker.onerror = () => workerFailure(worker, 'Scanner worker failed.');
  worker.onmessageerror = () => workerFailure(worker, 'Scanner worker response could not be read.');
  workerInstance = worker;
  return worker;
}

export function prepareBrowserScanV2(): void {
  if (workerInstance || workerStartupFailure) return;
  try {
    getWorker();
  } catch {
    workerStartupFailure = 'Scanner worker failed to start.';
  }
}

export function runBrowserScanV2(request: BrowserScanRequestV2): Promise<BrowserScanOutcomeV2> {
  // Before the abort check, `cancelActive()`, and `postMessage`: a request that
  // cannot be scanned must not cancel a live run or be structured-cloned.
  if (exceedsWorkflowByteLimit(request.json)) {
    return Promise.resolve(failure('WORKFLOW_TOO_LARGE', `Workflow JSON exceeds the ${DEFAULT_SCANNER_LIMITS.maxBytes}-byte payload limit.`));
  }
  if (request.signal?.aborted) return Promise.resolve(failure('SCAN_CANCELLED', 'Scan was cancelled.'));
  if (workerStartupFailure) {
    const message = workerStartupFailure;
    workerStartupFailure = null;
    return Promise.resolve(failure('INTERNAL', message));
  }
  cancelActive();
  const id = `browser-v2-${++sequence}`;
  activeId = id;
  activeProgress = request.onProgress ?? null;

  return new Promise<BrowserScanOutcomeV2>((resolve) => {
    activeResolve = resolve;
    const signal = request.signal;
    if (signal) {
      const onAbort = (): void => {
        if (id === activeId) cancelActive();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      activeAbortCleanup = () => signal.removeEventListener('abort', onAbort);
    }
    if (request.deadlineMs !== undefined) {
      const timer = setTimeout(() => timeoutActive(id, request.deadlineMs!), request.deadlineMs);
      activeDeadlineCleanup = () => clearTimeout(timer);
    }
    try {
      const message: ScanWorkerRequest = {
        kind: 'scan-v2',
        id,
        json: request.json,
        profile: request.profile,
        ...(request.approvedDomains.length > 0 ? { approvedDomains: [...request.approvedDomains] } : {}),
      };
      getWorker().postMessage(message);
    } catch {
      const currentWorker = workerInstance;
      if (currentWorker) workerFailure(currentWorker, 'Scanner worker failed to start.');
      else {
        cleanup();
        resolve(failure('INTERNAL', 'Scanner worker failed to start.'));
      }
    }
  });
}
