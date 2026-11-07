import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('standalone repository layout', () => {
  it('owns its Git root rather than inheriting a surrounding repository', () => {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
    expect(path.resolve(gitRoot)).toBe(root);
  });

  it('resolves CI and lockfile paths from the package root', () => {
    const ci = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('cache-dependency-path: package-lock.json');
    expect(ci).not.toContain('working-directory: community-hub');
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const workspace of manifest.workspaces) {
      expect(path.relative(root, path.resolve(root, workspace)).startsWith('..')).toBe(false);
      expect(JSON.parse(readFileSync(path.join(root, workspace, 'package.json'), 'utf8')).name).toBeTruthy();
    }
  });

  it('does not satisfy documentation references from an unrelated parent checkout', () => {
    const checker = readFileSync(path.join(root, 'scripts/check-doc-consistency.mjs'), 'utf8');
    expect(checker).not.toContain("const alternateRoots = [resolve(root, '..')]");
  });
});
