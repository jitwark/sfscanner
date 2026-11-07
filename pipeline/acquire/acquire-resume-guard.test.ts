import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertAcquireStateReusable,
  findAcquireState,
  guardAcquireState,
  resetAcquireState,
} from './acquire-resume-guard.js';

describe('acquire-resume-guard', () => {
  const workDir = path.join(process.cwd(), 'pipeline', '.work', 'test-acquire-resume-guard-' + Date.now());

  beforeEach(async () => {
    await fs.mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('finds nothing in a fresh work directory', async () => {
    expect(await findAcquireState(workDir)).toEqual([]);
  });

  it('finds the official cursor, entries, workflow store, and a non-empty clones dir', async () => {
    await fs.writeFile(path.join(workDir, 'official-cursor.json'), '{}');
    await fs.writeFile(path.join(workDir, 'official-entries.json'), '[]');
    await fs.writeFile(path.join(workDir, 'official-workflows.jsonl'), '');
    await fs.mkdir(path.join(workDir, 'clones', 'some-key'), { recursive: true });

    const found = await findAcquireState(workDir);
    expect(found).toEqual(
      expect.arrayContaining(['official-cursor.json', 'official-entries.json', 'official-workflows.jsonl', 'clones/']),
    );
  });

  it('does not flag an empty clones directory', async () => {
    await fs.mkdir(path.join(workDir, 'clones'), { recursive: true });
    expect(await findAcquireState(workDir)).toEqual([]);
  });

  it('assertAcquireStateReusable resolves when resume is true, regardless of state', async () => {
    await fs.writeFile(path.join(workDir, 'official-cursor.json'), '{}');
    await expect(assertAcquireStateReusable(workDir, 'my-run', true)).resolves.toBeUndefined();
  });

  it('assertAcquireStateReusable resolves when there is no existing state', async () => {
    await expect(assertAcquireStateReusable(workDir, 'my-run', false)).resolves.toBeUndefined();
  });

  it('assertAcquireStateReusable throws a descriptive error when state exists and resume is false', async () => {
    await fs.writeFile(path.join(workDir, 'official-cursor.json'), '{}');
    await expect(assertAcquireStateReusable(workDir, 'my-run', false)).rejects.toThrow(/--resume/);
    await expect(assertAcquireStateReusable(workDir, 'my-run', false)).rejects.toThrow(/my-run/);
  });

  it('resetAcquireState removes the cursor, entries, workflow store, and clones dir', async () => {
    await fs.writeFile(path.join(workDir, 'official-cursor.json'), '{}');
    await fs.writeFile(path.join(workDir, 'official-entries.json'), '[]');
    await fs.mkdir(path.join(workDir, 'clones', 'some-key'), { recursive: true });

    await resetAcquireState(workDir);

    expect(await findAcquireState(workDir)).toEqual([]);
  });

  it('resetAcquireState on an already-empty directory is a no-op, not an error', async () => {
    await expect(resetAcquireState(workDir)).resolves.toBeUndefined();
  });

  it('guardAcquireState resets state when clean is true, even without resume', async () => {
    await fs.writeFile(path.join(workDir, 'official-cursor.json'), '{}');
    await guardAcquireState(workDir, 'my-run', { resume: false, clean: true });
    expect(await findAcquireState(workDir)).toEqual([]);
  });

  it('guardAcquireState throws when neither resume nor clean is set and state exists', async () => {
    await fs.writeFile(path.join(workDir, 'official-cursor.json'), '{}');
    await expect(guardAcquireState(workDir, 'my-run', { resume: false, clean: false })).rejects.toThrow(/--resume/);
  });

  it('guardAcquireState resolves quietly when resume is true and clean is false', async () => {
    await fs.writeFile(path.join(workDir, 'official-cursor.json'), '{}');
    await expect(guardAcquireState(workDir, 'my-run', { resume: true, clean: false })).resolves.toBeUndefined();
  });
});
