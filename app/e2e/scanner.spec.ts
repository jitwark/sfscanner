import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const cleanJson = fs.readFileSync(path.join(__dirname, 'fixtures', 'clean.json'), 'utf8');
const maliciousJson = fs.readFileSync(path.join(__dirname, 'fixtures', 'malicious.json'), 'utf8');
const heavyJson = fs.readFileSync(path.join(__dirname, 'fixtures', 'heavy.json'), 'utf8');
// The literal secret embedded in `malicious.json`'s Execute Command node. Named here so the
// zero-network test asserts on the secret itself, not only on the larger strings that contain it.
const secretInFixture = 'sk_live_12345678901234567890';
const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? '').replace(/\/+$/, '');
const appPath = (pathname: string) => `${basePath}${pathname}`;

const genericFixtureMarkers = new Set([
  'false',
  'main',
  'name',
  'null',
  'nodes',
  'options',
  'parameters',
  'position',
  'true',
  'type',
  'undefined',
  'value',
]);

function collectMeaningfulFixtureMarkers(serializedFixture: string): string[] {
  const markers = new Set<string>();

  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      const marker = value.trim();
      const isMeaningful =
        marker.length >= 4 && /[A-Za-z]/.test(marker) && !genericFixtureMarkers.has(marker);
      if (isMeaningful) markers.add(marker);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (value && typeof value === 'object') {
      const objectValue = value as Record<string, unknown>;
      for (const key of Object.keys(objectValue).sort()) visit(objectValue[key]);
    }
  };

  visit(JSON.parse(serializedFixture) as unknown);
  return [...markers].sort();
}

function decodeRequestContent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const maliciousFixtureMarkers = collectMeaningfulFixtureMarkers(maliciousJson);

type WindowWithRaf = Window & {
  __rafGaps?: number[];
  __lastTime?: number;
  __rafRunning?: boolean;
};

