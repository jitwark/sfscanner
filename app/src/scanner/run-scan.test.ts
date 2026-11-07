import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelScan, runScan, ScanError } from './run-scan';
import type { ScanWorkerResponse } from './scan.worker';
import { createMockScanResult, MockWorker } from './run-scan.test-support';

describe('runScan', () => {
  beforeEach(() => {
    cancelScan();
    MockWorker.instances = [];
    const globalObj = globalThis as Record<string, unknown>;
    globalObj.Worker = MockWorker;
  });

  it('scans successfully under beta-default profile', async () => {
    const result = await runScan({
      json: JSON.stringify({ nodes: [], connections: {} }),
      profile: 'beta-default',
    });

    expect(result).not.toBe('cancelled');
    if (result !== 'cancelled') {
      expect(result.policyProfile).toBe('beta-default');
      expect(result.riskAssessment!.grade).toBe('LOW');
    }
  });

  it('scans successfully under beta-hardened profile', async () => {
    const result = await runScan({
      json: JSON.stringify({ nodes: [], connections: {} }),
      profile: 'beta-hardened',
    });

    expect(result).not.toBe('cancelled');
    if (result !== 'cancelled') {
      expect(result.policyProfile).toBe('beta-hardened');
    }
  });

  it('uses a stable host correlation id for the same deterministic seed', async () => {
    const json = JSON.stringify({ nodes: [], connections: {} });
    const first = runScan({ json, seedId: 'fixture-42' });
    const firstId = MockWorker.instances[0].lastScanRequest!.id;
    const firstResult = await first;
    const second = runScan({ json, seedId: 'fixture-42' });
    const secondId = MockWorker.instances[0].lastScanRequest!.id;
    const secondResult = await second;

    expect(firstId).toBe(secondId);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).not.toHaveProperty('id');
  });

  it('keeps default worker correlation ids unique between scans', async () => {
    const json = JSON.stringify({ nodes: [], connections: {} });
    const first = runScan({ json });
    const firstId = MockWorker.instances[0].lastScanRequest!.id;
    await first;
    const second = runScan({ json });
    const secondId = MockWorker.instances[0].lastScanRequest!.id;
    await second;

    expect(firstId).not.toBe(secondId);
  });

  it('rejects with TOO_LARGE on 2 MiB payload threshold', async () => {
    try {
      await runScan({ json: 'TOO_LARGE_TRIGGER_' + 'x'.repeat(100) });
      expect.fail('Should have thrown ScanError');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ScanError);
      if (err instanceof ScanError) {
        expect(err.code).toBe('TOO_LARGE');
      }
    }
  });

  it('rejects with TOO_MANY_NODES when node count limit is exceeded', async () => {
    try {
      await runScan({ json: 'TOO_MANY_NODES_TRIGGER' });
      expect.fail('Should have thrown ScanError');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ScanError);
      if (err instanceof ScanError) {
        expect(err.code).toBe('TOO_MANY_NODES');
      }
    }
  });

  it('forwards the worker-supplied error details onto ScanError', async () => {
    try {
      await runScan({ json: 'TOO_MANY_NODES_WITH_DETAILS_TRIGGER' });
      expect.fail('Should have thrown ScanError');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ScanError);
      if (err instanceof ScanError) {
        expect(err.code).toBe('TOO_MANY_NODES');
        expect(err.details).toEqual({ observedNodeCount: 7000 });
      }
    }
  });

  it('rejects with INVALID_JSON on malformed json input', async () => {
    try {
      await runScan({ json: 'INVALID_JSON_DATA' });
      expect.fail('Should have thrown ScanError');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ScanError);
      if (err instanceof ScanError) {
        expect(err.code).toBe('INVALID_JSON');
      }
    }
  });

  it('rejects with INTERNAL when the scanner worker crashes', async () => {
    await expect(runScan({ json: 'WORKER_CRASH_TRIGGER' })).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'Scanner worker failed.',
    });
  });

  it('rejects message decoding failures and recreates the worker for a retry', async () => {
    await expect(runScan({ json: 'MESSAGE_ERROR_TRIGGER' })).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'Scanner worker response could not be read.',
    });

    const retry = await runScan({
      json: JSON.stringify({ nodes: [], connections: {} }),
      profile: 'beta-hardened',
    });

    expect(MockWorker.instances).toHaveLength(2);
    expect(MockWorker.instances[0].terminated).toBe(true);
    expect(retry).not.toBe('cancelled');
  });

  it('ignores a late error callback from a worker that has already been replaced', async () => {
    await expect(runScan({ json: 'WORKER_CRASH_TRIGGER' })).rejects.toBeInstanceOf(ScanError);
    const failedWorker = MockWorker.instances[0];
    const retryPromise = runScan({ json: 'HOLD_TRIGGER', profile: 'beta-hardened' });
    const currentWorker = MockWorker.instances[1];
    const request = currentWorker.lastScanRequest!;

    failedWorker.onerror?.({ message: 'late worker error' } as ErrorEvent);
    currentWorker.onmessage?.({
      data: { kind: 'result', id: request.id, result: createMockScanResult(request.profile) },
    } as MessageEvent<ScanWorkerResponse>);

    await expect(retryPromise).resolves.toMatchObject({ policyProfile: 'beta-hardened' });
  });

  it('emits progress ordering parse -> analyse -> render', async () => {
    const phases: Array<{ phase: string; pct: number }> = [];

    await runScan({
      json: JSON.stringify({ nodes: [], connections: {} }),
      onProgress: (phase, pct) => {
        phases.push({ phase, pct });
      },
    });

    expect(phases).toEqual([
      { phase: 'parse', pct: 25 },
      { phase: 'analyse', pct: 60 },
      { phase: 'render', pct: 90 },
    ]);
  });

  it('resolves cancelled on cancellation with no result delivered afterwards', async () => {
    const onProgress = vi.fn();
    const scanPromise = runScan({
      json: JSON.stringify({ nodes: [], connections: {} }),
      onProgress,
    });

    cancelScan();

    const result = await scanPromise;
    expect(result).toBe('cancelled');
  });

  it('drops a progress message whose pct regresses instead of applying it', async () => {
    const phases: Array<{ phase: string; pct: number }> = [];

    await runScan({
      json: 'REGRESSING_PROGRESS_TRIGGER',
      onProgress: (phase, pct) => phases.push({ phase, pct }),
    });

    expect(phases).toEqual([{ phase: 'analyse', pct: 60 }]);
  });

  it('rejects a malformed structured-clone result and terminates the worker', async () => {
    await expect(runScan({ json: 'MALFORMED_RESULT_TRIGGER' })).rejects.toMatchObject({
      code: 'INTERNAL', message: 'Scanner worker returned a malformed result.',
    });
    expect(MockWorker.instances[0].terminated).toBe(true);
  });

  describe('worker deadline', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('terminates the worker and rejects with a typed TIMEOUT error when the deadline is exceeded', async () => {
      const scanPromise = runScan({ json: 'HOLD_TRIGGER', deadlineMs: 100 });
      const assertion = expect(scanPromise).rejects.toMatchObject({
        code: 'TIMEOUT',
        message: 'Scan exceeded the 100ms worker deadline.',
      });

      await vi.advanceTimersByTimeAsync(100);
      await assertion;

      expect(MockWorker.instances).toHaveLength(1);
      expect(MockWorker.instances[0].terminated).toBe(true);
    });

    it('permits a clean retry with a new request after a timeout', async () => {
      const timedOut = runScan({ json: 'HOLD_TRIGGER', deadlineMs: 100 });
      const assertion = expect(timedOut).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(100);
      await assertion;

      const retry = await runScan({ json: JSON.stringify({ nodes: [], connections: {} }) });

      expect(retry).not.toBe('cancelled');
      expect(MockWorker.instances).toHaveLength(2);
    });

    it('does not fire the deadline once the scan already settled', async () => {
      const result = await runScan({
        json: JSON.stringify({ nodes: [], connections: {} }),
        deadlineMs: 100,
      });

      expect(result).not.toBe('cancelled');
      // If the deadline timer were not cleared on settle, this would terminate
      // an already-replaced worker or reject a promise nothing awaits anymore.
      await vi.advanceTimersByTimeAsync(200);
      expect(MockWorker.instances[0].terminated).toBe(false);
    });
  });
});
