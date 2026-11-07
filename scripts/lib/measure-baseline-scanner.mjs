import { collectConsole } from './measure-baseline-page.mjs';

export async function measureScannerPage(page, baseURL) {
  const consoleErrors = [];
  const requests = [];
  const workers = [];
  page.on('request', (request) => requests.push({ resourceType: request.resourceType(), url: request.url() }));
  page.on('worker', (worker) => {
    const startedAt = Date.now();
    workers.push({ url: worker.url(), startedAt });
    worker.on('close', () => {
      const current = workers.find((item) => item.url === worker.url() && !item.closedAt);
      if (current) current.closedAt = Date.now();
    });
  });
  collectConsole(page, consoleErrors);
  await page.addInitScript(() => {
    window.__scannerLayoutShift = { value: 0, count: 0 };
    if (typeof PerformanceObserver !== 'undefined') {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            window.__scannerLayoutShift.value += entry.value;
            window.__scannerLayoutShift.count += 1;
          }
        }
      });
      observer.observe({ type: 'layout-shift', buffered: true });
    }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const navigationStart = Date.now();
  await page.goto(`${baseURL}/scanner/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#workflow-json').waitFor({ state: 'visible', timeout: 10000 });
  const firstInteractionReadyMs = Date.now() - navigationStart;
  const before = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    domCount: document.querySelectorAll('*').length,
  }));
  const sampleWorkflow = JSON.stringify({
    nodes: [
      { id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: '2', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [200, 0], parameters: { url: 'https://example.com' } },
    ],
    connections: { Start: { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] } },
  });
  const textarea = page.locator('#workflow-json');
  const hasTextarea = await textarea.count();
  let settleMs = null;
  let after = null;
  let settleMethod = null;
  let resultReadyMs = null;
  const initialRequestCount = requests.length;
  if (hasTextarea) {
    await textarea.fill(sampleWorkflow);
    const scanButton = page.getByRole('button', { name: /scan workflow/i });
    if (await scanButton.count()) {
      const scanStart = Date.now();
      await scanButton.first().click();
      await page.getByRole('heading', { name: 'Analyst summary' }).waitFor({ state: 'visible', timeout: 15000 });
      resultReadyMs = Date.now() - scanStart;
      // No app-specific "scan complete" selector was identified for this script — this measures
      // DOM-height stabilization (two consecutive 300ms samples with no change), a generic proxy,
      // not an engine-reported scan duration. Capped at 10s; a cap-out is reported honestly.
      let stable = 0;
      let lastHeight = -1;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && stable < 2) {
        await page.waitForTimeout(300);
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        stable = height === lastHeight ? stable + 1 : 0;
        lastHeight = height;
      }
      settleMs = Date.now() - scanStart;
      settleMethod = stable >= 2 ? 'dom-height-stable-2x300ms' : 'timed-out-at-10000ms';
    }
    after = await page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      domCount: document.querySelectorAll('*').length,
    }));
  }
  return {
    before,
    after,
    firstInteractionReadyMs,
    resultReadyMs,
    settleMs,
    settleMethod,
    initialRequestCount,
    postInteractionRequestCount: Math.max(0, requests.length - initialRequestCount),
    javascriptRequestCount: requests.filter(({ resourceType }) => resourceType === 'script').length,
    workerCount: workers.length,
    workerUrls: workers.map(({ url }) => url),
    layoutShift: await page.evaluate(() => window.__scannerLayoutShift),
    consoleErrorCount: consoleErrors.length,
    note: hasTextarea ? null : '#workflow-json input not found — selector may have changed since this script was written',
  };
}
