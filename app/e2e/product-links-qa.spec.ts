import { expect, test } from '@playwright/test';

/**
 * Omission-only by construction: the export under test is built without
 * `NEXT_PUBLIC_PRODUCT_REPOSITORY_URL`, so the configured branch cannot be
 * claimed as browser-proven here. Its `https:` shape is unit-proven in
 * `product-links.test.ts` and `site-header.test.tsx`.
 */
const DEAD = /github\.com\/jitwark\/n8n-community(?:\/|$)|https:\/\/n8n-community\.com(?:\/|$)/;
const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? '').replace(/\/+$/, '');

for (const route of ['/about/', '/']) {
  test(`no dead or private-labelled link ${route}`, async ({ page }) => {
    await page.goto(`${basePath}${route}`);
    const hrefs = await page
      .locator('a[href]')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLAnchorElement).href));
    expect(hrefs.filter((href) => DEAD.test(href))).toEqual([]);
    await expect(page.getByText('GitHub (private)')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /github/i })).toHaveCount(0);
  });
}
