import { expect, test } from '@playwright/test';

const configuredBasePath = (process.env.PLAYWRIGHT_BASE_PATH ?? process.env.NEXT_PUBLIC_BASE_PATH ?? '')
  .replace(/^\/+|\/+$/g, '');
const basePath = configuredBasePath ? `/${configuredBasePath}` : '';

const labelTokens = [
  '--theme-sev-low', '--theme-sev-medium', '--theme-sev-high',
  '--theme-sev-critical', '--theme-sev-unknown',
  '--theme-cat-purple', '--theme-cat-blue', '--theme-cat-green',
  '--theme-cat-orange', '--theme-cat-pink',
];

test('theme text and keyboard focus retain WCAG contrast in both modes', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.goto(`${basePath}/scanner/`);
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);

    const textRatios = await page.evaluate(({ tokens, surfaces }) => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas context unavailable for contrast calculation');

      const luminance = (value: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
        const linear = (channel: number) => {
          const srgb = channel / 255;
          return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
      };

      const ratios: number[] = [];
      for (const token of tokens) {
        for (const surface of surfaces) {
          const probe = document.createElement('span');
          probe.textContent = 'Contrast sample';
          probe.style.color = `var(${token})`;
          probe.style.backgroundColor = `color-mix(in srgb, var(${token}) 10%, var(${surface}))`;
          document.body.append(probe);
          const style = getComputedStyle(probe);
          const colors = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
          ratios.push((colors[0] + 0.05) / (colors[1] + 0.05));
          probe.remove();
        }
      }
      return ratios;
    }, { tokens: labelTokens, surfaces: ['--theme-page', '--theme-panel', '--theme-raised'] });

    expect(textRatios).toHaveLength(labelTokens.length * 3);
    for (const ratio of textRatios) expect(ratio).toBeGreaterThanOrEqual(4.5);

    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return null;
      const style = getComputedStyle(active);
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement('span');
      probe.style.color = 'var(--theme-accent-border)';
      document.body.append(probe);
      const expectedColor = getComputedStyle(probe).color;
      probe.remove();
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas context unavailable for focus contrast calculation');
      const luminance = (value: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
        const linear = (channel: number) => {
          const srgb = channel / 255;
          return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
      };
      const outlineLuminance = luminance(style.outlineColor);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        outlineColor: style.outlineColor,
        expectedColor,
        boundaryRatios: ['--theme-page', '--theme-panel', '--theme-raised'].map((token) => {
          const surfaceLuminance = luminance(root.getPropertyValue(token).trim());
          const colors = [outlineLuminance, surfaceLuminance].sort((a, b) => b - a);
          return (colors[0] + 0.05) / (colors[1] + 0.05);
        }),
      };
    });

    expect(focus).not.toBeNull();
    expect(focus?.outlineStyle).toBe('solid');
    expect(focus?.outlineWidth).toBeGreaterThanOrEqual(2);
    expect(focus?.outlineColor).toBe(focus?.expectedColor);
    for (const ratio of focus?.boundaryRatios ?? []) expect(ratio).toBeGreaterThanOrEqual(3);
  }
});
