import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const script = resolve(import.meta.dirname, 'check-scanner-core-bare-node.mjs');

describe('scanner-core bare-Node smoke harness', () => {
  it('runs as a real Node child process with the tsx loader', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(
      /^scanner-core bare-node smoke passed: exports=\d+, findings=\d+, deterministic=yes, redacted=yes, runtime=bare-node\n$/,
    );
  });
});
