import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
const baseURL = process.env.PLAYWRIGHT_BASE_URL?.trim() || 'http://127.0.0.1:3210';

function appPath(pathname: string): string {
  return `${basePath}${pathname}`;
}

function firstPrerenderedSlug(): string {
  const dataDir = path.resolve(__dirname, '..', 'public', 'data');
  const shards = fs.readdirSync(dataDir)
    .filter((name) => /^catalogue-\d+\.json$/.test(name))
    .sort((left, right) => Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]));
  for (const shard of shards) {
    const entries = JSON.parse(fs.readFileSync(path.join(dataDir, shard), 'utf8')) as Array<{
      id: string;
      slug: string;
      isPrerendered?: boolean;
    }>;
    const entry = entries
      .filter((candidate) => candidate.isPrerendered === true)
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)[0];
    if (entry) return entry.slug;
  }
  throw new Error(`No prerendered catalogue entries found in ${dataDir}`);
}

function captureBrowserErrors(page: Page): { pageErrors: string[]; hydrationErrors: string[] } {
  const pageErrors: string[] = [];
  const hydrationErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydration|hydrating|server rendered html|didn't match/i.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });
  return { pageErrors, hydrationErrors };
}

test('library deep links hydrate without page errors and restore queries through history', async ({ page }) => {
  const errors = captureBrowserErrors(page);
  await page.goto(appPath('/library/?q=slack'));
  const search = page.getByRole('combobox', { name: 'Search n8n workflows' });
  const results = page.getByRole('list', { name: 'Workflow results' });

  await expect(search).toHaveValue('slack');
  await expect(results.getByRole('link').first()).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(search).toHaveValue('slack');
  await expect(results.getByRole('link').first()).toBeVisible({ timeout: 30_000 });

  await page.goto(appPath('/library/'));
  await search.fill('slack');
  await page.getByRole('combobox', { name: 'Sort results' }).selectOption('quality');
  await expect(page).toHaveURL(/q=slack/);
  await search.fill('query-that-cannot-match-any-current-workflow-9e7f');
  await expect(page.getByText(/No workflows match/)).toBeVisible({ timeout: 30_000 });

  await page.goBack();
  await expect(search).toHaveValue('slack');
  await expect(results.getByRole('link').first()).toBeVisible({ timeout: 30_000 });
  await page.goForward();
  await expect(search).toHaveValue('query-that-cannot-match-any-current-workflow-9e7f');
  await expect(page.getByText(/No workflows match/)).toBeVisible();

  expect(errors.pageErrors).toEqual([]);
  expect(errors.hydrationErrors).toEqual([]);
});

test('layout=default keeps the exported workbench tree until hydration applies the override', async ({ browser, page }) => {
  const slug = firstPrerenderedSlug();
  const path = appPath(`/w/${slug}/?layout=default`);
  const staticContext = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const staticPage = await staticContext.newPage();
  await staticPage.goto(path);
  await expect(staticPage.locator('[data-layout="workbench"]')).toBeVisible();
  await staticContext.close();

  const errors = captureBrowserErrors(page);
  await page.goto(path);
  await expect(page.getByRole('navigation', { name: 'Workflow sections' })).toBeVisible();
  expect(errors.pageErrors).toEqual([]);
  expect(errors.hydrationErrors).toEqual([]);
});

test('static library markup is independent of the query string before JavaScript runs', async ({ browser }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(appPath('/library/'));
  const defaultTree = await page.locator('main').innerHTML();
  await page.goto(appPath('/library/?q=slack'));
  expect(await page.locator('main').innerHTML()).toBe(defaultTree);
  await context.close();
});
