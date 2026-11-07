import { expect, test, type Page } from '@playwright/test';

/**
 * FE-03 (4.3d): the virtualizer follows the rows' measured geometry.
 *
 * The committed spec next door pins the card, the deferred-row placeholder and
 * the list's structure. This one proves the thing a fixed unit cannot: that the
 * space the list occupies is the space its rows actually occupy.
 *
 * A result row is 140.6-333.8px — the card's `min-h-[92px]` is its *content
 * box*, not its pitch — so a list that spaces skipped rows with one constant is
 * short by (real - constant) on every row it skips. Measured here by walking the
 * list until a hundred rows have passed through the viewport, recording what the
 * browser laid each row out at, and then holding the list's own box to the sum
 * of what was recorded:
 *
 *   list height == Σ measured row heights + (rows never rendered) × the floor
 *
 * which is red by tens of thousands of pixels against the previous 92px unit.
 * Walking is what makes this falsifiable: the heights come out of the DOM, never
 * out of the source.
 *
 * The walk stays clear of the end of the list, so the "load more" sentinel below
 * it never appends a page underneath the measurement.
 */

const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

/** The smallest pitch a row can have: 92 content box + py-3 (24) + divider (1). */
const ROW_PITCH_FLOOR = 117;
/** `page * PAGE_SIZE` rows land in one response: 120, past the 100-row threshold. */
const VIRTUAL_PAGE = 5;
const VIEWPORT_HEIGHT = 900;
/** Shorter than the viewport, so no row is stepped over without being on screen. */
const SCROLL_STEP = 600;
/** Rows walked before the assertions run. */
const TRAVERSED_ROWS = 100;
const MAX_STEPS = 120;
/**
 * Subpixel slack per row of accumulated layout rounding, plus room for a row the
 * browser re-lays-out once (a webfont arriving changes a two-line summary). The
 * failure this is meant to catch is per-row and two orders of magnitude larger:
 * a 92px unit in a list of 223-389px rows took 16,266px off one row's offset.
 */
const PER_ROW_TOLERANCE = 1;
/** Slack per row allowed when a region is re-entered, where re-layout is legitimate. */
const RE_ENTRY_TOLERANCE = 1;
const ROW_TOLERANCE = 2;
const WIDTHS = [320, 768, 1024, 1440] as const;

type RowSample = {
  key: string;
  /** Distance from the top of the list to the top of the row. */
  offset: number;
  /** The row's pitch as the browser laid it out. */
  height: number;
  /** The row box is not clipping its own content. */
  overflow: number;
  /** Inside the viewport. */
  visible: boolean;
};

type ListSample = {
  listTop: number;
  listHeight: number;
  rows: RowSample[];
  /** Distance from the viewport bottom to the end of the list. */
  distanceToEnd: number;
  viewportHeight: number;
  scrollOffset: number;
  loaded: number;
};

/** Reads the layout facts back out of the served DOM, never out of the source. */
async function sampleList(page: Page): Promise<ListSample> {
  return page.evaluate(() => {
    const list = document.getElementById('search-results-list');
    if (!list) throw new Error('#search-results-list is not rendered');
    const listRect = list.getBoundingClientRect();
    const listTop = listRect.top + window.scrollY;
    const viewportBottom = window.scrollY + window.innerHeight;
    const rows = Array.from(list.children)
      .filter((child) => !child.hasAttribute('aria-hidden'))
      .map((child) => {
        const article = child.querySelector('article') as HTMLElement | null;
        if (!article) throw new Error('a result row rendered without its card');
        const rect = child.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        return {
          key: article.id,
          offset: top - listTop,
          height: rect.height,
          overflow: article.scrollHeight - article.clientHeight,
          visible: top < viewportBottom && top + rect.height > window.scrollY,
        };
      });
    const showing = Array.from(document.querySelectorAll('p'))
      .map((element) => /^Showing ([\d,]+) of ([\d,]+)$/.exec(element.textContent?.trim() ?? ''))
      .filter((match) => match !== null)
      .map((match) => Number.parseInt(match[1]!.replace(/,/g, ''), 10));
    return {
      listTop,
      listHeight: listRect.height,
      rows,
      distanceToEnd: listTop + listRect.height - viewportBottom,
      viewportHeight: window.innerHeight,
      scrollOffset: window.scrollY - listTop,
      loaded: Math.max(...showing, 0),
    };
  });
}

/** Waits for the layout to stop moving, which is what a correction looks like. */
async function settle(page: Page): Promise<void> {
  let previous = -1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const height = await page.evaluate(() => document.getElementById('search-results-list')?.getBoundingClientRect().height ?? -1);
    if (height === previous) return;
    previous = height;
    await page.evaluate(() => {
      const { promise, resolve } = Promise.withResolvers<void>();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      return promise;
    });
  }
}

async function scrollTo(page: Page, y: number): Promise<void> {
  await page.evaluate((next) => window.scrollTo(0, next), y);
  await settle(page);
}

