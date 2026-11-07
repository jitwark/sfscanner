import { firstLeanSubject } from './detail-subjects';
import { expect, test, type Page } from '@playwright/test';
import { assertNoOverflow } from './web-qa-helpers';

const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

function capturePageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/**
 * P3.1 (2026-08-27). `docs/audit/2026-08-26/baseline/phase-0-p0.4-baseline.md`
 * measured real horizontal overflow at 320px on both routes below:
 *
 *  - `/analytics/`: a `BarList` table (`src/ui/analytics/bar-list.tsx`) had no
 *    horizontal-scroll wrapper, so a long, data-driven label (an integration
 *    or node-type name) forced the whole `<table>` — and the document — wider
 *    than the viewport.
 *  - `/w/view/?id=…`: the trailing breadcrumb crumb (the workflow's own
 *    title, `src/ui/breadcrumbs.tsx`) had no `min-width`, so on a four-level
 *    trail (Home / Integrations / <integration> / <title>) it was left with
 *    only whatever pixels the earlier, fixed-size crumbs did not use —
 *    measured as low as 9px for a title needing hundreds — regardless of
 *    workflow complexity, since the mechanism is the breadcrumb trail, not
 *    the canvas.
 *
 * Both were confirmed live with Playwright at 320px before and after the fix
 * (root-caused via `document.documentElement.scrollWidth` /
 * `element.scrollWidth` vs `clientWidth` walks, not by reading the CSS).
 */
test.describe('no horizontal document overflow at 320px', () => {
  test('/analytics/ does not overflow the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    const pageErrors = capturePageErrors(page);
    await page.goto(`${basePath}/analytics/`);
    await expect(page.getByRole('heading', { name: 'What is actually in the catalogue' })).toBeVisible();
    await assertNoOverflow(page);
    expect(pageErrors).toEqual([]);
  });

  test('/w/view/?id=… does not overflow the viewport, regardless of workflow complexity', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    const pageErrors = capturePageErrors(page);
    const subject = firstLeanSubject();
    // The subject must be a LEAN page, because only a lean page has the
    // content tier under test. Filtering the library to link-only was the
    // previous attempt at determinism and did not work: link-only is 97.5% of
    // the corpus, prerendered entries included. See `detail-subjects.ts`.
    await page.goto(`${basePath}/w/${subject.slug}/`);
    await expect(page.getByRole('heading', { name: subject.title })).toBeVisible();
    await assertNoOverflow(page);
    await page.getByRole('link', { name: /Read (?:all \d+ findings|each finding)/i }).click();
    await page.waitForURL(/\/w\/view\/\?id=/);
    await expect(page.getByRole('heading', { name: subject.title })).toBeVisible({ timeout: 30_000 });
    await assertNoOverflow(page);
    expect(pageErrors).toEqual([]);
  });
});
