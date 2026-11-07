import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isReusableCompletedBatch,
  loadBatchLedger,
  recordBatchCompletion,
  recordBatchFailure,
  recordBatchStart,
} from './batch-ledger.js';

const ledgerPath = path.join(process.cwd(), 'pipeline', '.work', `batch-ledger-${Date.now()}.json`);
const historyPath = `${ledgerPath}.history.json`;

afterEach(() => { fs.rmSync(ledgerPath, { force: true }); fs.rmSync(historyPath, { force: true }); });

describe('batch ledger', () => {
  it('writes and reloads a completed batch atomically', () => {
    recordBatchStart(ledgerPath, { batchIndex: 0, identityHash: 'input-a', selectedCount: 2 });
    recordBatchCompletion(ledgerPath, { batchIndex: 0, identityHash: 'input-a', checkpointHash: 'checkpoint-a', acceptedCount: 2 });
    const ledger = loadBatchLedger(ledgerPath);
    expect(ledger[0]?.status).toBe('completed');
    expect(isReusableCompletedBatch(ledger[0], 'input-a', 'checkpoint-a')).toBe(true);
    expect(isReusableCompletedBatch(ledger[0], 'changed', 'checkpoint-a')).toBe(false);
    recordBatchStart(ledgerPath, { batchIndex: 0, identityHash: 'input-b', selectedCount: 1 });
    expect(JSON.parse(fs.readFileSync(historyPath, 'utf8'))[0].identityHash).toBe('input-a');
    expect(loadBatchLedger(ledgerPath)[0]?.attemptCount).toBe(1);
  });

  it('keeps failed batches failed and excludes them from reuse', () => {
    recordBatchStart(ledgerPath, { batchIndex: 1, identityHash: 'input-b', selectedCount: 1 });
    recordBatchFailure(ledgerPath, { batchIndex: 1, identityHash: 'input-b', errorCode: 'validation_failed', errorMessage: 'bounded error' });
    const ledger = loadBatchLedger(ledgerPath);
    expect(ledger[1]?.status).toBe('failed');
    expect(isReusableCompletedBatch(ledger[1], 'input-b', 'checkpoint-b')).toBe(false);
    expect(JSON.stringify(ledger)).not.toContain('workflow');
  });
});
