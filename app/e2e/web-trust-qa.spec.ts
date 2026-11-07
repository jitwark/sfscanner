import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * W-010 independent browser verification: artifact identity plus the trust
 * journey, at the four widths W-008 names.
 *
 * This spec is export-only by design. `out/` is the artifact a visitor is
 * served, so the identity half compares disk bytes with served bytes and with
 * the manifest's own `sha256`; a dev server has none of those files and would
 * make the identity checks meaningless. The DEV-surface proof (four widths,
 * dialog keyboard, scanner, chart, links) is a separate browser run recorded in
 * `127`, because B-03/B-07 block a fresh export.
 *
 * `123` §3 is why worker discovery is not a filename filter: no chunk filename
 * contains "worker". A `new Worker(...)` call names its entry chunk through
 * `.u(<id>)`, the entry's runtime names what it loads through `.O(..., [ids])`,
 * and the resulting set must contain a chunk that registers a message listener.
 */
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'malicious.json'), 'utf8');
const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? '').replace(/\/+$/, '');
const root = path.join(__dirname, '..', '..');
const out = path.join(__dirname, '..', 'out');
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type ManifestArtifact = { path: string; byteSize: number; sha256: string };
type Manifest = { generatedAt: string; artifacts: ManifestArtifact[] };
const manifest = JSON.parse(fs.readFileSync(path.join(out, 'data', 'manifest.json'), 'utf8')) as Manifest;

// W-010.4 identity: every declared artifact on disk, plus disk+served for what the journey touches.
const artifactHashes = Object.fromEntries(
  manifest.artifacts.map((artifact) => [artifact.path, digest(path.join(out, 'data', artifact.path))]),
);

