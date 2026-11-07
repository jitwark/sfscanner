import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cancelScan, runScan } from './run-scan';
import { MockWorker } from './run-scan.test-support';

describe('runScan invalid worker responses', () => {
  beforeEach(() => {
    cancelScan();
    MockWorker.instances = [];
    (globalThis as Record<string, unknown>).Worker = MockWorker;
  });

  afterEach(() => {
    cancelScan();
  });

  it('rejects an unknown response instead of leaving the scan pending', async () => {
    const scanPromise = runScan({ json: 'UNKNOWN_RESPONSE_TRIGGER' });
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('scan promise remained pending')), 100);
    });

    await expect(Promise.race([scanPromise, timeout])).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'Scanner worker returned an invalid response.',
    });
    expect(MockWorker.instances[0].terminated).toBe(true);
  });
});
