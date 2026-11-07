import { DEFAULT_SCANNER_LIMITS } from '@hub/contracts';
import type { ScanErrorCode, ScanErrorDetails, ScanWorkerResponse } from './scan.worker';
import type { ScanWorkflowResult } from './engine';
import { parseScanWorkflowResult } from './scan-result-validation';
import { runBrowserScanV2, type BrowserScanRequestV2 } from './scanner-v2-adapter';
import { toScannerReportModelV2 } from './scanner-v2-presentation';
export class ScanError extends Error {
  constructor(
    public code: ScanErrorCode | 'V2_FAILURE' | 'V2_TOO_COMPLEX',
    message: string,
    public details?: ScanErrorDetails,
  ) {
    super(message);
    this.name = 'ScanError';
  }
}
export type ScanRunOptions = {
  json: string;
  profile?: 'beta-default' | 'beta-hardened';
  /** Hostnames the workflow is expected to contact. Anything else is reported. */
  approvedDomains?: string[];
  onProgress?: (phase: 'parse' | 'analyse' | 'render', pct: number) => void;
  signal?: AbortSignal;
  /** Overrides `DEFAULT_SCANNER_LIMITS.workerDeadlineMs`. Test-only in practice. */
  deadlineMs?: number;
  /** Stable host-only worker correlation for deterministic fixtures. Never enters the scan result. */
  seedId?: string;
  /** Optional host-only correlation ID factory; production uses a unique timestamp/counter ID. */
  idFactory?: (seedId?: string) => string;
};
let workerInstance: Worker | null = null;
let activeScanId: string | null = null;
let activeScanResolve: ((value: ScanWorkflowResult | 'cancelled') => void) | null = null;
let activeScanReject: ((reason?: unknown) => void) | null = null;
let activeOnProgress: ((phase: 'parse' | 'analyse' | 'render', pct: number) => void) | null = null;
let activeAbortCleanup: (() => void) | null = null;
let activeDeadlineCleanup: (() => void) | null = null;
let activeLastProgressPct = -1;
let scanIdCounter = 0;
function getOrCreateWorker(): Worker {
  if (workerInstance) return workerInstance;
  const worker = new Worker(new URL('./scan.worker.ts', import.meta.url), { type: 'module' });
  workerInstance = worker;
  worker.onmessage = (event) => handleWorkerMessage(worker, event);
  worker.onerror = () => failWorker(worker, 'Scanner worker failed.');
  worker.onmessageerror = () => failWorker(worker, 'Scanner worker response could not be read.');
  return worker;
}

function failWorker(source: Worker | null, message: string): void {
  if (source !== workerInstance) return;
  const reject = activeScanReject;
  workerInstance?.terminate();
  workerInstance = null;
  cleanupActiveScan();
  reject?.(new ScanError('INTERNAL', message));
}

function handleWorkerMessage(source: Worker, event: MessageEvent<ScanWorkerResponse>): void {
  if (source !== workerInstance) return;
  const msg = event.data;
  if (!msg || !activeScanId || msg.id !== activeScanId) {
    return; // Discard late or mismatched messages
  }

  if (msg.kind === 'progress') {
    if (msg.pct < activeLastProgressPct) return; // Never let a progress message move the bar backward.
    activeLastProgressPct = msg.pct;
    activeOnProgress?.(msg.phase, msg.pct);
    return;
  }

  const resolve = activeScanResolve;
  const reject = activeScanReject;
  cleanupActiveScan();

  if (msg.kind === 'result') {
    const result = parseScanWorkflowResult(msg.result);
    if (!result) {
      source.terminate();
      workerInstance = null;
      reject?.(new ScanError('INTERNAL', 'Scanner worker returned a malformed result.'));
      return;
    }
    resolve?.(result);
  } else if (msg.kind === 'error') {
    reject?.(new ScanError(msg.code, msg.message, msg.details));
  } else {
    source.terminate();
    workerInstance = null;
    reject?.(new ScanError('INTERNAL', 'Scanner worker returned an invalid response.'));
  }
}

