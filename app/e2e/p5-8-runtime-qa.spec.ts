import { expect, test, type Page } from '@playwright/test';
import { largestLeanSubject, mostAnnotatedLeanSubject } from './detail-subjects';

/**
 * Complementary P5.8 runtime/accessibility coverage. The existing current-
 * corpus packet exercises the broad five-entry, four-width journey; this
 * independently named packet samples the two current-corpus extremes instead:
 * the largest Tier C workflow and the annotation-heavy workflow. It adds
 * singular interactive-SVG and Tier C focus-target assertions after activation.
 *
 * Click activation is intentional here: keyboard activation is covered by the
 * existing matrix, while this packet concentrates on runtime resource timing
 * and the post-activation accessibility shape at the two boundary widths.
 */

const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? '').replace(/\/+$/, '');
const VIEWPORTS = [320, 1440] as const;

/**
 * Both subjects are derived by page type — see `detail-subjects.ts`. These
 * assertions are about the lean contract, and a prerendered page is not subject
 * to it, so naming an id here made the spec depend on which 250 entries the
 * current corpus happens to prerender.
 */
const REPRESENTATIVES = [
  { ...largestLeanSubject(), label: 'largest lean workflow', tier: 'C' as const },
  { ...mostAnnotatedLeanSubject(), label: 'annotation-heavy workflow' },
];

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
  const fallback = page.getByRole('status').filter({
    hasText: /static (workflow )?preview (?:is )?(?:not available|unavailable|could not|failed)/i,
  }).first();
  await expect(preview.or(fallback).first()).toBeVisible({ timeout: 30_000 });
  if (await preview.isVisible()) await expect(preview.locator('svg')).toHaveCount(1);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const measurement = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(measurement.documentWidth, `document overflow at ${measurement.viewportWidth}px: ${JSON.stringify(measurement)}`)
    .toBeLessThanOrEqual(measurement.viewportWidth);
}

async function expectInteractiveSurface(page: Page): Promise<boolean> {
  const diagram = page.locator('svg[role="group"][aria-roledescription="Workflow diagram"]');
  const fallback = page.getByRole('status').filter({
    hasText: /interactive diagram|diagram could not|diagram.*empty|diagram timed out/i,
  }).first();
  await expect(diagram.or(fallback).first()).toBeVisible({ timeout: 30_000 });
  return diagram.isVisible();
}

for (const representative of REPRESENTATIVES) {
  for (const width of VIEWPORTS) {
    test(
      `P5.8 runtime resources and accessibility: ${representative.label} stays preview-first at ${width}px`,
      async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const chartRequests: string[] = [];
        page.on('request', (request) => {
          if (request.url().includes('/data/charts/')) chartRequests.push(request.url());
        });

        const response = await page.goto(appPath(`/w/${representative.slug}/`));
        expect(response?.status()).toBe(200);
        await expect(page.locator('main h1')).toHaveCount(1);

        // The statically rendered detail surface is the default and must not
        // pull the deferred chart shard merely because the page was opened.
        await expectStaticSurface(page);
        await page.waitForLoadState('networkidle');
        expect(chartRequests, 'static detail must not request chart data').toEqual([]);

        await page.getByRole('link', { name: /Open the interactive view/i }).click();
        await page.waitForURL((url) => url.pathname.endsWith('/w/view/') && url.searchParams.get('id') === representative.id);
        await expectStaticSurface(page);
        await expect(page.getByRole('button', { name: /Explore interactive canvas/i })).toBeVisible({ timeout: 30_000 });

        // The client-only shell also waits for the reader's explicit action.
        expect(chartRequests, 'interactive shell must not request chart data before activation').toEqual([]);

        await page.getByRole('button', { name: /Explore interactive canvas/i }).click();
        const diagramVisible = await expectInteractiveSurface(page);
        if (!diagramVisible) return;

        // One accessible workflow SVG is the diagram surface; icon SVGs inside
        // node groups must not create a second workflow target.
        const diagram = page.locator('svg[role="group"][aria-roledescription="Workflow diagram"]');
        await expect(diagram).toHaveCount(1);
        await expectNoHorizontalOverflow(page);

        if ('tier' in representative && representative.tier === 'C') {
          // Large Tier C canvases keep node groups inert at fit-to-view scale,
          // so no duplicate focusable SVG targets can leak into the page.
          const focusableSvgTargets = diagram.locator(
            '[data-interactive="true"][tabindex="0"], [data-interactive="true"][role="button"]',
          );
          await expect(focusableSvgTargets).toHaveCount(0);
        }
      },
    );
  }
}
