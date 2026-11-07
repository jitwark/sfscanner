import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = path.join(process.cwd(), 'scripts', 'check-determinism.mjs');

describe('check-determinism', () => {
  it('rejects uncontrolled clock and RNG calls across app/src and pipeline sources', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'determinism-gate-'));
    try {
      await mkdir(path.join(root, 'app', 'src'), { recursive: true });
      await mkdir(path.join(root, 'pipeline'), { recursive: true });
      await writeFile(path.join(root, 'app', 'src', 'new.ts'), 'const a = Date.now();\n', 'utf8');
      await writeFile(path.join(root, 'pipeline', 'new.mjs'), 'const b = Math.random();\n', 'utf8');
      await writeFile(path.join(root, 'pipeline', 'fixture.test.ts'), 'Date.now(); Math.random();\n', 'utf8');

      const result = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain('app/src/new.ts:1');
      expect(result.stdout + result.stderr).toContain('pipeline/new.mjs:1');
      expect(result.stdout + result.stderr).not.toContain('fixture.test.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips test and fixture sources', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'determinism-fixtures-'));
    try {
      await mkdir(path.join(root, 'app', 'src', '__fixtures__'), { recursive: true });
      await mkdir(path.join(root, 'pipeline'), { recursive: true });
      await writeFile(path.join(root, 'app', 'src', '__fixtures__', 'flow.ts'), 'Date.now();\n', 'utf8');
      await writeFile(path.join(root, 'pipeline', 'helper.test.ts'), 'Math.random();\n', 'utf8');

      const result = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
      expect(result.status).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
