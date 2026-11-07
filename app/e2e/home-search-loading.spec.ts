import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { appPath } from './app-paths';

const SEARCH_ARTIFACT = /\/data\/(?:manifest\.json|facets\.json|search-index(?:-extended)?\.json|semantic-index\.json)$/;
const PRIMARY_INDEX = /\/data\/search-index\.json$/;
const SEARCH_CLIENT_CHUNKS = (() => {
  const manifestPath = resolve(__dirname, '..', '.next', 'react-loadable-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, { files?: string[] }>;
  const entry = Object.entries(manifest).find(([key]) => /home-search\.tsx\s*->\s*\.\.\/search\/search-client$/i.test(key));
  const files = entry?.[1].files?.filter((file) => file.endsWith('.js')) ?? [];
  if (!files.length) throw new Error('Search client chunk is missing from react-loadable-manifest.json');
  return files.map((file) => `/_next/${file.replace(/^\/+/, '')}`);
})();

test('homepage keeps search artifacts cold until focus and reuses the warm load', async ({ page }) => {
  const searchRequests: string[] = [];
  const searchClientChunkRequests: string[] = [];
  let primaryIndexRequests = 0;
  let notifyPrimaryIndexRequest!: () => void;
  let releasePrimaryIndex!: () => void;
  const primaryIndexRequested = new Promise<void>((resolve) => { notifyPrimaryIndexRequest = resolve; });
  const primaryIndexGate = new Promise<void>((resolve) => { releasePrimaryIndex = resolve; });
  await page.route('**/data/search-index.json', async (route) => {
    primaryIndexRequests += 1;
    notifyPrimaryIndexRequest();
    await primaryIndexGate;
    await route.continue();
  });
  try {
    page.on('request', (request) => {
      const url = request.url();
      const pathname = new URL(url).pathname;
      if (SEARCH_ARTIFACT.test(pathname)) searchRequests.push(url);
      if (SEARCH_CLIENT_CHUNKS.some((chunkPath) => pathname.endsWith(chunkPath))) searchClientChunkRequests.push(url);
    });

    await page.goto(appPath('/'));
    const search = page.getByRole('combobox');
    await expect(search).toBeVisible();
    await page.waitForTimeout(3_500);
    expect(searchRequests).toEqual([]);
    expect(searchClientChunkRequests).toEqual([]);

    const defaultViewport = page.viewportSize() ?? { width: 1280, height: 720 };
    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.setViewportSize(defaultViewport);
    expect(searchRequests).toEqual([]);
    expect(searchClientChunkRequests).toEqual([]);

    const footer = page.getByRole('contentinfo');
    await footer.scrollIntoViewIfNeeded();
    const footerLibraryLink = footer.getByRole('link', { name: 'Library' });
    await footerLibraryLink.scrollIntoViewIfNeeded();
    await expect(footerLibraryLink).toBeInViewport();
    await page.waitForTimeout(3_500);
    expect(searchRequests).toEqual([]);
    expect(searchClientChunkRequests).toEqual([]);

    await search.focus();
    await expect.poll(() => searchClientChunkRequests.length).toBeGreaterThan(0);
    await primaryIndexRequested;
    expect(searchClientChunkRequests.length).toBeGreaterThan(0);
    expect(searchRequests.filter((url) => PRIMARY_INDEX.test(new URL(url).pathname))).toHaveLength(1);
    await search.fill('slack');
    await expect(page.getByRole('status')).toHaveText('Loading suggestions…');
    releasePrimaryIndex();
    await expect(page.getByRole('option').first()).toBeVisible();
    expect(primaryIndexRequests).toBe(1);
    expect(searchRequests.filter((url) => PRIMARY_INDEX.test(new URL(url).pathname))).toHaveLength(1);
  } finally {
    releasePrimaryIndex();
  }
});
