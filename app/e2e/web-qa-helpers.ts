import { expect, type Page } from '@playwright/test';

/**
 * The two measurements WCAG 2.2 AA requires of every width in the matrix.
 *
 * They live here, not copied per spec, because a local copy is how a suite ends
 * up asserting 44px in one file and reading `height` only in another. Both are
 * measured from the rendered box: SC 1.4.10 (reflow) is a property of the
 * document, and SC 2.5.8 (target minimum) is a property of the pixels, so
 * neither can be read off the source.
 */
export async function assertNoOverflow(page: Page): Promise<void> {
  const value = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  expect(value.scrollWidth).toBeLessThanOrEqual(value.width);
}

/** The project target for a primary control is 44 CSS px in both dimensions. */
export async function assertTarget(page: Page, name: string | RegExp): Promise<void> {
  const box = await page.getByRole('button', { name }).first().boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}
