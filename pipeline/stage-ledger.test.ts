import { appendFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLedger, appendStageRecord, shouldSkipStage, atomicWriteFile, createAtomicTemporaryPath } from './stage-ledger.js';
import type { StageRecord } from '@hub/contracts';

describe('stage-ledger', () => {
  const testDir = join(process.cwd(), 'pipeline', '.work', 'test-ledger-' + Date.now());
  const ledgerPath = join(testDir, 'stages.jsonl');
  const targetFilePath = join(testDir, 'atomic-target.json');

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('loads ledger records and handles resume semantics correctly', async () => {
    const rec1: StageRecord = {
      entryId: 'entry1',
      stage: 'rights',
      ok: true,
      inputHash: 'hash-abc-123',
      outputHash: 'output-abc-123',
    };
    const rec2: StageRecord = {
      entryId: 'entry2',
      stage: 'scan',
      ok: false,
      inputHash: 'hash-def-456',
      outputHash: 'output-def-456',
    };

    await appendStageRecord(ledgerPath, rec1);
    await appendStageRecord(ledgerPath, rec2);

    const ledger = await loadLedger(ledgerPath);
    expect(ledger.size).toBe(2);

    // Skip when ok is true and inputHash matches
    expect(shouldSkipStage(ledger, 'entry1', 'rights', 'hash-abc-123', 'output-abc-123')).toBe(true);

    // Re-run when inputHash changes
    expect(shouldSkipStage(ledger, 'entry1', 'rights', 'hash-changed', 'output-abc-123')).toBe(false);

    // Re-run when the previously materialized output identity changes
    expect(shouldSkipStage(ledger, 'entry1', 'rights', 'hash-abc-123', 'output-changed')).toBe(false);

    // Re-run when ok was false
    expect(shouldSkipStage(ledger, 'entry2', 'scan', 'hash-def-456', 'output-def-456')).toBe(false);

    // Re-run when record does not exist
    expect(shouldSkipStage(ledger, 'entry3', 'rights', 'hash-abc-123', 'output-abc-123')).toBe(false);
  });

  it('performs atomic writes without leaving temporary files on success', async () => {
    const content = JSON.stringify({ hello: 'world' }, null, 2);
    await atomicWriteFile(targetFilePath, content);

    const readBack = await readFile(targetFilePath, 'utf8');
    expect(readBack).toBe(content);
  });

  it('builds deterministic atomic temporary names from injected clock and RNG inputs', async () => {
    const nowFn = vi.fn(() => 1700);
    const randomFn = vi.fn(() => 0.5);
    const tempPath = createAtomicTemporaryPath(targetFilePath, 1700, 0.5);
    await atomicWriteFile(targetFilePath, 'deterministic', { nowFn, randomFn });

    expect(tempPath).toBe(`${targetFilePath}.tmp.1700_i`);
    expect(nowFn).toHaveBeenCalledOnce();
    expect(randomFn).toHaveBeenCalledOnce();
    expect(await readFile(targetFilePath, 'utf8')).toBe('deterministic');
  });

  it('ignores legacy or malformed records without a validated output identity', async () => {
    await appendFile(ledgerPath, JSON.stringify({ entryId: 'legacy', stage: 'acquire', ok: true, inputHash: 'old' }) + '\n', 'utf8');
    await appendFile(ledgerPath, JSON.stringify({ entryId: 'bad', stage: 'unknown', ok: true, inputHash: 'in', outputHash: 'out' }) + '\n', 'utf8');

    expect((await loadLedger(ledgerPath)).size).toBe(0);
  });
});
