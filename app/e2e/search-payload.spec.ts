import { firstLeanSubject } from './detail-subjects';
import { expect, test, type Page } from '@playwright/test';
import { appPath } from './app-paths';

const OBSERVATION_TIMEOUT_MS = 15_000;

async function waitForInitialSearchPayload(page: Page, dataPaths: Set<string>): Promise<void> {
  await expect.poll(
    () => dataPaths.has('search-index.json') && dataPaths.has('facets.json'),
    { timeout: OBSERVATION_TIMEOUT_MS, message: 'initial search payloads should be requested' },
  ).toBe(true);
  await page.waitForLoadState('networkidle', { timeout: OBSERVATION_TIMEOUT_MS });
  await waitForBrowserIdle(page);
}

async function waitForBrowserIdle(page: Page): Promise<void> {
  await page.evaluate((timeoutMs) => new Promise<void>((resolve) => {
    const idle = () => {
      if ('requestIdleCallback' in window) {
        const requestIdleCallback = (window as Window & {
          requestIdleCallback: (callback: () => void, options?: { timeout: number }) => number;
        }).requestIdleCallback;
        requestIdleCallback(resolve, { timeout: timeoutMs });
      } else {
        globalThis.setTimeout(resolve, 0);
      }
    };
    window.requestAnimationFrame(idle);
  }), OBSERVATION_TIMEOUT_MS);
  await page.waitForLoadState('networkidle', { timeout: OBSERVATION_TIMEOUT_MS });
}

/**
 * The build-time budget in `scripts/check-bundle-budget.mjs` can only measure
 * the artifacts it is *told* are eager. This measures what a browser actually
 * asks for, which is the claim that matters.
 *
 * `semantic-index.json` is 1.55 MB gzip, larger than the lexical index itself,
 * and it used to be fetched during warm-up on every page that imports the
 * search client — most of the 9.89 MB a visitor paid before their first
 * keystroke.
 */
test('the semantic index is not fetched until someone types', async ({ page }) => {
  const dataPaths = new Set<string>();
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/data/')) dataPaths.add(new URL(url).pathname.replace(/^.*\/data\//, ''));
  });

  await page.goto(appPath('/library/'));
  await waitForInitialSearchPayload(page, dataPaths);

  // The extended tier is fetched too, but only after the primary index is
  // answering — that is the point of the split, not a violation of it. What
  // must not appear before a keystroke is the semantic index.
  expect(dataPaths.has('search-index.json')).toBe(true);
  expect(dataPaths.has('facets.json')).toBe(true);
  expect(dataPaths.has('semantic-index.json')).toBe(false);

  await page.getByRole('combobox').first().fill('slack notification');
  await expect.poll(() => dataPaths.has('semantic-index.json'), { timeout: 15_000 }).toBe(true);
});

test('a quoted phrase does not pay for vectors it cannot use', async ({ page }) => {
  const dataPaths = new Set<string>();
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/data/')) dataPaths.add(new URL(url).pathname.replace(/^.*\/data\//, ''));
  });

  await page.goto(appPath('/library/'));
  await waitForInitialSearchPayload(page, dataPaths);
  // The worker skips the semantic path entirely for quoted phrases.
  await page.getByRole('combobox').first().fill('"exact phrase only"');
  await waitForBrowserIdle(page);

  expect(dataPaths.has('semantic-index.json')).toBe(false);
});

/**
 * A chart is one JSONL line inside a shard that runs to 16 MB. This asserts the
 * range request is real — that the shard is answered with a 206 and only the
 * chart's own bytes cross the wire. `fetchChart` gives up on a 200 rather than
 * downloading the shard to slice it, so a regression here shows up as a missing
 * diagram, not as a silent 16 MB transfer.
 */
test('a workflow chart is fetched by range, not by downloading the shard', async ({ page }) => {
  const shardResponses: Array<{ status: number; length: number }> = [];
  page.on('response', async (response) => {
    if (!/\/data\/charts\/chart-\d+\.jsonl/.test(response.url())) return;
    const length = Number(response.headers()['content-length'] ?? 0);
    shardResponses.push({ status: response.status(), length });
  });

  // A lean page, chosen by type rather than by position: only the lean page
  // defers its canvas, and the library's first result is ordered by quality,
  // not by whether Next prerendered it. See `detail-subjects.ts`.
  await page.goto(appPath(`/w/${firstLeanSubject().slug}/`));
  // The lean detail page carries no canvas; the interactive view it links to is
  // where a chart is fetched, so that is where this is measured.
  await page.getByRole('link', { name: /Open the interactive view/i }).click();
  await expect(page.getByRole('button', { name: /Explore interactive canvas/i })).toBeVisible({ timeout: 30_000 });
  expect(shardResponses).toEqual([]);
  await page.getByRole('button', { name: /Explore interactive canvas/i }).click();
  await expect(page.getByRole('group', { name: /Workflow diagram/ })).toBeVisible({ timeout: 30_000 });

  expect(shardResponses.length).toBeGreaterThan(0);
  for (const response of shardResponses) {
    expect(response.status, 'chart shards must be answered with 206 Partial Content').toBe(206);
    // Raw bytes: the e2e server sends no compression. A chart measures single-
    // digit KB; the shard it lives in is over 16 MB.
    expect(response.length).toBeLessThan(256 * 1024);
  }
});