const chunksDir = path.join(out, '_next', 'static', 'chunks');
const chunkFiles: string[] = [];
const collectChunks = (dir: string, prefix: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) collectChunks(path.join(dir, entry.name), `${prefix}${entry.name}/`);
    else if (entry.name.endsWith('.js')) chunkFiles.push(`${prefix}${entry.name}`);
  }
};
collectChunks(chunksDir, '');
const chunkSource = (relative: string) => fs.readFileSync(path.join(chunksDir, relative), 'utf8');
const chunksById = new Map(
  chunkFiles
    .map((relative) => [path.basename(relative).match(/^(\d+)\.[0-9a-f]+\.js$/)?.[1], relative] as const)
    .filter((entry): entry is readonly [string, string] => entry[0] !== undefined),
);
const workerChunks = (() => {
  const pending = chunkFiles
    .filter((relative) => chunkSource(relative).includes('new Worker'))
    .flatMap((relative) => [...chunkSource(relative).matchAll(/\.u\((\d+)\)/g)])
    .map((match) => chunksById.get(match[1] ?? ''))
    .filter((relative): relative is string => relative !== undefined);
  if (!pending.length) throw new Error('no chunk resolves a worker from a new Worker() call');
  const seen = new Set<string>();
  while (pending.length) {
    const relative = pending.pop() as string;
    if (seen.has(relative)) continue;
    seen.add(relative);
    for (const [, ids] of chunkSource(relative).matchAll(/\.O\([^)]*?\[([\d,\s]+)\]/g)) {
      for (const id of (ids ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
        const next = chunksById.get(id);
        if (next !== undefined) pending.push(next);
      }
    }
  }
  return [...seen];
})();
if (!workerChunks.some((relative) => chunkSource(relative).includes('addEventListener("message"'))) {
  throw new Error('no discovered worker chunk registers a message listener');
}

const chartPath = manifest.artifacts.find((artifact) => /^charts\//.test(artifact.path))?.path;
if (!chartPath) throw new Error('no chart artifact declared in the manifest');
// `artifact.path` is relative to `out/data/`, which is why the disk path and the
// served path both insert `data/` — the manifest is not rooted at the export.
const servedPaths = [
  'index.html',
  'scanner/index.html',
  'data/manifest.json',
  `data/${chartPath}`,
  ...workerChunks.map((relative) => `_next/static/chunks/${relative}`),
];

const qaSlug = process.env.QA_SLUG;
// The journey MUST include one prerendered detail page (W-010); a 3-route run is not the journey.
if (!qaSlug) throw new Error('QA_SLUG is required: the trust journey must include a prerendered detail page');
const routes = ['/', '/library/', '/scanner/', `/w/${qaSlug}/`];
const widths = [320, 768, 1024, 1440];

for (const width of widths) {
  test(`trust journey ${width}`, async ({ page }, testInfo) => {
    // Real candidate identity, emitted per run. No placeholder origin becomes candidate identity.
    testInfo.annotations.push(
      { type: 'candidate-head', description: git('rev-parse', 'HEAD') },
      { type: 'candidate-branch', description: git('rev-parse', '--abbrev-ref', 'HEAD') },
      { type: 'candidate-status', description: git('status', '--short') },
      {
        type: 'candidate-env',
        description: JSON.stringify({
          siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
          basePath: process.env.NEXT_PUBLIC_BASE_PATH,
        }),
      },
      { type: 'candidate-build-time', description: fs.statSync(path.join(out, 'index.html')).mtime.toISOString() },
      { type: 'candidate-manifest-generatedAt', description: String(manifest.generatedAt) },
      {
        type: 'candidate-hashes',
        description: JSON.stringify({
          disk: Object.fromEntries(servedPaths.map((relative) => [relative, digest(path.join(out, relative))])),
          artifacts: artifactHashes,
        }),
      },
      { type: 'candidate-worker-chunks', description: JSON.stringify(workerChunks) },
    );

    const served = Object.fromEntries(
      await Promise.all(
        servedPaths.map(async (relative) => {
          const response = await page.request.get(`${basePath}/${relative}`);
          expect(response.ok()).toBe(true);
          return [relative, sha(await response.body())];
        }),
      ),
    );
    testInfo.annotations.push({ type: 'candidate-served-hashes', description: JSON.stringify(served) });
    for (const relative of servedPaths) {
      expect(served[relative], `${relative} served bytes must equal disk bytes`).toBe(
        digest(path.join(out, relative)),
      );
    }

    const consoleErrors: string[] = [];
    const requests: Array<{ url: string; method: string; postData: string | null; headers: Record<string, string> }> = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('request', (request) =>
      requests.push({ url: request.url(), method: request.method(), postData: request.postData(), headers: request.headers() }),
    );

    await page.setViewportSize({ width, height: 900 });
    for (const route of routes) {
      await page.goto(`${basePath}${route}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`${width}-${route.replaceAll('/', '_') || 'home'}.png`),
        fullPage: true,
      });
    }

    await page.goto(`${basePath}/scanner/`);
    // Truthful window: everything so far is the derived route navigation plus the scanner boot.
    const preScanRequests = requests.length;
    const scanStart = requests.length;
    await page.getByLabel('Workflow JSON').evaluate((element, text) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, fixture);
    await page.getByRole('button', { name: 'Scan workflow' }).click();
    await expect(page.getByRole('heading', { name: 'Analysis coverage' })).toBeVisible({ timeout: 15_000 });
    const scanRequests = requests.slice(scanStart);
    testInfo.annotations.push({
      type: 'pre-scan-requests',
      description: `${routes.length} routes + scanner boot: ${preScanRequests}`,
    });
    testInfo.annotations.push({ type: 'scan-requests', description: String(scanRequests.length) });
    for (const request of scanRequests) {
      const url = new URL(request.url);
      expect(['127.0.0.1', 'localhost'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol)).toBe(true);
      expect(['GET', 'HEAD']).toContain(request.method);
      expect(JSON.stringify(request)).not.toContain('sk_live_12345678901234567890');
    }
    expect(consoleErrors).toEqual([]);
  });
}

/** W-008.2: keyboard open, focus inside, Escape close, focus restored. */
test('diagram dialog keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(`${basePath}/w/${qaSlug}/`);
  const opener = page.getByRole('button', { name: 'Expand diagram' });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: /Close/ })).toBeFocused();
  expect(await page.evaluate(() => Boolean(document.querySelector('dialog')?.contains(document.activeElement)))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(opener).toBeFocused();
});
