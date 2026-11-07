export function collectConsole(page, bucket) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') bucket.push(msg.text());
  });
  page.on('pageerror', (err) => bucket.push(String(err)));
}

export async function measurePage(page, url, width) {
  await page.setViewportSize({ width, height: 900 });
  const consoleErrors = [];
  collectConsole(page, consoleErrors);
  const start = Date.now();
  const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => null);
  const loadMs = Date.now() - start;
  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      documentHeight: document.documentElement.scrollHeight,
      domElementCount: document.querySelectorAll('*').length,
      svgCount: document.querySelectorAll('svg').length,
      mainCount: document.querySelectorAll('main').length,
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      loadEventMs: nav ? Math.round(nav.loadEventEnd) : null,
      transferBytes: nav ? nav.transferSize : null,
    };
  }).catch(() => null);
  return {
    status: response?.status() ?? null,
    loadMs,
    overflow: metrics ? metrics.scrollWidth > metrics.innerWidth : null,
    consoleErrorCount: consoleErrors.length,
    consoleErrors: consoleErrors.slice(0, 3),
    ...metrics,
  };
}
