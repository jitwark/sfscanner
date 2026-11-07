import { expect, test, type Page } from '@playwright/test';
import { firstLeanSubject } from './detail-subjects';

const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? '').replace(/\/+$/, '');

function appPath(pathname: string): string {
  return `${basePath}${pathname}`;
}

async function assertNoHorizontalOverflow(page: Page, surface: string): Promise<void> {
  const measurement = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(measurement.documentWidth, `${surface} overflow: ${JSON.stringify(measurement)}`)
    .toBeLessThanOrEqual(measurement.viewport);
}

async function focusByKeyboard(page: Page, target: ReturnType<Page['getByRole']>): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let index = 0; index < 60; index += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error('Primary detail action was not reachable in the keyboard order.');
}

/**
 * Open a **lean** detail page.
 *
 * This used to click the first `rights=link_only` card, on the reasoning that
 * filtering to link-only kept it deterministic across corpus rebuilds. It did
 * not: link-only is 97.5% of the corpus and says nothing about whether Next
 * prerendered the page. The assertion below — the deferred canvas, reachable
 * only through "Open the interactive view" — is the lean page's contract, and
 * the prerendered page renders its canvas inline with no such link, so it is
 * not subject to it. The section's heading is not the discriminator: `a1681ad`
 * deliberately aligned both tiers on "Workflow canvas". So the subject is
 * chosen by page type. See `detail-subjects.ts`.
 */
async function openLinkOnlyDetail(page: Page): Promise<void> {
  const subject = firstLeanSubject();
  await page.goto(appPath(`/w/${subject.slug}/`));
  await expect(page).toHaveURL(/\/w\/[^?]+\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
}

async function setTwoHundredPercentVisualZoom(page: Page): Promise<void> {
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  await expect.poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(2);
}

test.describe('workflow detail accessibility evidence', () => {
  test('link-only detail has truthful landmarks, keyboard focus, and 200% zoom evidence', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openLinkOnlyDetail(page);

    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Breadcrumbs' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Workflow canvas', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'About this workflow', exact: true })).toBeVisible();

    const primary = page.getByRole('link', { name: /^View on (n8n\.io|GitHub)$/ });
    await expect(primary).toBeVisible();
    await expect(primary).toHaveAttribute('href', /^https:\/\//);
    await expect(page.getByRole('button', { name: 'Download workflow' })).toHaveCount(0);
    // The preview region of the current lean page (`CompactVectorDiagram`,
    // `a1681ad`) and the labelled image stage inside it. `StaticWorkflowPreview`
    // carried the same two facts as `[data-static-preview] > [role="img"]`.
    await expect(page.locator('[data-compact-vector-diagram] [role="img"]').first()).toBeVisible();

    await focusByKeyboard(page, primary);
    await expect(primary).toBeFocused();
    const focusStyle = await primary.evaluate((element) => {
      const style = getComputedStyle(element);
      return { outlineWidth: style.outlineWidth, boxShadow: style.boxShadow };
    });
    expect(focusStyle.outlineWidth !== '0px' || focusStyle.boxShadow !== 'none').toBe(true);

    await setTwoHundredPercentVisualZoom(page);
    await assertNoHorizontalOverflow(page, 'link-only detail at 200% visual zoom');
  });

  test('interactive shell keeps reduced-motion and static fallback text truthful', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await openLinkOnlyDetail(page);

    await page.getByRole('link', { name: /Open the interactive view/i }).click();
    await expect(page).toHaveURL(/\/w\/view\/\?id=[^&]+/);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Workflow canvas' }).getByRole('status'))
      .toContainText('Static preview unavailable for this release.');

    const explore = page.getByRole('button', { name: 'Explore interactive canvas' });
    await expect(explore).toBeVisible();
    const motion = await explore.evaluate((element) => ({
      reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      transitionMs: Number.parseFloat(getComputedStyle(element).transitionDuration) || 0,
      animationMs: Number.parseFloat(getComputedStyle(element).animationDuration) || 0,
    }));
    expect(motion.reduced).toBe(true);
    expect(motion.transitionMs).toBeLessThanOrEqual(0.01);
    expect(motion.animationMs).toBeLessThanOrEqual(0.01);

    await focusByKeyboard(page, explore);
    await expect(explore).toBeFocused();
    await page.keyboard.press('Enter');
    const diagram = page.getByRole('group', { name: /Workflow diagram/ });
    const fallback = page.getByRole('status').filter({
      hasText: /interactive diagram|diagram could not|diagram.*empty|diagram timed out/i,
    }).first();
    await expect(diagram.or(fallback).first()).toBeVisible({ timeout: 30_000 });
    if (await diagram.isVisible()) await expect(diagram).toHaveAttribute('aria-roledescription', 'Workflow diagram');
    else await expect(fallback).toContainText(/interactive|diagram/i);
    await assertNoHorizontalOverflow(page, 'interactive workflow shell');
  });
});
