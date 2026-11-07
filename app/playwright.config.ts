import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { assertExportComplete } from './e2e/export-precondition';

const remoteBaseUrl = process.env.PLAYWRIGHT_BASE_URL?.trim();
const baseURL = remoteBaseUrl || 'http://127.0.0.1:3210';
// Playwright loads this config as CommonJS, where `import.meta` is a syntax
// error — so resolve from `__dirname`, not `import.meta.dirname`. The config
// is at `app/`, so `app/out` is the export under test.
const outDir = resolve(__dirname, 'out');

export default defineConfig({
  testDir: './e2e',
  // Playwright's default testMatch also globs `*.test.ts`, so a Vitest test living
  // beside the specs gets loaded by Playwright as CommonJS and dies on `import.meta`.
  // Every Playwright spec here is `.spec.ts`; scope to that so the two runners cannot
  // collect each other's files.
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    // The lean-page download test drives a real Blob download, so the browser
    // context must accept downloads. `downloadsPath` is not a test-runner
    // option — it only exists on `browser.newContext` — so do not add it here.
    acceptDownloads: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  ...(remoteBaseUrl
    ? {}
    : (() => {
        // Serve the already-built `out/` — never build it here. This config
        // used to run `npx next build && node e2e/static-server.mjs 3210` by
        // default, but `next build` alone is the Next build only: it skips
        // `npm run build:lean-pages` and silently replaces the complete
        // static export with one missing ~12,971 lean workflow pages,
        // whether Playwright was launched through `npm run test:e2e` or
        // directly. See `docs/audit/2026-09-01/remediation/CHANGELOG.md`,
        // "Process finding, 2026-09-01".
        //
        // Measuring scanner jank against `next dev` measures the dev server,
        // not the product, so this still refuses to fall back to it — the
        // fix for a missing/incomplete export is `npm run build`, surfaced
        // below as a clear, named failure instead of a rebuild nobody asked
        // for and a wave of confusing per-spec assertion failures.
        assertExportComplete(outDir);
        return {
          webServer: {
            command: 'node e2e/static-server.mjs 3210',
            url: 'http://127.0.0.1:3210',
            reuseExistingServer: !process.env.CI,
            timeout: 180 * 1000,
          },
        };
      })()),
});
