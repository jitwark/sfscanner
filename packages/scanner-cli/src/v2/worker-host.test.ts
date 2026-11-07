import { describe, expect, it, vi } from 'vitest';
import { createSigintController, runHostedScan } from './worker-host';

type Listener = () => void;
class SignalSource {
  private readonly listeners = new Set<Listener>();
  on(event: 'SIGINT', listener: Listener): this { if (event === 'SIGINT') this.listeners.add(listener); return this; }
  off(event: 'SIGINT', listener: Listener): this { if (event === 'SIGINT') this.listeners.delete(listener); return this; }
  emit(): void { for (const listener of this.listeners) listener(); }
  count(): number { return this.listeners.size; }
}

describe('worker host controls', () => {
  it('maps an abort signal to one cancelled lifecycle result', async () => {
    const controller = new AbortController(); controller.abort();
    const run = await runHostedScan(() => 'unreachable', { signal: controller.signal });
    expect(run).toEqual({ status: 'CANCELLED' });
  });

  it('maps deadline expiry without leaking task errors', async () => {
    vi.useFakeTimers();
    try {
      const runPromise = runHostedScan(async () => new Promise<string>(() => {}), { timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      expect(await runPromise).toEqual({ status: 'TIMEOUT' });
    } finally { vi.useRealTimers(); }
  });

  it('types task rejection as one FAILED result and keeps the parent alive', async () => {
    await expect(runHostedScan(() => { throw new Error('worker crashed'); }))
      .resolves.toEqual({ status: 'CRASH', detailCode: 'TASK_REJECTED' });
    await expect(runHostedScan(() => { throw new RangeError('heap exhausted'); }))
      .resolves.toEqual({ status: 'RESOURCE_LIMIT', detailCode: 'TASK_REJECTED' });
    await expect(runHostedScan(() => 'next file')).resolves.toEqual({ status: 'COMPLETED', value: 'next file' });
  });

  it('treats a late result after timeout as terminal and ignores a second settle', async () => {
    vi.useFakeTimers();
    try {
      let complete: ((value: string) => void) | undefined;
      const runPromise = runHostedScan(() => new Promise<string>((resolve) => { complete = resolve; }), { timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      complete?.('late');
      await vi.advanceTimersByTimeAsync(1);
      expect(await runPromise).toEqual({ status: 'TIMEOUT' });
    } finally { vi.useRealTimers(); }
  });

  it('installs and disposes a SIGINT hook without process termination', () => {
    const source = new SignalSource(); const controller = createSigintController(source);
    expect(source.count()).toBe(1); expect(controller.signal.aborted).toBe(false);
    source.emit(); expect(controller.signal.aborted).toBe(true);
    controller.dispose(); expect(source.count()).toBe(0);
  });
});
