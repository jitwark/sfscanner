import { expect, test, type Page } from '@playwright/test';

// The layout is under test, not the document CSP. The dev server needs eval for
// React's development hydration and is reached through localhost, not 127.0.0.1.
test.use({ bypassCSP: true });

const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
const WIDTHS = [320, 768, 1024, 1440] as const;

type BoundsProblem = {
  card: string;
  target: string;
  detail: string;
};

async function cardProblems(page: Page): Promise<BoundsProblem[]> {
  return page.evaluate(() => {
    const list = document.getElementById('search-results-list');
    if (!list) throw new Error('#search-results-list is not rendered');
    const listRect = list.getBoundingClientRect();
    const problems: BoundsProblem[] = [];
    const add = (card: string, target: string, detail: string) => problems.push({ card, target, detail });

    if (list.scrollWidth > list.clientWidth + 1) {
      add('list', 'scrollWidth', `${list.scrollWidth} > ${list.clientWidth}`);
    }

    const rows = Array.from(list.children).filter((child) => !child.hasAttribute('aria-hidden'));
    for (const [rowIndex, row] of rows.entries()) {
      const article = row.querySelector('article');
      if (!article) continue;
      const card = article.id || `row-${rowIndex}`;
      const cardRect = article.getBoundingClientRect();
      const title = article.querySelector('a');
      const titleText = title?.querySelector('span');
      const summary = title?.parentElement?.querySelector('p');
      const chipRow = summary?.nextElementSibling;
      const metadata = article.lastElementChild;
      const metadataRows = metadata ? Array.from(metadata.querySelectorAll(':scope > p')) : [];

      if (cardRect.left < listRect.left - 1 || cardRect.right > listRect.right + 1) {
        add(card, 'article', `${cardRect.left}-${cardRect.right} outside ${listRect.left}-${listRect.right}`);
      }
      if (article.scrollWidth > article.clientWidth + 1) {
        add(card, 'article.scrollWidth', `${article.scrollWidth} > ${article.clientWidth}`);
      }

      const targets = [
        ['title', title],
        ['title.text', titleText],
        ['summary', summary],
        ['chips', chipRow],
        ['metadata', metadata],
        ...metadataRows.map((element, index) => [`metadata.row.${index}`, element] as const),
        ...(chipRow ? Array.from(chipRow.children).map((element, index) => [`chip.${index}`, element] as const) : []),
      ] as const;

      for (const [target, element] of targets) {
        if (!(element instanceof HTMLElement)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.left < cardRect.left - 1 || rect.right > cardRect.right + 1) {
          add(card, target, `${rect.left}-${rect.right} outside ${cardRect.left}-${cardRect.right}`);
        }
        if (element !== summary && element.scrollWidth > element.clientWidth + 1) {
          add(card, `${target}.scrollWidth`, `${element.scrollWidth} > ${element.clientWidth}`);
        }
      }

      const stacked = [title, summary, chipRow].filter((element): element is Element => element !== null);
      for (let index = 1; index < stacked.length; index += 1) {
        const above = stacked[index - 1]!.getBoundingClientRect();
        const below = stacked[index]!.getBoundingClientRect();
        if (below.top < above.bottom - 1) add(card, 'vertical', `${below.top} < ${above.bottom}`);
      }
    }

    const visible = rows
      .map((row) => row.getBoundingClientRect())
      .filter((rect) => rect.bottom > 0 && rect.top < innerHeight);
    for (let index = 1; index < visible.length; index += 1) {
      const above = visible[index - 1]!;
      const below = visible[index]!;
      if (below.top < above.bottom - 1) add('list', 'row overlap', `${below.top} < ${above.bottom}`);
    }

    return problems.slice(0, 20);
  });
}

async function openVirtualList(page: Page): Promise<void> {
  await page.goto(`${basePath}/library/?page=5`, { waitUntil: 'networkidle' });
  await expect(page.locator('#search-results-list')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('p', { hasText: /^Showing 120 of [\d,]+$/ })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
}

for (const width of WIDTHS) {
  test(`library cards contain children and stay unclipped at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await openVirtualList(page);

    expect(await cardProblems(page), `real cards at ${width}px`).toEqual([]);

    for (let step = 0; step < 6; step += 1) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await page.waitForTimeout(150);
      expect(await cardProblems(page), `virtualized cards at ${width}px step ${step}`).toEqual([]);
    }

    await page.evaluate(() => {
      const card = document.querySelector('#search-results-list li:not([aria-hidden]) article');
      if (!card) throw new Error('no card to stress');
      const title = card.querySelector('a span');
      const chip = card.querySelector('.flex.flex-wrap span');
      const source = card.querySelector('p:last-child span:last-child');
      if (title) title.textContent = 'UnbrokenTitle'.repeat(20);
      if (chip) chip.textContent = 'UnbrokenChipLabel'.repeat(20);
      if (source) source.textContent = `https://example.invalid/${'long-source-segment/'.repeat(12)}`;
    });
    await page.waitForTimeout(100);
    expect(await cardProblems(page), `long unbroken content at ${width}px`).toEqual([]);
  });
}

test('keyboard focus reaches the first hydrated result without clipping', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await openVirtualList(page);
  const firstResult = page.locator('#search-results-list a').first();

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let index = 0; index < 100; index += 1) {
    await page.keyboard.press('Tab');
    if (await firstResult.evaluate((element) => element === document.activeElement)) break;
  }

  await expect(firstResult).toBeFocused();
  const focus = await firstResult.evaluate((element) => {
    const list = document.getElementById('search-results-list')!;
    const item = element.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      hasIndicator: style.boxShadow !== 'none' || (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0),
      contained: item.left >= bounds.left - 1 && item.right <= bounds.right + 1,
    };
  });
  expect(focus).toEqual({ hasIndicator: true, contained: true });
  expect(await cardProblems(page), 'keyboard-focused card').toEqual([]);
});

test('library cards stay contained at 200% visual zoom', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 });
  await openVirtualList(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  await expect.poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(2);
  await page.waitForTimeout(200);

  expect(await cardProblems(page), 'library cards at 200% zoom').toEqual([]);
});
