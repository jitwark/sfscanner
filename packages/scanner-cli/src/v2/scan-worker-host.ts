import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { WorkerHostRun } from './worker-host';

export type ScanWorkerData = Readonly<{
  bytes: Uint8Array;
  profile: Readonly<{ id: string; version: string }>;
  target?: unknown;
  limits?: unknown;
  approvedDomains?: readonly string[];
  advisoryRequest?: unknown;
}>;
export const DEFAULT_SCAN_WORKER_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 1024 });
export type ScanWorkerFactory = () => Worker;
export type ScanWorkerOptions = Readonly<{
  timeoutMs?: number;
  signal?: AbortSignal;
  workerFactory?: ScanWorkerFactory;
  resourceLimits?: { maxOldGenerationSizeMb?: number; maxYoungGenerationSizeMb?: number };
  recordMemory?: boolean;
}>;

const requireFromPackage = createRequire(import.meta.url);

/**
 * `#sfscanner-worker` is the package's private imports map to the one built
 * `dist/scan-worker.js`. `createRequire(...).resolve` uses the same native
 * package-imports resolution as `import.meta.resolve` (unavailable in
 * vite-node) and checks the target exists, so the same call works from the
 * root bundle, the v2 subpath bundle, and the unbundled source tree after one
 * build. A missing asset throws MODULE_NOT_FOUND; there is no fallback.
 */
export function scanWorkerUrl(): URL {
  return pathToFileURL(requireFromPackage.resolve('#sfscanner-worker'));
}

export function createScanWorker(data: ScanWorkerData, resourceLimits?: ScanWorkerOptions['resourceLimits']): Worker {
  return new Worker(scanWorkerUrl(), { workerData: data, resourceLimits: resourceLimits ?? DEFAULT_SCAN_WORKER_RESOURCE_LIMITS });
}

export async function runScanInWorker<T = unknown>(data: ScanWorkerData, options: ScanWorkerOptions = {}): Promise<WorkerHostRun<T>> {
  const { timeoutMs, signal } = options;
  const memoryBefore = options.recordMemory === true ? process.memoryUsage() : undefined;
  if (signal?.aborted) return Object.freeze({ status: 'CANCELLED' as const });
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)) return Object.freeze({ status: 'FAILED' as const });
  if (timeoutMs === 0) return Object.freeze({ status: 'TIMEOUT' as const });
  let worker: Worker;
  try {
    worker = (options.workerFactory ?? (() => createScanWorker(data, options.resourceLimits)))();
  } catch {
    // Missing #sfscanner-worker or a failed construction is a closed per-item FAILED, never a
    // rejected promise and never an in-process fallback.
    return Object.freeze({ status: 'FAILED' as const });
  }
  const { promise, resolve } = Promise.withResolvers<WorkerHostRun<T>>();
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  // Settlement means `terminate()` fulfilled for the owned thread, not merely that termination
  // was requested: the batch may start the next item as soon as this promise resolves. A
  // fulfilled terminate is not independent proof of exit on native Node 22; the rejection path
  // below already reports FAILED when that call rejects (60 / 64-F3).
  const settleAfterExit = (result: WorkerHostRun<T>): void => {
    if (settled) return;
    settled = true;
    const memory = memoryBefore === undefined ? undefined : { before: memoryBefore, after: process.memoryUsage() };
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    void worker.terminate().then(
      () => resolve(Object.freeze(memory === undefined ? result : { ...result, memory })),
      // A rejected termination leaves the exit unproven for every status. TIMEOUT, CANCELLED, and
      // FAILED must not be reported as their normal result once the thread's exit is unproven.
      () => resolve(Object.freeze({ status: 'FAILED' as const })),
    );
  };
  const onAbort = (): void => { settleAfterExit({ status: 'CANCELLED' }); };
  signal?.addEventListener('abort', onAbort, { once: true });
  // Arm the worker handlers before the post-construction abort check can terminate, so an
  // error/exit emitted in that window is still owned by this promise instead of escaping.
  worker.once('message', (value) => { settleAfterExit({ status: 'COMPLETED', value: value as T }); });
  worker.once('error', (error) => {
    settleAfterExit({ status: error instanceof RangeError || (error as { code?: string } | null)?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'RESOURCE_LIMIT' : 'CRASH' });
  });
  worker.once('exit', () => { settleAfterExit({ status: 'FAILED' }); });
  // The signal may abort between the caller's check and listener installation.
  if (signal?.aborted) { onAbort(); return promise; }
  if (timeoutMs !== undefined) timer = setTimeout(() => { settleAfterExit({ status: 'TIMEOUT' }); }, timeoutMs);
  return promise;
}
