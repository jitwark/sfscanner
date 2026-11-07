import { describe, expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import type { ScanWorkflowV2Result } from '@hub/scanner-core/v2';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { DEFAULT_SCAN_CONFIG_V2 } from './contracts';
import { runBatchV2, type BatchRunnerInput } from './batch-runner';
import type { SelectedInputV2 } from './input-selection';

const encoder = new TextEncoder();
const items = (labels: readonly string[]): readonly SelectedInputV2[] => labels.map((label) => ({ label, isStdin: false }));
const failure = (_code: 'INVALID_JSON' = 'INVALID_JSON'): ScanWorkflowV2Result => ({ ok: false, code: 'INVALID_JSON', message: 'private source content' });
const base = (overrides: Partial<BatchRunnerInput> = {}): BatchRunnerInput => ({
  items: items(['a.json']), config: DEFAULT_SCAN_CONFIG_V2, read: async () => encoder.encode('{}'), ...overrides,
});

describe('runBatchV2', () => {
  it('bounds active scans and keeps deterministic label order', async () => {
    vi.useFakeTimers();
    try {
      let active = 0; let maximum = 0;
      const scan = async (_bytes: Uint8Array, item: SelectedInputV2): Promise<ScanWorkflowV2Result> => {
        active += 1; maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, item.label === 'a.json' ? 20 : 1));
        active -= 1; return failure('INVALID_JSON');
      };
      const promise = runBatchV2(base({ items: items(['c.json', 'a.json', 'b.json']), config: { ...DEFAULT_SCAN_CONFIG_V2, concurrency: 2 }, scan }));
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result).toMatchObject({ ok: true, concurrency: 2, failed: 3 });
      if (result.ok) { expect(result.items.map(({ label }) => label)).toEqual(['a.json', 'b.json', 'c.json']); expect(maximum).toBeLessThanOrEqual(2); }
    } finally { vi.useRealTimers(); }
  });

  it('returns one closed error per duplicate input', async () => {
    const result = await runBatchV2(base({ items: items(['same.json', 'same.json']), scan: () => failure('INVALID_JSON') }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items.map(({ status, error }) => [status, error?.code])).toEqual([['FAILED', 'INVALID_JSON'], ['FAILED', 'INVALID_JSON']]);
  });

  it('turns host deadlines into incomplete item errors', async () => {
    vi.useFakeTimers();
    try {
      const promise = runBatchV2(base({ timeoutMs: 5, scan: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return failure('INVALID_JSON'); } }));
      await vi.advanceTimersByTimeAsync(5);
      const result = await promise;
      expect(result).toMatchObject({ ok: true, failed: 1 });
      if (result.ok) expect(result.items[0]).toMatchObject({ status: 'TIMEOUT', error: { code: 'SCAN_TIMEOUT' } });
    } finally { vi.useRealTimers(); }
  });

  it('does not start the scan when the read consumes the whole deadline', async () => {
    vi.useFakeTimers();
    try {
      const scan = vi.fn(() => failure());
      const promise = runBatchV2(base({
        timeoutMs: 5,
        read: () => new Promise<Uint8Array>((resolve) => setTimeout(() => resolve(new Uint8Array()), 30)),
        scan,
      }));
      await vi.advanceTimersByTimeAsync(5);
      const result = await promise;
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.items[0]).toMatchObject({ status: 'TIMEOUT', error: { code: 'SCAN_TIMEOUT' } });
      expect(scan).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('defaults the per-input deadline to the scanner limits contract', async () => {
    vi.useFakeTimers();
    try {
      const deadline = DEFAULT_SCANNER_LIMITS_V2.workerDeadlineMs;
      let settled = false;
      const promise = runBatchV2(base({ scan: () => new Promise<ScanWorkflowV2Result>(() => {}) }));
      void promise.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await promise;
      if (result.ok) expect(result.items[0]).toMatchObject({ status: 'TIMEOUT', error: { code: 'SCAN_TIMEOUT' } });
      expect(result).toMatchObject({ ok: true, failed: 1 });
    } finally { vi.useRealTimers(); }
  });

  it('cancels active and queued work without changing item order', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const scan = async (): Promise<ScanWorkflowV2Result> => { await new Promise((resolve) => setTimeout(resolve, 20)); return failure('INVALID_JSON'); };
      const promise = runBatchV2(base({ items: items(['a.json', 'b.json', 'c.json']), config: { ...DEFAULT_SCAN_CONFIG_V2, concurrency: 1 }, signal: controller.signal, scan }));
      await Promise.resolve(); await Promise.resolve(); controller.abort();
      const result = await promise;
      expect(result.ok).toBe(true);
      if (result.ok) { expect(result.cancelled).toBe(true); expect(result.items.map(({ label }) => label)).toEqual(['a.json', 'b.json', 'c.json']); expect(result.items.every(({ status }) => status === 'CANCELLED')).toBe(true); }
    } finally { vi.useRealTimers(); }
  });
  it('converts SIGINT into cancelled per-item outcomes', async () => {
    const listeners = new Set<() => void>();
    const source = { on: (_event: 'SIGINT', listener: () => void): void => { listeners.add(listener); }, off: (_event: 'SIGINT', listener: () => void): void => { listeners.delete(listener); } };
    const promise = runBatchV2(base({ items: items(['a.json', 'b.json']), sigint: source, scan: async () => new Promise<ScanWorkflowV2Result>(() => {}) }));
    await Promise.resolve(); await Promise.resolve();
    for (const listener of listeners) listener();
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items.every(({ status }) => status === 'CANCELLED')).toBe(true);
  });
  it('returns CANCELLED when the signal aborts during worker construction', async () => {
    const controller = new AbortController();
    const worker = new Worker(new URL('./__fixtures__/blocking-worker.mjs', import.meta.url));
    const workerFactory = vi.fn(() => {
      controller.abort();
      // Error queued inside the construction window; the host handlers must already own it.
      queueMicrotask(() => worker.emit('error', new Error('late worker error')));
      return worker;
    });
    const result = await runBatchV2(base({
      signal: controller.signal,
      timeoutMs: 1_000,
      scanWorker: workerFactory,
      read: async () => encoder.encode('{"nodes":[],"connections":{}}'),
    }));
    expect(workerFactory).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]).toMatchObject({ status: 'CANCELLED', error: { code: 'SCAN_CANCELLED' } });
    // The consumer observes CANCELLED only after the owned thread is gone; the queued error was
    // owned by the settled host promise instead of escaping as an uncaught event.
    expect(worker.threadId).toBe(-1);
  });

  it('returns FAILED to the consumer when worker termination rejects', async () => {
    const worker = new Worker(new URL('./__fixtures__/blocking-worker.mjs', import.meta.url));
    const realTerminate = worker.terminate.bind(worker);
    worker.terminate = () => Promise.reject(new Error('injected termination failure'));
    try {
      const result = await runBatchV2(base({
        timeoutMs: 25,
        scanWorker: () => worker,
        read: async () => encoder.encode('{"nodes":[],"connections":{}}'),
      }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.items[0]).toMatchObject({ status: 'FAILED', error: { code: 'TOOL_INVARIANT_FAILED' } });
    } finally {
      await realTerminate();
    }
    expect(worker.threadId).toBe(-1);
  });

  it('maps a worker crash to a typed per-file failure', async () => {
    const worker = new Worker(new URL('./__fixtures__/throwing-worker.mjs', import.meta.url));
    const result = await runBatchV2(base({
      timeoutMs: 1_000,
      scanWorker: () => worker,
      read: async () => encoder.encode('{"nodes":[],"connections":{}}'),
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]).toMatchObject({ status: 'FAILED', error: { code: 'WORKER_CRASH' } });
    expect(worker.threadId).toBe(-1);
  });

  it('honours signals already aborted before worker startup', async () => {
    const controller = new AbortController(); controller.abort();
    const listeners = new Set<() => void>();
    const source = { on: (_event: 'SIGINT', listener: () => void): void => { listeners.add(listener); listener(); }, off: (_event: 'SIGINT', listener: () => void): void => { listeners.delete(listener); } };
    const scan = vi.fn(() => failure());
    const result = await runBatchV2(base({ items: items(['a.json', 'b.json']), signal: controller.signal, sigint: source, scan }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items.every(({ status }) => status === 'CANCELLED')).toBe(true);
    expect(scan).not.toHaveBeenCalled();
  });
  it('redacts invalid absolute labels from per-item errors', async () => {
    const result = await runBatchV2(base({ items: [{ label: 'C:/private/workflow.json', isStdin: false }] }));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('preserves core UTF-8 and byte-limit errors without source leakage', async () => {
    const invalid = await runBatchV2(base({ read: async () => new Uint8Array([0xff, 0xfe]) }));
    expect(invalid.ok).toBe(true);
    if (invalid.ok) expect(invalid.items[0]).toMatchObject({ status: 'FAILED', error: { code: 'UTF8_DECODING_FAILED' } });
    const oversized = await runBatchV2(base({ maxInputBytes: 1, read: async () => new Uint8Array([1, 2]) }));
    expect(oversized.ok).toBe(true);
    if (oversized.ok) expect(oversized.items[0]).toMatchObject({ status: 'FAILED', error: { code: 'WORKFLOW_TOO_LARGE' } });
    expect(JSON.stringify(oversized)).not.toContain('1,2');
  });

  it('does not emit an envelope for invalid configuration', async () => {
    const result = await runBatchV2(base({ config: { ...DEFAULT_SCAN_CONFIG_V2, concurrency: 17 } }));
    expect(result).toEqual({ ok: false, code: 'INVALID_CONFIG', message: 'Configuration is invalid.' });
  });

  it('calls the scanner core by default for Uint8Array input', async () => {
    const result = await runBatchV2(base({ read: async () => encoder.encode('{"nodes":[],"connections":{}}') }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]?.status).toBe('COMPLETED');
  });

  it('does not perform network I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await runBatchV2(base({ scan: () => failure('INVALID_JSON') }));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
