import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Serve the real emitted shard bytes, not a synthesized line: the client
 * validates the body against the page entry's own `chartRef` offset/length and
 * the manifest's `byteSize`, so a synthetic line always reports
 * `short-body`/`range-mismatch`.
 *
 * The page is opened with `?layout=default` because that is where `ChartLoader`
 * is mounted. The prerendered route's `initialLayout="workbench"` renders the
 * static vector preview instead (`layout-workbench.tsx`), so a run without the
 * parameter never mounts the reader and the test would be asserting the absence
 * of a control rather than the reader's range handling.
 */
const out = path.resolve(__dirname, '..', 'out');
const dataDir = path.join(out, 'data');
const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? '').replace(/\/+$/, '');

function chartSubject(): { slug: string } {
  // `catalogue-N.json` is deliberately pruned from the export, so the subject comes
  // from `details/detail-N.jsonl` — the byte-addressed shard pair the build now
  // emits for the browser in its place, carrying the same `slug`, `isPrerendered`
  // and `chartRef` fields.
  const detailsDir = path.join(dataDir, 'details');
  const detailShards = fs.readdirSync(detailsDir).filter((file) => /^detail-\d+\.jsonl$/.test(file)).sort();
  for (const name of detailShards) {
    for (const line of fs.readFileSync(path.join(detailsDir, name), 'utf8').split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line) as {
        slug: string;
        isPrerendered?: boolean;
        chartRef?: { shard: number };
      };
      if (entry.isPrerendered === true && entry.chartRef?.shard === 0) return { slug: entry.slug };
    }
  }
  throw new Error('no prerendered entry with a chartRef for shard 0 in the export');
}

const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8')) as {
  artifacts: Array<{ path: string; byteSize: number }>;
};
const artifact = manifest.artifacts.find((candidate) => candidate.path === 'charts/chart-0.jsonl');
if (!artifact) throw new Error('no charts/chart-0.jsonl declared in the manifest');
const shardBytes = fs.readFileSync(path.join(dataDir, 'charts', 'chart-0.jsonl'));

function rangeOf(header: string | undefined): [number, number] | null {
  const match = /bytes=(\d+)-(\d+)/.exec(header ?? '');
  return match ? [Number(match[1]), Number(match[2])] : null;
}

test('interactive chart renders the real emitted byte range', async ({ page }) => {
  const subject = chartSubject();
  await page.route('**/data/charts/chart-*.jsonl', async (route) => {
    const range = rangeOf(route.request().headers()['range']);
    if (!range) return route.abort();
    const [start, end] = range;
    return route.fulfill({
      status: 206,
      body: shardBytes.subarray(start, end + 1),
      headers: { 'content-range': `bytes ${start}-${end}/${artifact.byteSize}` },
    });
  });

  await page.goto(`${basePath}/w/${subject.slug}/?layout=default`);
  await page.getByRole('button', { name: /explore interactive canvas/i }).click();
  await expect(page.locator('[data-interactive-canvas] canvas, [data-interactive-canvas] svg').first()).toBeVisible({ timeout: 20_000 });
});

test('a range outside the declared shard fails with the release identity and no canvas', async ({ page }) => {
  const subject = chartSubject();
  await page.route('**/data/charts/chart-*.jsonl', async (route) => {
    const range = rangeOf(route.request().headers()['range']);
    if (!range) return route.abort();
    const [start, end] = range;
    return route.fulfill({
      status: 206,
      body: shardBytes.subarray(start, end + 1),
      // One byte more than the manifest declares: the client must reject it.
      headers: { 'content-range': `bytes ${start}-${end}/${artifact.byteSize + 1}` },
    });
  });

  await page.goto(`${basePath}/w/${subject.slug}/?layout=default`);
  await page.getByRole('button', { name: /explore interactive canvas/i }).click();
  await expect(page.getByText(/integrity check/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/^Release /)).toBeVisible();
  await expect(page.locator('[data-interactive-canvas]')).toHaveCount(0);
});
