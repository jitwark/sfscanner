import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * I1 / R3-F4. `writePublicRelease` is the single public entry point for writing
 * a release bundle, and it routes through `promoteReleaseBundle` so the target
 * directory is never observed in a mixed old/new state.
 *
 * The export automation has deliberately not shipped yet — `public-data-exports`
 * task P6.9 requires retention/supersession to be settled "before automation
 * ships", and it is. So the atomicity work is correctly ahead of its callers
 * rather than orphaned.
 *
 * The live risk is therefore not "nothing calls it" but "a future caller calls
 * the wrong thing": `buildReleaseBundle` is exported from `bundle-builder.ts`
 * and writes a complete bundle with no promotion at all. Importing it directly
 * would silently reintroduce AUDIT-EXPORT-001 — a partially-written release
 * under stable paths — while every existing atomicity test kept passing,
 * because those tests exercise `writePublicRelease`, not the bypass.
 *
 * This pins the boundary: only the orchestrator and tests may reach the builder.
 */
const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** Files allowed to import the unpromoted builder directly. */
const ALLOWED = new Set([
  'pipeline/export/public-release.ts', // the orchestrator that adds promotion
  'pipeline/export/bundle-builder.ts', // itself
]);

const SKIP_DIRS = new Set(['node_modules', '.next', 'out', '.work', '.git', 'out-canary', 'test-results', 'data']);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx|mjs)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe('release bundle promotion boundary', () => {
  it('routes every production write through promoteReleaseBundle', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(REPO_ROOT)) {
      const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
      if (ALLOWED.has(rel) || rel.includes('.test.')) continue;
      const text = readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]*bundle-builder(\.js)?['"]/.test(text)) offenders.push(rel);
    }

    // A new entry here means someone can write a release bundle without the
    // staging-and-swap. Add promotion to that caller rather than widening this.
    expect(offenders).toEqual([]);
  });

  it('keeps writePublicRelease delegating to the promotion wrapper', () => {
    const orchestrator = readFileSync(join(REPO_ROOT, 'pipeline/export/public-release.ts'), 'utf8');
    expect(orchestrator).toMatch(/promoteReleaseBundle\(/);
  });
});
