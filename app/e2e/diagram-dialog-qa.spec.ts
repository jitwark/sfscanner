import { expect, test } from '@playwright/test';
import { firstPrerenderedSubject } from './detail-subjects';

/**
 * Chromium is the only browser proof. The backdrop geometry is unit-proven in
 * `compact-vector-diagram.test.tsx` (a click inside the dialog's rectangle keeps
 * it open; a click outside it closes). This spec proves the keyboard dialog:
 * native containment, Escape, and focus return.
 */
const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? '').replace(/\/+$/, '');

test('expanded diagram is a keyboard dialog at 320 and 1440', async ({ page }) => {
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const subject = firstPrerenderedSubject();
    await page.goto(`${basePath}/w/${subject.slug}/`);

    const opener = page.getByRole('button', { name: 'Expand diagram' });
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: /Close/ })).toBeFocused();

    const focusInside = () => page.evaluate(() => Boolean(document.querySelector('dialog')?.contains(document.activeElement)));
    expect(await focusInside()).toBe(true);
    // Native modal containment, asserted after each press. No custom trap.
    for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      expect(await focusInside()).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: /Close/ }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  }
});

/**
 * `151` §5: the SVG and Popout buttons and the node-list summary carried
 * `focus-visible:outline-none` with no replacement ring. The global
 * `:focus-visible` ring lives in Tailwind's `base` layer, so the utility —
 * `utilities` layer, 0-2-0 — won and these three controls showed nothing while
 * the sibling zoom control did. Keyboard traversal from the page start is the
 * only probe that counts: no programmatic focus, no mouse.
 */
test('canvas controls show a keyboard focus indicator', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const subject = firstPrerenderedSubject();
  await page.goto(`${basePath}/w/${subject.slug}/`);

  // The zoom control carries no `outline-none`, so it is the baseline proving
  // the probe can see the global ring at all.
  const labelByTarget: Record<string, string> = {
    'Zoom in': 'the zoom-in control',
    'Download vector SVG': 'the SVG download button',
    'Expand diagram': 'the Popout button',
    'Inspect workflow nodes': 'the node-list summary',
  };
  const targets = Object.keys(labelByTarget);
  const observed: Record<string, boolean> = {};

  for (let presses = 0; presses < 240 && Object.keys(observed).length < targets.length; presses += 1) {
    await page.keyboard.press('Tab');
    const probe = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return null;
      const style = getComputedStyle(active);
      return {
        name: active.getAttribute('aria-label') ?? (active.textContent ?? '').trim(),
        visible: (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0)
          || style.boxShadow !== 'none',
      };
    });
    if (!probe) continue;
    for (const name of targets) {
      if (!(name in observed) && probe.name.startsWith(name)) observed[name] = probe.visible;
    }
  }

  const missing = targets.filter((name) => !(name in observed));
  expect(missing, `keyboard focus never reached: ${missing.join(', ')}`).toEqual([]);
  for (const [name, visible] of Object.entries(observed)) {
    expect(visible, `${labelByTarget[name]} has no visible keyboard focus indicator`).toBe(true);
  }
});
