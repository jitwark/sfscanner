import { describe, expect, test } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReferencedPaths } from './doc-referenced-paths.mjs';

/**
 * DOC-GATE-2 — a document may not name a source path that does not exist.
 *
 * The repository-root CLAUDE.md described a Supabase/Drizzle server application
 * for weeks. It named six source files, none of which existed, and every
 * documentation gate passed the whole time: the metadata, forbidden-phrase,
 * link and corpus-figure checks all look at prose and markdown links, and none
 * of them asks whether a backticked source path resolves to a file.
 *
 * The check only considers paths rooted at a real top-level directory. A bare
 * `acquire/` inside a prose listing of pipeline stages is not a claim about the
 * repository layout; `src/workflows/scan-service.ts` is.
 */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'docrefs-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'real.ts'), 'export const real = 1;\n');
  return dir;
}

const ROOTS = ['src'];

describe('checkReferencedPaths', () => {
  test('reports a rooted source path that does not exist', async () => {
    const root = await fixture();
    await writeFile(join(root, 'doc.md'), 'The scanner lives in `src/missing.ts` today.\n');

    const errors = await checkReferencedPaths({ root, file: 'doc.md', roots: ROOTS });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('src/missing.ts');
    expect(errors[0]).toContain('doc.md');
  });

  test('accepts a rooted source path that exists', async () => {
    const root = await fixture();
    await writeFile(join(root, 'doc.md'), 'The scanner lives in `src/real.ts` today.\n');

    expect(await checkReferencedPaths({ root, file: 'doc.md', roots: ROOTS })).toEqual([]);
  });

  test('ignores prose, commands, globs and bare identifiers', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'doc.md'),
      [
        'Run `npm run build` and then `npx tsx src/cli.ts --help`.',
        'Types live under `src/*/lib` and match `**/*.test.ts`.',
        'The function is `canonicalizeFindings` and the flag is `--fail-on`.',
        'Set `DATABASE_URL` before running.',
      ].join('\n'),
    );

    expect(await checkReferencedPaths({ root, file: 'doc.md', roots: ROOTS })).toEqual([]);
  });

  test('ignores a path not rooted at a known top-level directory', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'doc.md'),
      'The pipeline runs `acquire/`, then `sanitize/`, then `enrich/`.\n',
    );

    expect(await checkReferencedPaths({ root, file: 'doc.md', roots: ROOTS })).toEqual([]);
  });

  test('ignores site routes, which are not repository paths', async () => {
    const root = await fixture();
    await writeFile(join(root, 'doc.md'), 'The catalogue is at `/library/` and `/tags/`.\n');

    expect(await checkReferencedPaths({ root, file: 'doc.md', roots: ROOTS })).toEqual([]);
  });

  test('reports every missing path, not just the first', async () => {
    const root = await fixture();
    await writeFile(join(root, 'doc.md'), 'See `src/a.ts` and `src/b.ts` and `src/real.ts`.\n');

    const errors = await checkReferencedPaths({ root, file: 'doc.md', roots: ROOTS });

    expect(errors).toHaveLength(2);
  });

  test('ignores build output, which exists only after a build', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'doc.md'),
      'The export lands in `app/out/` and the bundle in `app/.next/static/chunks/main.js`.',
    );

    const errors = await checkReferencedPaths({
      root,
      file: 'doc.md',
      roots: ['src', 'app'],
    });

    expect(errors).toEqual([]);
  });

  test('resolves a repository-root path from a document inside a subdirectory', async () => {
    // The product lives in `community-hub/`, but the git repository root is its
    // parent, and that is where `.github/workflows/` sits. Resolving only from
    // the documentation root made the gate report a workflow that exists —
    // and the "fix" was to delete a true statement from the README and replace
    // it with a false one. A blocking gate that is confidently wrong is worse
    // than no gate.
    const outer = await mkdtemp(join(tmpdir(), 'docrefs-outer-'));
    await mkdir(join(outer, 'src'), { recursive: true });
    await writeFile(join(outer, 'src', 'outer-only.ts'), 'export const outer = 1;');
    const inner = join(outer, 'product');
    await mkdir(join(inner, 'src'), { recursive: true });
    await writeFile(join(inner, 'doc.md'), 'At the repository root: `src/outer-only.ts`.');

    expect(await checkReferencedPaths({ root: inner, file: 'doc.md', roots: ROOTS })).toHaveLength(1);
    expect(await checkReferencedPaths({
      root: inner, file: 'doc.md', roots: ROOTS, alternateRoots: [outer],
    })).toEqual([]);
  });

  test('does not look inside fenced code blocks', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'doc.md'),
      ['```bash', 'cat src/example-that-does-not-exist.ts', '```', ''].join('\n'),
    );

    expect(await checkReferencedPaths({ root, file: 'doc.md', roots: ROOTS })).toEqual([]);
  });
});
