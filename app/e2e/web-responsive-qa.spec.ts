import { expect, test } from '@playwright/test';
import { firstPrerenderedSubject } from './detail-subjects';
import { assertNoOverflow, assertTarget } from './web-qa-helpers';

/**
 * W-008: reflow and target size at 320 / 768 / 1024 / 1440 px.
 *
 * Measured from the rendered box, never from a class name. Retry and cancel are
 * not measured here: reaching them needs a bounded failing scan or a live
 * cancel, and the `33` baseline's cancel attempt timed out. They stay
 * behaviour-asserted in T7 and `NOT-EXERCISED (B-04)` for measurement.
 */
const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? '').replace(/\/+$/, '');

for (const width of [320, 768, 1024, 1440]) {
  test(`responsive ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const subject = firstPrerenderedSubject();
    for (const route of ['/', '/library/', '/scanner/', `/w/${subject.slug}/`]) {
      await page.goto(`${basePath}${route}`);
      await assertNoOverflow(page);
      await page.screenshot({
        path: testInfo.outputPath(`${width}-${route.replaceAll('/', '_') || 'home'}.png`),
        fullPage: true,
      });
    }

    await page.goto(`${basePath}/scanner/`);
    await assertTarget(page, 'Scan workflow');

    await page.goto(`${basePath}/w/${subject.slug}/`);
    const opener = page.getByRole('button', { name: 'Expand diagram' });
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await assertNoOverflow(page);
    await assertTarget(page, /Close/);
    await assertTarget(page, 'Download SVG');
    await page.keyboard.press('Escape');
    await expect(opener).toBeFocused();
  });
}