function cleanupActiveScan(): void {
  activeAbortCleanup?.();
  activeDeadlineCleanup?.();
  activeScanId = activeScanResolve = activeScanReject = null;
  activeOnProgress = activeAbortCleanup = activeDeadlineCleanup = null;
  activeLastProgressPct = -1;
}

function timeoutScan(id: string, deadlineMs: number): void {
  if (id !== activeScanId) return;
  const reject = activeScanReject;
  workerInstance?.terminate();
  workerInstance = null;
  cleanupActiveScan();
  reject?.(new ScanError('TIMEOUT', `Scan exceeded the ${deadlineMs}ms worker deadline.`));
}

export function cancelScan(id?: string): void {
  if (id && activeScanId && id !== activeScanId) {
    return; // Ignore cancel for non-active scan ID
  }

  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
  }

  if (activeScanResolve) {
    const resolve = activeScanResolve;
    cleanupActiveScan();
    resolve('cancelled');
  } else {
    cleanupActiveScan();
  }
}
export function runScan(options: ScanRunOptions): Promise<ScanWorkflowResult | 'cancelled'> {
  if (options.signal?.aborted) {
    return Promise.resolve('cancelled');
  }

  if (activeScanId) {
    cancelScan(activeScanId);
  }

  // This ID only correlates worker messages. Seeded IDs make fixtures repeatable;
  // the production timestamp and counter keep unrelated browser scans unique.
  const scanId = options.idFactory
    ? options.idFactory(options.seedId)
    : options.seedId !== undefined
      ? `scan_seed_${options.seedId}`
      : `scan_${Date.now()}_${++scanIdCounter}`;
  activeScanId = scanId;
  activeOnProgress = options.onProgress ?? null;

  return new Promise<ScanWorkflowResult | 'cancelled'>((resolve, reject) => {
    activeScanResolve = resolve;
    activeScanReject = reject;

    if (options.signal) {
      const signal = options.signal;
      const onAbort = () => cancelScan(scanId);
      activeAbortCleanup = () => signal.removeEventListener('abort', onAbort);
      options.signal.addEventListener(
        'abort',
        onAbort,
        { once: true },
      );
    }

    const deadlineMs = options.deadlineMs ?? DEFAULT_SCANNER_LIMITS.workerDeadlineMs;
    const deadlineTimer = setTimeout(() => timeoutScan(scanId, deadlineMs), deadlineMs);
    activeDeadlineCleanup = () => clearTimeout(deadlineTimer);

    try {
      const worker = getOrCreateWorker();
      worker.postMessage({
        kind: 'scan',
        id: scanId,
        json: options.json,
        profile: options.profile ?? 'beta-default',
        ...(options.approvedDomains && options.approvedDomains.length > 0
          ? { approvedDomains: options.approvedDomains }
          : {}),
      });
    } catch (err) {
      failWorker(workerInstance, err instanceof Error ? err.message : 'Failed to post message to worker.');
    }
  });
}
function mapV2ErrorCode(code: string): ScanError['code'] {
  switch (code) {
    case 'WORKFLOW_TOO_LARGE':
      return 'TOO_LARGE';
    case 'INVALID_JSON':
      return 'INVALID_JSON';
    case 'MALFORMED_WORKFLOW':
      return 'NOT_A_WORKFLOW';
    case 'WORKFLOW_TOO_COMPLEX':
      return 'V2_TOO_COMPLEX';
    case 'SCAN_TIMEOUT':
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'INTERNAL':
    case 'INVALID_RESULT':
      return 'INTERNAL';
    default:
      return 'V2_FAILURE';
  }
}

export function runScanV2(options: BrowserScanRequestV2): Promise<ScanWorkflowResult | 'cancelled'> {
  if (options.signal?.aborted) return Promise.resolve('cancelled');

  return runBrowserScanV2({
    ...options,
    deadlineMs: options.deadlineMs ?? DEFAULT_SCANNER_LIMITS.workerDeadlineMs,
  }).then((outcome) => {
    if (outcome.ok) return toScannerReportModelV2(outcome.result);
    if (outcome.code === 'SCAN_CANCELLED') return 'cancelled';
    throw new ScanError(mapV2ErrorCode(outcome.code), outcome.message);
  });
}
