import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Every workspace that has tests must have a Vitest project, or its tests are
 * silently never collected.
 *
 * `packages/scanner-cli/src/cli.test.ts` was written, committed, and passed
 * when run directly — but `vitest.config.ts` had no `scanner-cli` project, so
 * `npm test` never loaded it. The CLI is the artifact intended for npm, and
 * its only test file ran in no gate for as long as it existed.
 *
 * A count assertion would rot; this asks the structural question instead.
 */
const root = resolve(import.meta.dirname, '..');

function workspaceDirectories() {
  const { workspaces } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return workspaces.map((entry) => entry.replace(/\/\*$/, ''));
}

function hasTests(directory) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return false;
  const stack = [absolute];
  while (stack.length) {
    const current = stack.pop();
    for (const item of readdirSync(current, { withFileTypes: true })) {
      if (item.name === 'node_modules' || item.name === 'dist' || item.name === '.next') continue;
      const path = join(current, item.name);
      if (item.isDirectory()) stack.push(path);
      else if (/\.test\.(ts|tsx|mjs)$/.test(item.name)) return true;
    }
  }
  return false;
}

function configuredProjectNames() {
  const config = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
  return [...config.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1]);
}

describe('vitest project coverage', () => {
  it('declares a project for every workspace that contains tests', () => {
    const names = configuredProjectNames();
    const uncovered = workspaceDirectories()
      .filter((directory) => hasTests(directory))
      .filter((directory) => {
        // A project name need not equal the directory, so match on either the
        // directory's basename or the package name it declares.
        const base = directory.split('/').pop();
        let packageName = null;
        try {
          packageName = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8')).name;
        } catch {
          // A workspace without a manifest is matched on its directory alone.
        }
        const short = packageName?.replace(/^@[^/]+\//, '');
        return !names.includes(base) && !names.includes(packageName) && !names.includes(short);
      });

    expect(uncovered).toEqual([]);
  });

  it('covers the scripts directory, which is not an npm workspace', () => {
    expect(configuredProjectNames()).toContain('scripts');
  });
});