for (const width of WIDTHS) {
  test(`library scroll height follows measured row geometry at ${width}px`, async ({ page }) => {
    test.setTimeout(240_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    const surface = `variable rows at ${width}px`;

    await page.goto(`${basePath}/library/?page=${VIRTUAL_PAGE}`);
    await expect(page.locator('#search-results-list')).toBeVisible({ timeout: 30_000 });
    // The whole first page of results is loaded, so the walk below covers a list
    // whose length does not change under it.
    await expect(page.locator('p', { hasText: /^Showing 120 of [\d,]+$/ })).toBeVisible({ timeout: 30_000 });
    await settle(page);

    /**
     * Row identity -> what the browser reported for that row.
     *
     * `last` is the pitch the row reported in the most recent sample, which is
     * the value the model holds (both read the same box through the same
     * observer). `laidOut` is the largest pitch the row reported while it was on
     * screen, which is the only reading that cannot be a deferred placeholder:
     * a vlist that let a placeholder overwrite a laid-out height would shrink the
     * list while the reader scrolls, and comparing the two is what makes that
     * visible instead of self-consistent.
     */
    const readings = new Map<string, { last: number; laidOut: number }>();
    /** Row identities, in the order the list renders them. */
    const order: string[] = [];
    let sample = await sampleList(page);
    const listTop = sample.listTop;
    const loaded = sample.loaded;

    for (let step = 0; step <= MAX_STEPS; step += 1) {
      for (const row of sample.rows) {
        if (!order.includes(row.key)) order.push(row.key);
        const previous = readings.get(row.key);
        readings.set(row.key, {
          last: row.height,
          laidOut: row.visible ? Math.max(previous?.laidOut ?? 0, row.height) : previous?.laidOut ?? 0,
        });
        if (row.visible) expect(row.overflow, `${surface}: row ${row.key} clips its content`).toBeLessThanOrEqual(1);
      }

      // The rendered window covers the part of the viewport the list occupies.
      const visible = sample.rows.filter((row) => row.visible);
      expect(visible.length, `${surface}: rows covering the viewport`).toBeGreaterThan(0);
      const viewportTop = Math.max(0, sample.scrollOffset);
      const viewportBottom = Math.min(sample.scrollOffset + sample.viewportHeight, sample.listHeight);
      expect(visible[0]!.offset, `${surface}: nothing above the visible rows is missing`).toBeLessThanOrEqual(viewportTop + ROW_TOLERANCE);
      expect(visible.at(-1)!.offset + visible.at(-1)!.height, `${surface}: nothing below the visible rows is missing`)
        .toBeGreaterThanOrEqual(viewportBottom - ROW_TOLERANCE);

      // Adjacent rows in the window are adjacent on screen: one row's offset plus
      // its own pitch is the next row's offset, with nothing clipped or doubled.
      for (let index = 1; index < sample.rows.length; index += 1) {
        const previous = sample.rows[index - 1]!;
        const current = sample.rows[index]!;
        expect(
          Math.abs(current.offset - (previous.offset + previous.height)),
          `${surface}: rows ${previous.key} and ${current.key} overlap or leave a gap`
        ).toBeLessThanOrEqual(ROW_TOLERANCE);
      }

      if (readings.size >= TRAVERSED_ROWS || sample.distanceToEnd < 2 * SCROLL_STEP) break;
      await scrollTo(page, (await page.evaluate(() => window.scrollY)) + SCROLL_STEP);
      sample = await sampleList(page);
    }

    expect(order.length, `${surface}: rows rendered during the walk`).toBeGreaterThanOrEqual(TRAVERSED_ROWS);
    expect(readings.size, `${surface}: rows reported during the walk`).toBeGreaterThanOrEqual(TRAVERSED_ROWS);
    // The walk never reached the end of the list, so the "load more" sentinel
    // below it never appended a page mid-measurement.
    expect((await sampleList(page)).loaded, `${surface}: results loaded`).toBe(loaded);

    // Nothing the browser lays out is shorter than the floor the list seeds
    // unmeasured rows with: the seed is a real minimum, so it can under-state a
    // gap but never invent one.
    const shortestPitch = Math.min(...sample.rows.map((row) => row.height));
    expect(shortestPitch, `${surface}: shortest row in the final window`).toBeGreaterThanOrEqual(ROW_PITCH_FLOOR - ROW_TOLERANCE);

    /**
     * What to hold the list to: the height a row was laid out at, where the walk
     * saw it laid out, and what it last reported otherwise — the one case where
     * the walk cannot distinguish a real reading from the browser's placeholder
     * for a row it never brought on screen.
     */
    const heightOf = (key: string) => {
      const reading = readings.get(key);
      if (!reading) return ROW_PITCH_FLOOR;
      return reading.laidOut > 0 ? reading.laidOut : reading.last;
    };

    // The contract, and the reason the walk is worth its runtime: every row in the
    // window sits at exactly the total of the rows above it, and the list's own
    // box is the sum of the rows it stands for — the ones it laid out at their
    // measured pitch, the rest at the floor.
    const renderedKeys = sample.rows.map((row) => row.key);
    const aboveTheWindow = order.indexOf(renderedKeys[0]!);
    const deviations = new Map<string, number>();
    for (const key of renderedKeys) {
      const index = order.indexOf(key);
      const above = order.slice(0, index).reduce((total, row) => total + heightOf(row), 0);
      const row = sample.rows.find((entry) => entry.key === key)!;
      deviations.set(key, row.offset - above);
      expect(
        Math.abs(row.offset - above),
        `${surface}: row ${key} sits ${(row.offset - above).toFixed(1)}px from the sum of the rows above it`
      ).toBeLessThanOrEqual(1 + index * PER_ROW_TOLERANCE);
    }

    const observedHeight = order.reduce((total, key) => total + heightOf(key), 0);
    const unrendered = loaded - order.length;
    const expectedHeight = observedHeight + unrendered * ROW_PITCH_FLOOR;
    // `border border-hairline`: 1px top and bottom around the list's content.
    const listContentHeight = sample.listHeight - 2;
    const deviation = listContentHeight - expectedHeight;
    const laidOutPitches = [...readings.values()].filter((reading) => reading.laidOut > 0).map((reading) => reading.laidOut);
    const largestDeviation = Math.max(...[...deviations.values()].map((value) => Math.abs(value)));
    // The one number that says no laid-out height was ever replaced by a
    // placeholder: the worst gap between what a row was laid out at and what it
    // last reported.
    let worst = { key: 'none', laidOut: 0, last: 0 };
    for (const [key, reading] of readings) {
      if (reading.laidOut > 0 && reading.laidOut - reading.last > worst.laidOut - worst.last) worst = { key, ...reading };
    }
    const placeholderLoss = worst.laidOut - worst.last;
    console.log(
      `${surface}: ${readings.size}/${loaded} rows reported (${laidOutPitches.length} laid out), pitch ${Math.min(...laidOutPitches).toFixed(1)}-${Math.max(...laidOutPitches).toFixed(1)}px, ` +
      `window offset deviation ${largestDeviation.toFixed(1)}px over ${deviations.size} rows, ` +
      `list ${listContentHeight.toFixed(1)}px vs ${expectedHeight.toFixed(1)}px accounted for (deviation ${deviation.toFixed(1)}px), ` +
      `${aboveTheWindow} rows above the window, ${unrendered} never rendered, largest laid-out/placeholder gap ${placeholderLoss.toFixed(1)}px`
    );
    expect(
      Math.abs(deviation),
      `${surface}: list height ${listContentHeight.toFixed(1)} vs ${observedHeight.toFixed(1)} of laid-out rows + ${unrendered} unrendered at ${ROW_PITCH_FLOOR} (deviation ${deviation.toFixed(1)}px)`
    ).toBeLessThanOrEqual(1 + order.length * PER_ROW_TOLERANCE);

    // And no laid-out height was ever replaced by a placeholder while the walk
    // was scrolling: the card's deferred size remembers what the browser last
    // laid out (`contain-intrinsic-size: auto`), so a row that scrolls out of the
    // window keeps reporting the height it was measured at instead of collapsing
    // to the floor and shrinking the list under the reader.
    expect(
      placeholderLoss,
      `${surface}: row ${worst.key} was laid out at ${worst.laidOut.toFixed(1)}px and last reported ${worst.last.toFixed(1)}px`
    ).toBeLessThanOrEqual(ROW_TOLERANCE);

    // Scrolling back into a region the walk has already been through must not
    // lose what was measured there: a row remounting reports the floor again
    // would shrink the list under the reader. It may still *grow* — a row that
    // was still deferred when the walk passed can only be laid out for real.
    const reEntryTarget = Math.round((await page.evaluate(() => window.scrollY)) / 3);
    await scrollTo(page, reEntryTarget);
    const atReEntry = (await sampleList(page)).listHeight;
    let y = reEntryTarget;
    while (y < sample.scrollOffset + listTop) {
      y += SCROLL_STEP;
      await scrollTo(page, y);
    }
    const afterReEntry = (await sampleList(page)).listHeight;
    // Re-measurement drift is not loss: a row re-laid-out at another width or
    // after a content reflow legitimately comes back a fraction of a pixel
    // different. A row that remounted and reported the placeholder *over* a
    // measured height would cost (measured - floor) — 170px and up at this width
    // — per row, so a per-row px of slack separates the two by two orders of
    // magnitude.
    expect(
      afterReEntry - sample.listHeight,
      `${surface}: list height ${afterReEntry.toFixed(1)} after re-entering a measured region, was ${sample.listHeight.toFixed(1)} (at ${atReEntry.toFixed(1)} midway)`
    ).toBeGreaterThanOrEqual(-(1 + order.length * RE_ENTRY_TOLERANCE));

    expect(pageErrors).toEqual([]);
  });
}
