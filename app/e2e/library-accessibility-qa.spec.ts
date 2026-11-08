import { expect, test, type Locator, type Page } from '@playwright/test';

const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? '').replace(/\/+$/, '');
const noMatchTerm = 'no-matching-integration-9e7f';

function appPath(pathname: string): string {
  return `${basePath}${pathname}`;
}

async function openLibrary(page: Page, pathname = '/library/'): Promise<Locator> {
  await page.goto(appPath(pathname));
  const results = page.getByRole('list', { name: 'Workflow results' });
  await expect(results).toBeVisible({ timeout: 30_000 });
  return results;
}

async function openLibraryWithExtendedIndex(page: Page): Promise<Locator> {
  const extendedIndex = page.waitForResponse(
    (response) => /\/data\/search-index-extended\.json$/.test(new URL(response.url()).pathname),
    { timeout: 20_000 },
  );
  const results = await openLibrary(page);

  const headerCount = page.locator('header span').filter({ hasText: /^\d[\d,]*\s*workflows$/ });
  await expect(headerCount).toHaveCount(1);
  const fullCount = ((await headerCount.textContent()) ?? '').match(/\d[\d,]*/)?.[0];
  if (!fullCount) throw new Error('Header workflow count is missing.');

  const resultAnnouncement = page
    .locator('section[aria-labelledby="library-results-heading"] p[aria-live]')
    .filter({ hasText: /^\d[\d,]* workflows(?: of \d[\d,]*)?$/ });
  await expect(resultAnnouncement).toHaveCount(1);

  const response = await extendedIndex;
  expect(response.ok(), `extended search index response ${response.status()}`).toBe(true);
  await response.finished();
  await expect(resultAnnouncement).toHaveText(`${fullCount} workflows`, { timeout: 20_000 });
  return results;
}

async function assertNoHorizontalOverflow(page: Page, surface: string): Promise<void> {
  const measurement = await page.evaluate(() => ({
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    layoutViewport: document.documentElement.clientWidth,
    visualViewport: Math.ceil(window.visualViewport?.width ?? window.innerWidth),
  }));
  expect(measurement.documentWidth, `${surface} overflow: ${JSON.stringify(measurement)}`)
    .toBeLessThanOrEqual(measurement.layoutViewport + 1);
}

async function tabUntilFocused(page: Page, target: Locator, label: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let index = 0; index < 100; index += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`${label} was not reachable in the keyboard order.`);
}

async function hasVisibleFocusIndicator(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if ((style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0)
        || style.boxShadow !== 'none') return true;
    }
    return false;
  });
}

test('library stays within the viewport at 320px and 200% visual zoom', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await openLibrary(page);
  await assertNoHorizontalOverflow(page, 'library at 320px');

  await page.setViewportSize({ width: 640, height: 900 });
  await page.goto(appPath('/library/'));
  const zoomClient = await page.context().newCDPSession(page);
  await zoomClient.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  await expect.poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(2);
  await expect(page.getByRole('list', { name: 'Workflow results' })).toBeVisible({ timeout: 30_000 });
  await assertNoHorizontalOverflow(page, 'library at 200% visual zoom');

  // The sheet is opened by keyboard, not by `locator.click()`. At 200% visual zoom the runner
  // derives the pointer's coordinates in visual-viewport space while its actionability check
  // hit-tests in layout space, so the press is aimed at the trigger's centre halved — the page
  // header, which is the element it reports as intercepting the click — and then waits out the
  // whole test timeout. The trigger is not covered: `elementFromPoint` at its real centre returns
  // the button, and a raw `page.mouse.click()` at that real point is equally undeliverable under
  // the page scale. The two containment assertions below are unchanged; only the activation path
  // is, and it is the one a keyboard user takes.
  const filtersTrigger = page.getByRole('button', { name: 'Filters', exact: true });
  await filtersTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
  await assertNoHorizontalOverflow(page, 'library filters at 200% visual zoom');
});

