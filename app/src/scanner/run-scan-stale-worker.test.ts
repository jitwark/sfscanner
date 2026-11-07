import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScanWorkerResponse } from './scan.worker';
import { cancelScan, runScan } from './run-scan';
import { createMockScanResult, MockWorker } from './run-scan.test-support';

describe('runScan rapid-submit isolation', () => {
  beforeEach(() => {
    cancelScan();
    MockWorker.instances = [];
    (globalThis as Record<string, unknown>).Worker = MockWorker;
  });

  afterEach(() => {
    cancelScan();
  });

  it('ignores a stale result from the worker replaced by a rapid second submit', async () => {
    const first = runScan({ json: 'HOLD_TRIGGER', profile: 'beta-default' });
    const staleWorker = MockWorker.instances[0];
    const staleRequest = staleWorker.lastScanRequest!;

    const current = runScan({ json: 'HOLD_TRIGGER', profile: 'beta-hardened' });
    const currentWorker = MockWorker.instances[1];
    const currentRequest = currentWorker.lastScanRequest!;

    staleWorker.onmessage?.({
      data: { kind: 'result', id: staleRequest.id, result: createMockScanResult('beta-default') },
    } as MessageEvent<ScanWorkerResponse>);
    currentWorker.onmessage?.({
      data: { kind: 'result', id: currentRequest.id, result: createMockScanResult('beta-hardened') },
    } as MessageEvent<ScanWorkerResponse>);

    await expect(first).resolves.toBe('cancelled');
    await expect(current).resolves.toMatchObject({ policyProfile: 'beta-hardened' });
    expect(staleWorker.terminated).toBe(true);
  });
});
