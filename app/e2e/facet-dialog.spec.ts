import { expect, test } from '@playwright/test';
import { appPath } from './app-paths';

for (const width of [320, 768, 1024, 1440]) {
  test(`Filters dialog remains usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(appPath('/library/'));

    const trigger = page.getByRole('button', { name: 'Filters', exact: true });
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await trigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Filters' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');

    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    if (width === 320) {
      expect(box?.x).toBe(0);
      expect(box?.width).toBe(320);
    } else {
      expect(box?.x).toBeGreaterThan(0);
      expect(box?.x).toBeLessThan(width / 2);
      expect(box?.width).toBeLessThan(width);
    }

    const close = dialog.getByRole('button', { name: 'Close' });
    const apply = dialog.getByRole('button', { name: 'Apply filters' });
    await apply.focus();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog', { name: 'Filters' })).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  });
}