test('search, filter, sort, and result controls are keyboard reachable with visible focus', async ({ page }) => {
  const results = await openLibraryWithExtendedIndex(page);
  const search = page.getByRole('combobox', { name: 'Search n8n workflows' });
  const quickFilterName = await page.getByRole('button', { name: /^Quick filter Medium\s/ }).getAttribute('aria-label');
  if (!quickFilterName) throw new Error('Quick filter accessible name is missing.');
  const quickFilter = page.getByRole('button', { name: quickFilterName, exact: true });
  const sort = page.getByRole('combobox', { name: 'Sort results' });
  const filters = page.getByRole('button', { name: 'Filters', exact: true });
  const firstResult = results.getByRole('link').first();

  for (const [label, target, focusProbe] of [
    ['search', search, search.locator('xpath=..')],
    ['quick filter', quickFilter, quickFilter],
    ['sort', sort, sort],
    ['Filters', filters, filters],
    ['first result', firstResult, firstResult],
  ] as const) {
    await tabUntilFocused(page, target, label);
    await expect(target).toBeFocused();
    expect(await hasVisibleFocusIndicator(focusProbe), `${label} has no visible focus indicator`).toBe(true);
  }
});

test('library names controls and facet groups truthfully and announces counts/statuses', async ({ page }) => {
  const results = await openLibraryWithExtendedIndex(page);
  const search = page.getByRole('combobox', { name: 'Search n8n workflows' });
  const sort = page.getByRole('combobox', { name: 'Sort results' });
  const filters = page.getByRole('button', { name: 'Filters', exact: true });
  const firstResult = results.getByRole('link').first();

  await expect(search).toHaveAccessibleName('Search n8n workflows');
  await expect(search).toHaveAttribute('aria-controls', 'search-results-list');
  await expect(search).toHaveAttribute('aria-autocomplete', 'list');
  await expect(sort).toHaveAccessibleName('Sort results');
  await expect(filters).toHaveAccessibleName('Filters');
  await expect(results).toHaveAccessibleName('Workflow results');
  const resultTitle = ((await firstResult.locator('span').first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
  expect(resultTitle, 'first result title is rendered text').not.toBe('');
  await expect(firstResult).toHaveAccessibleName(resultTitle);

  const resultCount = page.locator('p[aria-live="polite"]').filter({ hasText: /workflows/ }).first();
  await expect(resultCount).toHaveText(/^\d[\d,]* workflows(?: of \d[\d,]*)?$/);

  await filters.click();
  const dialog = page.getByRole('dialog', { name: 'Filters' });
  await expect(dialog).toBeVisible();
  for (const group of ['Rights', 'Trigger', 'Complexity', 'Security', 'Capabilities', 'Integrations', 'Tags']) {
    await expect(dialog.getByRole('group', { name: group, exact: true })).toHaveCount(1);
  }
  await expect(dialog.getByRole('textbox', { name: 'Filter integrations' })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Filter tags' })).toBeVisible();

  const integrationGroup = dialog.getByRole('group', { name: 'Integrations', exact: true });
  const firstIntegration = integrationGroup.getByRole('button').first();
  const visibleLabel = (await firstIntegration.locator('span').first().innerText()).trim();
  const visibleCount = (await firstIntegration.locator('span').nth(1).innerText()).trim();
  await expect(firstIntegration).toHaveAttribute('aria-label', `${visibleLabel} ${visibleCount}`);
  await expect(firstIntegration).toHaveAttribute('aria-pressed', /^(true|false)$/);

  await dialog.getByRole('textbox', { name: 'Filter integrations' }).fill(noMatchTerm);
  await expect(dialog.getByRole('status')).toHaveText('No matching integrations.');
});

for (const width of [320, 1440]) {
  test(`the active Filters trigger is usable by pointer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openLibrary(page, '/library/?rights=link_only');

    const trigger = page.getByRole('button', { name: /^Filters \(1: Link-only\)$/ });
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const box = await trigger.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width + 1);

    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
  });
}
