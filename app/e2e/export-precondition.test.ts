import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MIN_LEAN_PAGES,
  assertExportComplete,
  countLeanPages,
  describeIncompleteExport,
} from './export-precondition';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Builds a fake export: `lean` pages without an RSC sidecar, `next` pages with one. */
function fakeExport(lean: number, next = 0): string {
  const root = mkdtempSync(path.join(tmpdir(), 'export-precondition-'));
  made.push(root);
  const detail = path.join(root, 'w');
  mkdirSync(detail, { recursive: true });
  for (let i = 0; i < lean; i += 1) {
    const dir = path.join(detail, `lean-${i}`);
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  }
  for (let i = 0; i < next; i += 1) {
    const dir = path.join(detail, `next-${i}`);
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'index.html'), '<html></html>');
    writeFileSync(path.join(dir, 'index.txt'), 'rsc');
  }
  return root;
}

describe('export precondition', () => {
  it('counts only lean pages, ignoring Next pages with an RSC sidecar', () => {
    expect(countLeanPages(fakeExport(3, 2))).toBe(3);
  });

  it('reports zero when the detail directory does not exist', () => {
    expect(countLeanPages(fakeExport(0))).toBe(0);
  });

  it('names `npm run build` when the export is missing entirely', () => {
    const problem = describeIncompleteExport(path.join(tmpdir(), 'export-precondition-absent'));
    expect(problem).toMatch(/app\/out is missing/);
    expect(problem).toMatch(/npm run build/);
  });

  it('recognises a Next-only build — the exact failure this exists to catch', () => {
    // `npx next build` without `build:lean-pages` leaves zero lean pages.
    const problem = describeIncompleteExport(fakeExport(0, 40));
    expect(problem).toMatch(/only 0 lean workflow page/);
    expect(problem).toMatch(/next build/);
    expect(problem).toMatch(/npm run build/);
  });

  it('accepts an export exactly at the floor', () => {
    expect(describeIncompleteExport(fakeExport(MIN_LEAN_PAGES))).toBeNull();
  });

  it('rejects an export one page below the floor', () => {
    expect(describeIncompleteExport(fakeExport(MIN_LEAN_PAGES - 1))).not.toBeNull();
  });

  it('throws for an incomplete export and stays silent for a complete one', () => {
    expect(() => assertExportComplete(fakeExport(0, 10))).toThrow(/npm run build/);
    expect(() => assertExportComplete(fakeExport(MIN_LEAN_PAGES))).not.toThrow();
  });
});

/**
 * The precondition broke the entire E2E gate once by being unloadable rather than
 * wrong: `playwright.config.ts` is loaded as CommonJS, so `import.meta` is a
 * syntax error there and an `.mjs` sibling cannot be imported at all. Neither
 * fault was catchable by unit tests, because the config itself was never loaded
 * while Playwright was (correctly) forbidden.
 *
 * These assertions are cheap insurance against reintroducing either.
 */
describe('playwright config loadability', () => {
  const config = path.resolve(import.meta.dirname, '..', 'playwright.config.ts');

  /**
   * Strip comments first. A comment cannot cause a syntax error, and the config
   * legitimately *documents* both hazards by name — asserting on raw text would
   * fail on the very explanation that prevents the mistake.
   */
  async function configCode(): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    return (await readFile(config, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('never uses import.meta, which is a syntax error under CJS config loading', async () => {
    expect(await configCode()).not.toMatch(/import\.meta/);
  });

  it('never imports an .mjs module, which the CJS config loader cannot resolve', async () => {
    expect(await configCode()).not.toMatch(/from\s+['"][^'"]+\.mjs['"]/);
  });
});
