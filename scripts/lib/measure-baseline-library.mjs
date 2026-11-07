export async function measureLibraryPage(page, baseURL) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseURL}/library/`, { waitUntil: 'networkidle' });
  const filterDom = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('[class*="facet" i], [class*="filter" i], aside, [role="group"]'));
    let maxHeight = 0;
    let totalControls = 0;
    for (const element of candidates) {
      maxHeight = Math.max(maxHeight, element.scrollHeight);
      totalControls += element.querySelectorAll('input, button, [role="checkbox"], [role="option"]').length;
    }
    return { candidateContainerCount: candidates.length, maxContainerScrollHeight: maxHeight, totalControlCount: totalControls };
  });
  const searchInput = page.locator('input[name="q"], input[role="combobox"], input[type="search"], input[placeholder*="search" i]').first();
  let queryMs = null;
  if (await searchInput.count()) {
    const t0 = Date.now();
    await searchInput.fill('slack');
    await page.waitForTimeout(1200);
    queryMs = Date.now() - t0;
  }
  return { filterDom, queryMs, searchInputFound: (await searchInput.count()) > 0 };
}
