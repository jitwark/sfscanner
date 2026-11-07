import { expect, test, type Page } from '@playwright/test';
import { largestLeanSubject, leanRepresentatives } from './detail-subjects';

const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? '').replace(/\/+$/, '');
const VIEWPORTS = [320, 768, 1024, 1440] as const;

/**
 * Subjects are derived from the corpus by page type, not hardcoded.
 *
 * Every assertion below is about the **lean** detail contract: a static preview,
 * no chart fetch, and a deferred canvas behind "Open the interactive view". The
 * prerendered top-250 pages render the canvas inline and have no such link, so a
 * representative that drifts from lean to prerendered does not fail this
 * contract — it stops being subject to it. Three of the five ids named here
 * drifted exactly that way when 1,757 unrenderable entries were withheld on
 * 2026-09-04, and twelve tests failed for a reason that had nothing to do with
 * the product. See `detail-subjects.ts`.
 */
const REPRESENTATIVES = leanRepresentatives();

/** The largest lean graph is the tier-C case: the binding one for canvas cost. */
const LARGEST_LEAN_ID = largestLeanSubject().id;

function appPath(pathname: string): string {
  return `${basePath}${pathname}`;
}

/**
 * The static, non-interactive preview surface.
 *
 * Two deliberate implementations carry it, and this helper is called on both:
 * `StaticWorkflowPreview` (`[data-static-preview]`, `static-preview.tsx`), which
 * `ChartLoader` renders on the interactive route, and `CompactVectorDiagram`
 * (`[data-compact-vector-diagram]`, `compact-vector-diagram.tsx`), which
 * replaced it on the lean detail page in `a1681ad`. Both wrap one vector in the
 * same accessible shape — a single labelled `[role="img"]` stage — and both give
 * way to an explicit availability notice when the release carries no preview
 * artifact, which is what keeps the static page from asserting a diagram it does
 * not have.
 */
async function expectStaticSurface(page: Page): Promise<void> {
  const preview = page.locator('[data-static-preview], [data-compact-vector-diagram]').first();
  const fallback = page.getByText(/static (workflow )?preview (?:is )?(?:not available|unavailable|could not|failed)/i).first();
  await expect(preview.or(fallback).first()).toBeVisible({ timeout: 30_000 });
  if (await preview.isVisible()) await expect(preview.locator('svg')).toHaveCount(1);
}

async function expectNoHorizontalOverflow(page: Page, surface: string): Promise<void> {
  const measurement = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const offenders = Array.from(document.querySelectorAll<HTMLElement>('*'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          testId: element.dataset.testid ?? '',
          className: String(element.className).slice(0, 80),
          text: (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        };
      })
      .filter(({ left, right }) => left < 0 || right > viewportWidth)
      .slice(0, 5);
    return { viewportWidth, documentWidth: document.documentElement.scrollWidth, offenders };
  });
  expect(measurement.documentWidth, `${surface} must not overflow horizontally: ${JSON.stringify(measurement)}`).toBeLessThanOrEqual(measurement.viewportWidth);
}

async function expectInteractiveSurface(page: Page): Promise<boolean> {
  const diagram = page.getByRole('group', { name: /Workflow diagram/ });
  const fallback = page.getByRole('status').filter({
    hasText: /interactive diagram|diagram could not|diagram.*empty|diagram timed out/i,
  }).first();
  await expect(diagram.or(fallback).first()).toBeVisible({ timeout: 30_000 });
  return diagram.isVisible();
}

for (const representative of REPRESENTATIVES) {
  for (const width of VIEWPORTS) {
    test(`P5.8 current corpus representative ${representative.id} keeps canvas opt-in at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const chartRequests: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/data/charts/')) chartRequests.push(request.url());
      });

      const response = await page.goto(appPath(`/w/${representative.slug}/`));
      expect(response?.status()).toBe(200);
      await expect(page.locator('main h1')).toHaveCount(1);
      await expect(page.locator('main h1')).toBeVisible();
      await expectStaticSurface(page);
      await expectNoHorizontalOverflow(page, 'detail page');
      await page.waitForLoadState('networkidle');
      expect(chartRequests, 'the static detail page must not fetch a chart shard').toEqual([]);

      const openView = page.getByRole('link', { name: /Open the interactive view/i });
      await openView.focus();
      await expect(openView).toBeFocused();
      await openView.press('Enter');
      await page.waitForURL((url) => url.pathname.endsWith('/w/view/') && url.searchParams.get('id') === representative.id);
      await expectStaticSurface(page);
      await expect(page.getByRole('button', { name: /Explore interactive canvas/i })).toBeVisible({ timeout: 30_000 });
      await expectNoHorizontalOverflow(page, 'interactive shell before activation');
      expect(chartRequests, 'the interactive shell must not fetch a chart before activation').toEqual([]);

      const explore = page.getByRole('button', { name: /Explore interactive canvas/i });
      await explore.focus();
      await expect(explore).toBeFocused();
      await explore.press('Enter');
      const diagramVisible = await expectInteractiveSurface(page);
      await expectNoHorizontalOverflow(page, 'interactive surface');
      expect(chartRequests.length, 'activation must fetch the chart shard').toBeGreaterThan(0);

      if (diagramVisible && representative.id === LARGEST_LEAN_ID) {
        const diagram = page.getByRole('group', { name: /Workflow diagram/ });
        const svgNodes = diagram.locator('[data-interactive="true"]');
        // The largest lean graph today has 130 functional nodes. The floor is
        // deliberately well below that: it asserts the canvas renders a large
        // graph at all, not the exact size of whichever entry is currently
        // largest.
        expect(await svgNodes.count()).toBeGreaterThan(62);
        await expect(diagram.locator('[tabindex="0"]')).toHaveCount(0);
        await expect(diagram.locator('[role="button"]')).toHaveCount(0);
      }
    });
  }
}