async function fillTextarea(page: Page, text: string) {
  const textarea = page.getByPlaceholder('Paste workflow JSON here or drag and drop a .json file...');
  await textarea.evaluate((el: HTMLTextAreaElement, value: string) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    nativeSetter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
}

test.describe('Workflow Scanner E2E', () => {
  test('clean fixture scanning', async ({ page }) => {
    await page.goto(appPath('/scanner'));
    // The v2 scanner admits one profile and shows it in the same labelled chip the v1 page
    // used for its single scan depth (`scanner-input.tsx`).
    await expect(page.getByLabel('Selected scanner profile: Default scan')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Standard' })).toHaveCount(0);

    await fillTextarea(page, cleanJson);
    await page.getByRole('button', { name: 'Scan workflow' }).click();

    // The v2 report's outcome heading is "Analysis coverage"; "Analyst summary" was the v1
    // report's heading and left with the cutover.
    await expect(page.getByRole('heading', { name: 'Analysis coverage' })).toBeVisible();

    // Verify the scanned workflow is summarised. The v2 report renders no workflow name
    // (`app/src/scanner/report-v2/**` has no surface for it), so the submitted document's
    // summary is the editor's collapsed "Scanned workflow · size · lines" line.
    await expect(page.getByText('Scanned workflow', { exact: false }).first()).toBeVisible();

    // The clean fixture scans COMPLETE, so the old "findings returned so far /
    // coverage incomplete" sentence is deleted rather than re-pinned. The boundary
    // kept here is the coverage state itself plus zero priority findings.
    await expect(page.getByRole('status', { name: 'Analysis status: Analysis complete' })).toBeVisible();
    await expect(page.getByText('0 priority')).toBeVisible();
  });

  test('malicious fixture scanning', async ({ page }) => {
    await page.goto(appPath('/scanner'));

    await fillTextarea(page, maliciousJson);
    await page.getByRole('button', { name: 'Scan workflow' }).click();

    await expect(page.getByRole('heading', { name: 'Analysis coverage' })).toBeVisible();

    await expect(page.getByLabel('Selected scanner profile: Default scan')).toBeVisible();

    // Verify visible findings
    await expect(page.getByRole('heading', { name: 'Critical and high findings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Execute Command node can run shell commands' })).toBeVisible();

    // Verify severity and grade evidence (CRITICAL)
    await expect(page.getByText('CRITICAL').first()).toBeVisible();
  });

  test('cancellation mid-scan', async ({ page }) => {
    await page.goto(appPath('/scanner'));

    await fillTextarea(page, heavyJson);
    await page.getByRole('button', { name: 'Scan workflow' }).click();

    // Wait for cancel button to appear during scan
    const cancelButton = page.getByRole('button', { name: 'Cancel' });
    await expect(cancelButton).toBeVisible();

    // Click cancel mid-scan
    // Progress updates can replace the button between Playwright's actionability
    // checks. Dispatch against the currently rendered control to exercise the
    // same React handler without making the test race the progress stream.
    await cancelButton.dispatchEvent('click');

    // Assert UI returns to idle with no stale report
    await expect(cancelButton).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Scan workflow' })).toBeEnabled();
    await expect(page.getByRole('heading', { name: 'Analysis coverage' })).not.toBeVisible();
  });

  test('zero network requests containing workflow content', async ({ page }) => {
    const recordedRequests: Array<{
      url: string;
      method: string;
      postData: string | null;
      headers: Record<string, string>;
    }> = [];

    await page.route('**/*', async (route) => {
      const request = route.request();
      recordedRequests.push({
        url: request.url(),
        method: request.method(),
        postData: request.postData(),
        headers: await request.allHeaders(),
      });
      return route.continue();
    });

    await page.goto(appPath('/scanner'));

    // The fixture must actually carry the secret this test is about, and the marker set
    // must cover it. If either drifts, the assertions below would still pass while proving
    // nothing — so both are asserted before any request is judged.
    expect(maliciousJson).toContain(secretInFixture);
    expect(maliciousFixtureMarkers.some((marker) => marker.includes(secretInFixture))).toBe(true);

    await fillTextarea(page, maliciousJson);
    await page.getByRole('button', { name: 'Scan workflow' }).click();
    await expect(page.getByRole('heading', { name: 'Analysis coverage' })).toBeVisible();

    // The sentinel has to have observed the page's traffic and its headers, or the loop
    // below proves nothing. Measured on this build: 17 requests, 9 header names.
    expect(recordedRequests.length).toBeGreaterThan(0);
    expect(
      Object.keys(recordedRequests[0]?.headers ?? {}).length,
      'the request sentinel must observe headers, not an empty map',
    ).toBeGreaterThan(0);

    // Verify recorded requests
    for (const req of recordedRequests) {
      const urlObj = new URL(req.url);
      const isLocalAsset =
        urlObj.hostname === '127.0.0.1' ||
        urlObj.hostname === 'localhost' ||
        urlObj.protocol === 'data:' ||
        urlObj.protocol === 'blob:';

      expect(isLocalAsset).toBe(true);

      // The header's nav links are `next/link` now, so Next prefetches the
      // other routes while the scanner page sits idle. Those are same-origin
      // GETs for static HTML with no body — they are not the thing this test
      // exists to catch, and enumerating every route here would only produce a
      // list that goes stale the next time one is added.
      //
      // What the test actually guarantees is unchanged and stated directly
      // below: nothing leaves this origin, no request *method* can carry a
      // body, and no request URL, body or header contains workflow content or
      // the fixture's embedded secret. A silent exfiltration path would have to
      // violate one of those.
      const isSideEffectFree = req.method === 'GET' || req.method === 'HEAD';
      expect(isSideEffectFree, `unexpected ${req.method} request during local scan`).toBe(true);

      const headerBlob = Object.entries(req.headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join('\n');

      for (const marker of [...maliciousFixtureMarkers, secretInFixture]) {
        // Assert on a boolean so a failure cannot print a leaked URL, body, or marker.
        expect(
          decodeRequestContent(req.url).includes(marker),
          `request ${req.method} URL must not contain workflow fixture content`,
        ).toBe(false);
        if (req.postData) {
          expect(
            decodeRequestContent(req.postData).includes(marker),
            `request ${req.method} body must not contain workflow fixture content`,
          ).toBe(false);
        }
        // Headers are a body-less exfil channel (`fetch(url, { headers })`), so they are
        // asserted like the body: on a boolean, so a leaked secret is never printed.
        expect(
          decodeRequestContent(headerBlob).includes(marker),
          `request ${req.method} headers must not contain workflow fixture content`,
        ).toBe(false);
      }
    }
  });

  test('main-thread responsiveness and error-free scan', async ({ page }) => {
    const errors: string[] = [];
    const closedWorkers: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Ignore Next.js dev server cross-origin HMR warning if present
        if (!text.includes('Blocked cross-origin request')) {
          errors.push(`Console error: ${text}`);
        }
      }
    });

    page.on('pageerror', (err) => {
      errors.push(`Page error: ${err.message}`);
    });

    // Playwright's Worker exposes no 'error' event; an uncaught worker exception
    // surfaces on the page as a pageerror, which is already captured above. Track
    // worker termination instead, since a crashed worker also ends the scan.
    page.on('worker', (worker) => {
      worker.on('close', () => {
        closedWorkers.push(worker.url());
      });
    });

    await page.goto(appPath('/scanner'));

    await fillTextarea(page, heavyJson);
    await page.getByRole('button', { name: 'Scan workflow' }).click();

    // Start RAF gap sampling during the worker scan phase
    await page.evaluate(() => {
      const win = window as unknown as WindowWithRaf;
      win.__rafGaps = [];
      win.__lastTime = performance.now();
      win.__rafRunning = true;

      function sampleRAF() {
        if (!win.__rafRunning) return;
        const now = performance.now();
        const gap = now - (win.__lastTime ?? now);
        win.__rafGaps?.push(gap);
        win.__lastTime = now;
        requestAnimationFrame(sampleRAF);
      }
      requestAnimationFrame(sampleRAF);
    });

    await expect(page.getByRole('heading', { name: 'Analysis coverage' })).toBeVisible({ timeout: 15000 });

    // Stop RAF sampling and collect gaps
    const gaps: number[] = await page.evaluate(() => {
      const win = window as unknown as WindowWithRaf;
      win.__rafRunning = false;
      return win.__rafGaps || [];
    });

    // Ignore initial frame setup if present
    const scanGaps = gaps.slice(1);
    const maxGap = scanGaps.length > 0 ? Math.max(...scanGaps) : 0;

    console.log(`[MEASUREMENT] Maximum main-thread gap during heavy scan: ${maxGap.toFixed(2)} ms`);

    expect(errors).toEqual([]);
    // A completed scan must not have lost its worker: cancellation is the only
    // path that terminates one, and this test never cancels.
    expect(closedWorkers).toEqual([]);
    // Keep a little scheduling headroom for shared CI runners while still
    // catching a scan that blocks the main thread for a visibly long frame.
    expect(maxGap).toBeLessThanOrEqual(75);
  });
});
