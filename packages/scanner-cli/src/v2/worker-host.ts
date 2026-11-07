export type WorkerHostStatus = 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT' | 'CRASH' | 'RESOURCE_LIMIT';
export type WorkerHostMemory = Readonly<{ before: NodeJS.MemoryUsage; after: NodeJS.MemoryUsage }>;
export type WorkerHostRun<T> = Readonly<{ status: 'COMPLETED'; value: T; memory?: WorkerHostMemory } | { status: Exclude<WorkerHostStatus, 'COMPLETED'>; detailCode?: string; memory?: WorkerHostMemory }>;
export type SigintSource = Readonly<{ on: (event: 'SIGINT', listener: () => void) => unknown; off?: (event: 'SIGINT', listener: () => void) => unknown; removeListener?: (event: 'SIGINT', listener: () => void) => unknown }>;
export type SigintController = Readonly<{ signal: AbortSignal; dispose: () => void }>;
export type WorkerHostOptions = Readonly<{ signal?: AbortSignal; sigint?: SigintSource; timeoutMs?: number; now?: () => number }>;
type Deferred<T> = Readonly<{ promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void }>;

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

export function createSigintController(source: SigintSource = process): SigintController {
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  source.on('SIGINT', onSigint);
  return Object.freeze({
    signal: controller.signal,
    dispose: (): void => {
      if (source.off) source.off('SIGINT', onSigint);
      else if (source.removeListener) source.removeListener('SIGINT', onSigint);
    },
  });
}

export async function runHostedScan<T>(task: () => T | PromiseLike<T>, options: WorkerHostOptions = {}): Promise<WorkerHostRun<T>> {
  const timeout = options.timeoutMs;
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2_147_483_647)) return Object.freeze({ status: 'FAILED', detailCode: 'INVALID_TIMEOUT' });
  if (options.signal?.aborted) return Object.freeze({ status: 'CANCELLED' });
  if (timeout === 0) return Object.freeze({ status: 'TIMEOUT' });
  const now = options.now ?? Date.now;
  const sigint = options.sigint === undefined ? undefined : createSigintController(options.sigint);
  if (sigint?.signal.aborted || options.signal?.aborted) { sigint?.dispose(); return Object.freeze({ status: 'CANCELLED' }); }
  const { promise, resolve } = createDeferred<WorkerHostRun<T>>();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = now();
  const finish = (result: WorkerHostRun<T>): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    sigint?.signal.removeEventListener('abort', onAbort);
    sigint?.dispose();
    resolve(Object.freeze(result));
  };
  const onAbort = (): void => finish({ status: 'CANCELLED' });
  options.signal?.addEventListener('abort', onAbort, { once: true });
  sigint?.signal.addEventListener('abort', onAbort, { once: true });
  if (timeout !== undefined) timer = setTimeout(() => finish({ status: 'TIMEOUT' }), timeout);
  void Promise.resolve().then(task).then((value) => {
    let expired = false;
    if (timeout !== undefined) { try { expired = now() - started >= timeout; } catch { expired = false; } }
    finish(expired ? { status: 'TIMEOUT' } : { status: 'COMPLETED', value });
  }, (error) => finish({
      status: error instanceof RangeError || (error as { code?: string } | null)?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'RESOURCE_LIMIT' : 'CRASH',
      detailCode: 'TASK_REJECTED',
    }));
  return promise;
}
