import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * The single source for "is `app/out` a complete static export?", used by
 * `playwright.config.ts` before any spec runs.
 *
 * It lives here, in TypeScript inside the app workspace, rather than in
 * `scripts/run-e2e.mjs`, for a mechanical reason worth recording: Playwright
 * loads its config as CommonJS, so the config can use neither `import.meta`
 * nor an `.mjs` sibling. An earlier attempt did both and broke the entire E2E
 * gate — the config was never exercised during that change because running
 * Playwright was (correctly) forbidden while the export was live.
 *
 * Duplicating the logic into the config would have reintroduced exactly the
 * drift this project keeps paying for, so there is one implementation and the
 * config imports it.
 */

/**
 * A complete export currently has ~12,971 lean pages; a Next-only build has 0.
 * The floor sits far below the real count, so ordinary corpus growth or pruning
 * never trips it, and far above zero, so the one failure mode this exists to
 * catch is caught with a wide margin — without pinning a brittle exact number.
 */
export const MIN_LEAN_PAGES = 2000;

/**
 * Counts `/w/<slug>/` directories written by the lean-page generator. A page
 * from Next's own static export carries an `index.txt` RSC sidecar; a lean page
 * never does — the same discriminator `scripts/check-page-parity.mjs` uses.
 */
export function countLeanPages(outDir: string): number {
  const detailDir = path.join(outDir, 'w');
  if (!existsSync(detailDir)) return 0;
  let count = 0;
  for (const entry of readdirSync(detailDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !existsSync(path.join(detailDir, entry.name, 'index.txt'))) count += 1;
  }
  return count;
}

/**
 * Returns a problem description naming the fix when `outDir` is not a complete
 * export, or `null` when it is safe to serve. Only reads — never builds.
 */
export function describeIncompleteExport(outDir: string): string | null {
  if (!existsSync(outDir)) {
    return '[e2e] app/out is missing — there is no static export to serve. Playwright never builds it '
      + 'for you (a bare `next build` would silently delete the lean workflow pages a full build '
      + 'generates). Fix: run `npm run build` from the repo root, then re-run Playwright.';
  }
  const leanPages = countLeanPages(outDir);
  if (leanPages < MIN_LEAN_PAGES) {
    return `[e2e] app/out has only ${leanPages} lean workflow page(s) under app/out/w — a complete export `
      + `has thousands (floor: ${MIN_LEAN_PAGES}). This is the signature of a Next-only build `
      + '(`npx next build` without `npm run build:lean-pages`), which silently replaces the complete '
      + 'static export and deletes every lean page. Fix: run `npm run build` from the repo root, then '
      + 're-run Playwright (or use `npm run test:e2e`, which serves the existing export and never builds).';
  }
  return null;
}

/** Throws `describeIncompleteExport`'s message when `outDir` is not a complete export. */
export function assertExportComplete(outDir: string): void {
  const problem = describeIncompleteExport(outDir);
  if (problem) throw new Error(problem);
}
