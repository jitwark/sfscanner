import { expect, test } from '@playwright/test';
import { appPath } from './app-paths';

const widths = [320, 768, 1024, 1440];

for (const width of widths) {
  test(`search result navigation retains state at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(appPath('/library/'));

    const search = page.getByRole('combobox', { name: 'Search n8n workflows' });
    await search.fill('slack');
    await expect(page.getByRole('list', { name: 'Workflow results' }).getByRole('link').first()).toBeVisible({ timeout: 30_000 });

    const first = page.getByRole('list', { name: 'Workflow results' }).getByRole('link').first();
    await first.click();
    await expect(page).toHaveURL(/\/w\/[^?]+\//, { timeout: 30_000 });
    await expect(page.locator('h1')).toHaveCount(1);
    await page.goBack();

    await expect(search).toHaveValue('slack');
    await expect(page.getByRole('list', { name: 'Workflow results' }).getByRole('link').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Ranked by relevance/)).toBeVisible();
  });
}

test('sort, facet clear, and no-result recovery preserve accessible controls', async ({ page }) => {
  await page.goto(appPath('/library/'));

  const search = page.getByRole('combobox', { name: 'Search n8n workflows' });
  const sort = page.getByRole('combobox', { name: 'Sort results' });
  await sort.selectOption('quality');
  await expect(sort).toHaveValue('quality');
  await expect(page).toHaveURL(/sort=quality/);

  const quickFilter = page.getByRole('button', { name: /^Quick filter / }).first();
  await expect(quickFilter).toBeVisible();
  await quickFilter.click();
  await expect(page).toHaveURL(/(?:integration|tag)=/);
  await expect(page.getByRole('button', { name: 'Clear filters', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page).not.toHaveURL(/(?:integration|tag)=/);
  await expect(page.getByRole('list', { name: 'Workflow results' }).getByRole('link').first()).toBeVisible({ timeout: 30_000 });

  await page.goto(appPath('/library/?q=query-that-cannot-match-any-current-workflow-9e7f'));
  const emptySearch = page.getByRole('combobox', { name: 'Search n8n workflows' });
  await expect(page.getByText(/No workflows match/)).toBeVisible({ timeout: 30_000 });
  await emptySearch.press('Escape');
  await expect(emptySearch).toHaveValue('');
  await expect(page.getByRole('list', { name: 'Workflow results' }).getByRole('link').first()).toBeVisible({ timeout: 30_000 });

  await search.focus();
  await page.keyboard.press('ArrowDown');
  await expect(search).toHaveAttribute('aria-activedescendant', /result-/);
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible();
});

test('semantic enhancement preserves the keyboard-active result', async ({ page }) => {
  const dataPaths = new Set<string>();
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/data/')) dataPaths.add(new URL(url).pathname.replace(/^.*\/data\//, ''));
  });

  await page.goto(appPath('/library/'));
  const search = page.getByRole('combobox', { name: 'Search n8n workflows' });
  await search.fill('slack notification');
  const results = page.getByRole('list', { name: 'Workflow results' });
  await expect(results.getByRole('link').first()).toBeVisible({ timeout: 30_000 });

  await search.focus();
  await search.press('ArrowDown');
  await expect(search).toHaveAttribute('aria-activedescendant', /result-/);
  const activeBefore = await search.getAttribute('aria-activedescendant');
  await expect.poll(() => dataPaths.has('semantic-index.json'), { timeout: 15_000 }).toBe(true);
  await expect(search).toHaveAttribute('aria-activedescendant', activeBefore ?? /result-/);
});

test('restores loaded result depth from the URL after a reload', async ({ page }) => {
  await page.goto(appPath('/library/'));

  const results = page.getByRole('list', { name: 'Workflow results' });
  const resultLinks = results.getByRole('link');
  await expect(resultLinks).toHaveCount(24, { timeout: 30_000 });
  const firstPageHrefs = await resultLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href')));

  await page.getByRole('button', { name: 'Load more workflows' }).click();
  await expect(resultLinks).toHaveCount(48, { timeout: 30_000 });
  await expect(page.getByText(/^Showing 48 of [\d,]+$/)).toBeVisible();

  const initialUrl = new URL(page.url());
  expect(initialUrl.pathname).toBe(appPath('/library/'));
  expect(initialUrl.searchParams.get('page')).toBe('2');
  const loadedHrefs = await resultLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  expect(loadedHrefs.slice(0, 24)).toEqual(firstPageHrefs);
  expect(new Set(loadedHrefs).size).toBe(48);

  await page.reload();

  await expect(resultLinks).toHaveCount(48, { timeout: 30_000 });
  await expect(page.getByText(/^Showing 48 of [\d,]+$/)).toBeVisible();
  const reloadedHrefs = await resultLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  expect(reloadedHrefs).toEqual(loadedHrefs);
  const reloadedUrl = new URL(page.url());
  expect(reloadedUrl.searchParams.get('page')).toBe('2');
});

test('restores loaded result depth when browser history returns to a paginated state', async ({ page }) => {
  await page.goto(appPath('/library/'));

  const results = page.getByRole('list', { name: 'Workflow results' });
  const resultLinks = results.getByRole('link');
  await expect(resultLinks).toHaveCount(24, { timeout: 30_000 });

  await page.getByRole('button', { name: 'Load more workflows' }).click();
  await expect(resultLinks).toHaveCount(48, { timeout: 30_000 });
  await expect(page).toHaveURL(/page=2/);

  await page.getByRole('combobox', { name: 'Sort results' }).selectOption('quality');
  await expect(page).toHaveURL(/sort=quality/);

  await page.goBack();
  await expect(page).toHaveURL(/page=2/);
  await expect(resultLinks).toHaveCount(48, { timeout: 30_000 });
  await expect(page.getByText(/^Showing 48 of [\d,]+$/)).toBeVisible();
});
