import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { runScanInWorker, scanWorkerUrl } from './scan-worker-host';

const data = {
  bytes: new Uint8Array(),
  profile: { id: 'beta-default', version: '2.0.0' },
} as const;
const fixture = (name: string): URL => new URL(`./__fixtures__/${name}`, import.meta.url);

/**
 * A real owned worker with only `terminate` overridden, because Node 22's terminate fulfills on
 * exit and has no native rejection path. The returned cleanup awaits the original bound terminate,
 * so a failing test can never leave the thread running.
 */
function withRejectingTermination(worker: Worker): () => Promise<void> {
  const realTerminate = worker.terminate.bind(worker);
  worker.terminate = () => Promise.reject(new Error('injected termination failure'));
  return async () => { await realTerminate(); };
}

describe('scan worker ownership', () => {
  it('resolves the one private import-map asset', () => {
    const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
    expect(scanWorkerUrl().href).toBe(pathToFileURL(path.resolve(packageRoot, 'dist/scan-worker.js')).href);
  });

  it('preempts a blocking worker at the deadline and returns only after the thread exited', async () => {
    const started = Date.now();
    const worker = new Worker(fixture('blocking-worker.mjs'));
    const terminate = vi.spyOn(worker, 'terminate');
    const result = await runScanInWorker(data, { timeoutMs: 25, workerFactory: () => worker });
    expect(result).toEqual({ status: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(worker.threadId).toBe(-1);
  });

  it('returns a completed message only after the lingering thread exited', async () => {
    const worker = new Worker(fixture('lingering-worker.mjs'));
    const terminate = vi.spyOn(worker, 'terminate');
    const result = await runScanInWorker(data, { timeoutMs: 1_000, workerFactory: () => worker });
    expect(result).toEqual({ status: 'COMPLETED', value: { ok: true } });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(worker.threadId).toBe(-1);
  });

  it('reports FAILED with the throwing thread already gone', async () => {
    const worker = new Worker(fixture('throwing-worker.mjs'));
    const terminate = vi.spyOn(worker, 'terminate');
    const result = await runScanInWorker(data, { timeoutMs: 1_000, workerFactory: () => worker });
    expect(result).toEqual({ status: 'CRASH' });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(worker.threadId).toBe(-1);
  });

  it('reports CANCELLED only after the aborted thread exited', async () => {
    const controller = new AbortController();
    const worker = new Worker(fixture('blocking-worker.mjs'));
    const terminate = vi.spyOn(worker, 'terminate');
    const pending = runScanInWorker(data, { timeoutMs: 5_000, signal: controller.signal, workerFactory: () => worker });
    controller.abort();
    await expect(pending).resolves.toEqual({ status: 'CANCELLED' });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(worker.threadId).toBe(-1);
  });

  it('records before/after memory when requested', async () => {
    const worker = new Worker(fixture('lingering-worker.mjs'));
    const result = await runScanInWorker(data, { timeoutMs: 1_000, workerFactory: () => worker, recordMemory: true });
    expect(result.status).toBe('COMPLETED');
    if (result.status !== 'COMPLETED') return;
    expect(result.memory?.before.rss).toBeGreaterThan(0);
    expect(result.memory?.after.rss).toBeGreaterThan(0);
  });

  it('reports FAILED when terminating a timed-out worker rejects', async () => {
    const worker = new Worker(fixture('blocking-worker.mjs'));
    const cleanup = withRejectingTermination(worker);
    try {
      await expect(runScanInWorker(data, { timeoutMs: 25, workerFactory: () => worker }))
        .resolves.toEqual({ status: 'FAILED' });
    } finally {
      await cleanup();
    }
    expect(worker.threadId).toBe(-1);
  });

  it('reports FAILED when terminating a cancelled worker rejects', async () => {
    const controller = new AbortController();
    const worker = new Worker(fixture('blocking-worker.mjs'));
    const cleanup = withRejectingTermination(worker);
    try {
      const pending = runScanInWorker(data, { timeoutMs: 5_000, signal: controller.signal, workerFactory: () => worker });
      controller.abort();
      await expect(pending).resolves.toEqual({ status: 'FAILED' });
    } finally {
      await cleanup();
    }
    expect(worker.threadId).toBe(-1);
  });

  it('reports FAILED when terminating a completed worker rejects', async () => {
    const worker = new Worker(fixture('lingering-worker.mjs'));
    const cleanup = withRejectingTermination(worker);
    try {
      await expect(runScanInWorker(data, { timeoutMs: 1_000, workerFactory: () => worker }))
        .resolves.toEqual({ status: 'FAILED' });
    } finally {
      await cleanup();
    }
    expect(worker.threadId).toBe(-1);
  });

  it('keeps FAILED when terminating a failed worker rejects', async () => {
    const worker = new Worker(fixture('throwing-worker.mjs'));
    const cleanup = withRejectingTermination(worker);
    try {
      await expect(runScanInWorker(data, { timeoutMs: 1_000, workerFactory: () => worker }))
        .resolves.toEqual({ status: 'FAILED' });
    } finally {
      await cleanup();
    }
    expect(worker.threadId).toBe(-1);
  });

  it('fails closed when the worker factory cannot start', async () => {
    await expect(runScanInWorker(data, {
      timeoutMs: 1_000,
      workerFactory: () => { throw new Error('missing worker'); },
    })).resolves.toEqual({ status: 'FAILED' });
  });

  it('fails closed with MODULE_NOT_FOUND instead of scanning in process', async () => {
    await expect(runScanInWorker(data, {
      timeoutMs: 1_000,
      workerFactory: () => { throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' }); },
    })).resolves.toEqual({ status: 'FAILED' });
  });

  it('does not construct a worker once the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const workerFactory = vi.fn(() => { throw new Error('must not construct'); });
    await expect(runScanInWorker(data, { timeoutMs: 1_000, signal: controller.signal, workerFactory })).resolves.toEqual({ status: 'CANCELLED' });
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it('settles CANCELLED with the thread gone when the signal aborts during construction', async () => {
    const controller = new AbortController();
    const worker = new Worker(fixture('blocking-worker.mjs'));
    const workerFactory = vi.fn(() => {
      controller.abort();
      // The reachable window: an error queued after construction but before the post-construction
      // abort check. The message/error/exit handlers must already be armed to own it.
      queueMicrotask(() => worker.emit('error', new Error('late worker error')));
      return worker;
    });
    await expect(runScanInWorker(data, {
      timeoutMs: 1_000,
      signal: controller.signal,
      workerFactory,
    })).resolves.toEqual({ status: 'CANCELLED' });
    expect(workerFactory).toHaveBeenCalledTimes(1);
    expect(worker.threadId).toBe(-1);
  });
});
