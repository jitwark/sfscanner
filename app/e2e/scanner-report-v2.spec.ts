import { expect, test, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { assertNoOverflow } from './web-qa-helpers';

const cleanJson = fs.readFileSync(path.join(__dirname, 'fixtures', 'clean.json'), 'utf8');
const maliciousJson = fs.readFileSync(path.join(__dirname, 'fixtures', 'malicious.json'), 'utf8');
const fallbackJson = fs.readFileSync(path.join(__dirname, 'fixtures', 'fallback.json'), 'utf8');
const heavyJson = fs.readFileSync(path.join(__dirname, 'fixtures', 'heavy.json'), 'utf8');
const RAW_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const MALICIOUS_SECRET = 'sk_live_12345678901234567890';
// A readable unmodelled node with no secret: both coverage codes, a real grade.
const unknownInnocentJson = JSON.stringify({
  nodes: [
    { id: 'Start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
    { id: 'Unknown', name: 'Unknown', type: 'n8n-nodes-base.discord', typeVersion: 1, parameters: { url: 'https://example.invalid/x' } },
  ],
  connections: { Start: { main: [[{ node: 'Unknown', type: 'main', index: 0 }]] } },
});
// `parameters` is not an object, so the generic fallback is refused and the worker
// returns INDETERMINATE with a null assessment (ADR-generic-node-semantic-fallback §4).
const unreadableParametersJson = JSON.stringify({
  nodes: [
    { id: 'Start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
    { id: 'Broken', name: 'Broken', type: 'n8n-nodes-base.discord', typeVersion: 1, parameters: 'not-an-object' },
  ],
  connections: {},
});
const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
const scannerPath = `${basePath}/scanner/`;
const viewports = [320, 768, 1024, 1440];

type WorkerResultV2 = {
  kind: string;
  result?: {
    analysis?: { status?: string };
    assessment?: { grade?: string; score?: number } | null;
    findings?: ReadonlyArray<{ ruleId?: string }>;
  };
};

type LateWorkerFrame = { kind: string; id: string; hasResult: boolean };

declare global {
  interface Window {
    __browserGradeWorkerMessages?: WorkerResultV2[];
    __lateWorkerProbe?: { requests: string[]; frames: LateWorkerFrame[] };
    __lateWorkerReap?: () => void;
  }
}

async function captureWorkerResults(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__browserGradeWorkerMessages = [];
    const BrowserWorker = window.Worker;
    window.Worker = class extends BrowserWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.addEventListener('message', (event) => { window.__browserGradeWorkerMessages?.push(event.data); });
      }
    };
  });
}

async function latestWorkerResult(page: Page): Promise<WorkerResultV2> {
  return page.evaluate(() => {
    const messages = window.__browserGradeWorkerMessages ?? [];
    const terminal = messages.filter((message) => message.kind === 'result-v2').at(-1);
    if (!terminal) throw new Error('no terminal v2 worker message');
    return terminal;
  });
}

async function clearWorkerResults(page: Page): Promise<void> {
  await page.evaluate(() => { window.__browserGradeWorkerMessages = []; });
}

/**
 * Test seam for the late-result cases. It suppresses `terminate()` *inside the page only* so a
 * cancelled or timed-out run stays alive long enough to answer its already-posted request; the
 * original native `Worker.prototype.terminate` is retained in `__lateWorkerReap` so
 * `test.afterEach` still reaps every worker on pass and on failure. The message listener is
 * registered at construction, before `scanner-v2-adapter.ts` assigns `onmessage` and before the
 * adapter drops ownership of the worker, so the real response is observable without changing the
 * adapter protocol. `deadlineMs` accelerates only the production 30s worker deadline.
 */
async function installLateWorkerProbe(page: Page, options: { delayMs?: number; deadlineMs?: number } = {}): Promise<void> {
  await page.addInitScript(({ delayMs, deadlineMs }) => {
    const probe: { requests: string[]; frames: LateWorkerFrame[] } = { requests: [], frames: [] };
    window.__lateWorkerProbe = probe;
    const workers: Worker[] = [];
    const NativeWorker = window.Worker;
    window.__lateWorkerReap = () => {
      for (const worker of workers.splice(0)) NativeWorker.prototype.terminate.call(worker);
    };
    if (deadlineMs !== null) {
      const nativeSetTimeout = window.setTimeout;
      window.setTimeout = function (handler: TimerHandler, timeout?: number, ...args: unknown[]) {
        return nativeSetTimeout(handler, timeout === 30_000 ? deadlineMs : timeout, ...args);
      } as typeof window.setTimeout;
    }
    window.Worker = class extends NativeWorker {
      constructor(scriptURL: string | URL, workerOptions?: WorkerOptions) {
        super(scriptURL, workerOptions);
        workers.push(this);
        this.addEventListener('message', (event: MessageEvent) => {
          const data = event.data as { kind?: unknown; id?: unknown } | null;
          if (data && typeof data.kind === 'string' && typeof data.id === 'string') {
            probe.frames.push({ kind: data.kind, id: data.id, hasResult: 'result' in data });
          }
        });
      }
      // Every termination path lands here — cancel and deadline alike. The real worker must
      // survive to answer its delayed request; `__lateWorkerReap` terminates it afterwards.
      terminate(): void {}
      postMessage(message: unknown, transfer: Transferable[]): void;
      postMessage(message: unknown, options?: StructuredSerializeOptions): void;
      postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
        const request = message as { id?: unknown } | null;
        // The ID is correlation input for the assertions below, never the proof itself.
        if (request && typeof request.id === 'string') probe.requests.push(request.id);
        window.setTimeout(() => {
          (super.postMessage as (value: unknown, options?: Transferable[] | StructuredSerializeOptions) => void)(message, transferOrOptions);
        }, delayMs);
      }
    } as unknown as typeof Worker;
  }, { delayMs: options.delayMs ?? 1_500, deadlineMs: options.deadlineMs ?? null });
}

async function waitForLateWorkerRequestId(page: Page): Promise<string> {
  await expect.poll(
    async () => page.evaluate(() => (window.__lateWorkerProbe?.requests.length ?? 0) > 0),
    { timeout: 5_000, message: 'the delayed scan-v2 request was posted to the worker' },
  ).toBe(true);
  const requestId = await page.evaluate(() => window.__lateWorkerProbe?.requests[0] ?? null);
  if (!requestId) throw new Error('the late-worker probe recorded no scan-v2 request ID');
  return requestId;
}

/**
 * Proof of the late result: the worker's own frame for that request, and only a `result-v2`
 * carrying a `result`. An outgoing request, an unrelated ID, an `error-v2`, or a page-side ack
 * cannot satisfy this.
 */
async function expectLateResultFrame(page: Page, requestId: string): Promise<void> {
  await expect.poll(
    async () => page.evaluate((id) => window.__lateWorkerProbe?.frames.some(
      (frame) => frame.kind === 'result-v2' && frame.id === id && frame.hasResult,
    ) ?? false, requestId),
    { timeout: 25_000, message: `the worker answered the delayed request ${requestId} with a real result-v2 frame` },
  ).toBe(true);
}

async function expectNoReportOrExport(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Download|Copy/ })).toHaveCount(0);
}

/**
 * Two frames after the recorded frame: the adapter's `onmessage` and any React commit it causes
 * have run, so a later render cannot slip past the following absence assertions.
 */
async function settleAfterFrame(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    return promise;
  });
}

function decisionSection(page: Page): Locator {
  return page.locator('section[aria-labelledby="scanner-decision-heading"]');
}

async function expectWorkerGradeRendered(page: Page): Promise<void> {
  const assessment = (await latestWorkerResult(page)).result?.assessment ?? null;
  expect(assessment, 'the worker retained an assessment').not.toBeNull();
  const decision = decisionSection(page);
  await expect(decision.getByText(`${assessment!.grade} risk`, { exact: true })).toBeVisible();
  await expect(decision.getByLabel(`Risk score: ${assessment!.score} out of 100`)).toBeVisible();
  await expect(decision.getByText('No grade')).toHaveCount(0);
}

async function fillWorkflow(page: Page, value: string): Promise<void> {
  await page.getByLabel('Workflow JSON').evaluate((element, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function tabUntilFocused(page: Page, target: Locator, maxTabs = 80): Promise<void> {
  for (let index = 0; index < maxTabs; index += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`Keyboard focus did not reach ${await target.getAttribute('aria-label') ?? await target.textContent()}`);
}

async function scan(page: Page, workflow: string): Promise<void> {
  await fillWorkflow(page, workflow);
  await page.getByRole('button', { name: 'Scan workflow' }).click();
  await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).toBeVisible({ timeout: 15000 });
}

function capturePageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test.describe('scanner report admission', () => {
  test.setTimeout(30_000);

  // The late-result seam keeps real workers alive past `terminate()`; reap them whether the
  // assertions passed or threw, using the native terminate retained by `installLateWorkerProbe`.
  test.afterEach(async ({ page }) => {
    try {
      await page.evaluate(() => { window.__lateWorkerReap?.(); });
    } catch {
      // The page was already torn down, so no worker of ours is still running.
    }
  });

  for (const width of viewports) {
    test(`keeps the v2 report with a legacy page-global v2 flag set at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      // `__SECUREFLOW_BROWSER_SCANNER_MODE__` was the pre-cutover page-global selector and is
      // read by no shipped code (`29dcb02` removed it). Setting it here asserts the legacy
      // global stays inert: the report is the v2 one either way.
      await page.addInitScript(() => {
        (window as unknown as Record<string, unknown>).__SECUREFLOW_BROWSER_SCANNER_MODE__ = 'v2';
      });

      const pageErrors = capturePageErrors(page);
      const consoleErrors: string[] = [];
      const requests: Array<{ url: string; method: string; postData: string | null }> = [];
      page.on('console', (message) => {
        if (message.type() === 'error' && !message.text().includes('Blocked cross-origin request')) {
          consoleErrors.push(message.text());
        }
      });
      page.on('request', (request) => requests.push({
        url: request.url(), method: request.method(), postData: request.postData(),
      }));

      await page.goto(scannerPath);
      await expect(page.getByLabel('Workflow JSON')).toBeVisible();
      await expect(page.getByLabel('Workflow JSON')).toHaveAccessibleName('Workflow JSON');
      await scan(page, maliciousJson);

      await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Evidence and conclusions' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Readiness and integrations' })).toHaveCount(0);
      const decision = decisionSection(page);
      await expect(decision.getByText(/^(?:LOW|MEDIUM|HIGH|CRITICAL) risk$/)).toBeVisible();
      await expect(decision.getByText('No grade')).toHaveCount(0);
      const bodyText = await page.locator('body').innerText();
      expect(bodyText).not.toContain(MALICIOUS_SECRET);
      expect(bodyText).not.toContain('/nodes/1/parameters');
      await expect(page.getByRole('button', { name: 'Scan workflow' })).toHaveAccessibleName('Scan workflow');
      await assertNoOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`scanner-v2-${width}.png`), fullPage: true });

      for (const request of requests) {
        const url = new URL(request.url);
        expect(['127.0.0.1', 'localhost'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol)).toBe(true);
        expect(['GET', 'HEAD']).toContain(request.method);
        expect(request.postData).toBeNull();
      }
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    });
  }

  test('renders the worker assessment for complete and degraded envelopes and withholds only a genuine indeterminate one', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await captureWorkerResults(page);
    const pageErrors = capturePageErrors(page);
    const consoleErrors: string[] = [];
    const requests: Array<{ url: string; method: string; postData: string | null }> = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('Blocked cross-origin request')) {
        consoleErrors.push(message.text());
      }
    });
    page.on('request', (request) => requests.push({ url: request.url(), method: request.method(), postData: request.postData() }));

    // 1. Modelled COMPLETE: the worker's grade and score, and a truthful empty state.
    await page.goto(scannerPath);
    await scan(page, cleanJson);
    await expect(page.getByLabel('Analysis status: Analysis complete')).toBeVisible();
    await expectWorkerGradeRendered(page);
    await expect(page.getByText(/No findings were returned for this scan\./).first()).toBeVisible();
    await assertNoOverflow(page);

    // 2. Readable unmodelled node: DEGRADED with both coverage codes, still graded.
    await clearWorkerResults(page);
    await page.goto(scannerPath);
    await scan(page, unknownInnocentJson);
    await expect(page.getByLabel('Analysis status: Standard scan')).toBeVisible();
    await expect(page.getByText(/Some node behavior is not modelled/i).first()).toBeVisible();
    await expect(page.getByText('SEMANTIC_CATALOGUE_MISS · DEGRADED')).toBeVisible();
    await expect(page.getByText('GENERIC_NODE_UNMODELED_CAPABILITY · DEGRADED')).toBeVisible();
    await expectWorkerGradeRendered(page);

    // 3. Unmodelled node with a raw secret: DEGRADED, graded, finding retained and redacted,
    //    and both downloads carry the real v2 envelope rather than the compatibility projection.
    await clearWorkerResults(page);
    await page.goto(scannerPath);
    await scan(page, fallbackJson);
    await expectWorkerGradeRendered(page);
    const findings = page.getByLabel('Critical and high findings');
    await expect(findings.getByText('Workflow parameters contain raw secret material')).toBeVisible();
    await expect(findings.getByText('RAW_SECRET_INDICATOR', { exact: true })).toBeVisible();
    await expect(findings.locator('article').first().getByText('HIGH', { exact: true })).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain(RAW_SECRET);

    const workerAssessment = (await latestWorkerResult(page)).result!.assessment!;
    const jsonDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download redacted JSON' }).click();
    const jsonFile = await jsonDownload;
    const jsonPath = await jsonFile.path();
    expect(jsonPath, 'the JSON download produced a file').not.toBeNull();
    const exported = JSON.parse(fs.readFileSync(jsonPath!, 'utf8'));
    expect(exported.report.schemaVersion).toBe('scanner-result-v2');
    expect(exported.report.analysis.status).toBe('DEGRADED');
    expect(exported.report.assessment.grade).toBe(workerAssessment.grade);
    expect(exported.report.findings.map((finding: { ruleId: string }) => finding.ruleId)).toContain('RAW_SECRET_INDICATOR');
    expect(JSON.stringify(exported)).not.toContain(RAW_SECRET);
    expect(JSON.stringify(exported)).not.toContain('POLICY_EXECUTION_FAILED');

    const sarifDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download SARIF 2.1.0' }).click();
    const sarifFile = await sarifDownload;
    const sarifPath = await sarifFile.path();
    expect(sarifPath, 'the SARIF download produced a file').not.toBeNull();
    const sarif = JSON.parse(fs.readFileSync(sarifPath!, 'utf8'));
    const run = sarif.runs[0];
    expect(run.invocations[0].executionSuccessful).toBe(true);
    expect(run.invocations[0].toolExecutionNotifications.map((item: { descriptor: { id: string } }) => item.descriptor.id))
      .toEqual(expect.arrayContaining(['SEMANTIC_CATALOGUE_MISS', 'GENERIC_NODE_UNMODELED_CAPABILITY']));
    expect(run.invocations[0].toolExecutionNotifications.map((item: { descriptor: { id: string } }) => item.descriptor.id))
      .not.toContain('POLICY_EXECUTION_FAILED');
    expect(run.results.map((item: { ruleId: string }) => item.ruleId)).toContain('RAW_SECRET_INDICATOR');
    expect(run.properties).toMatchObject({ analysisStatus: 'DEGRADED', riskGrade: workerAssessment.grade, secureflow: expect.objectContaining({ analysisStatus: 'DEGRADED' }) });
    expect(JSON.stringify(sarif)).not.toContain(RAW_SECRET);

    // 4. Genuinely unreadable parameters: worker assessment null, explicit No grade.
    await clearWorkerResults(page);
    await page.goto(scannerPath);
    await scan(page, unreadableParametersJson);
    await expect(page.getByLabel('Analysis status: Analysis incomplete')).toBeVisible();
    expect((await latestWorkerResult(page)).result?.assessment).toBeNull();
    const decision = decisionSection(page);
    await expect(decision.getByText('No grade')).toBeVisible();
    await expect(decision.getByText(/^(?:LOW|MEDIUM|HIGH|CRITICAL) risk$/)).toHaveCount(0);
    await expect(page.getByLabel(/^Risk score:/)).toHaveCount(0);
    await expect(page.getByText(/Analysis did not complete; no findings can be treated as conclusive/)).toBeVisible();
    await assertNoOverflow(page);

    for (const request of requests) {
      const url = new URL(request.url);
      expect(['127.0.0.1', 'localhost'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol)).toBe(true);
      expect(['GET', 'HEAD']).toContain(request.method);
      expect(request.postData).toBeNull();
    }
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('keeps editor and scan action in keyboard order and honors reduced motion', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const pageErrors = capturePageErrors(page);
    await page.goto(scannerPath);
    // The scan action is disabled — and therefore out of the tab order — until the editor holds
    // input, which is the shipped affordance (`scanner-input.tsx`, and the production-readiness
    // audit of 2026-09-23). Pressing Tab against an empty editor measures that disabled state, not
    // the keyboard order, so the JSON goes in first, exactly as `scanner-accessibility-qa.spec.ts`
    // does for the same assertion.
    await fillWorkflow(page, cleanJson);

    const editor = page.getByLabel('Workflow JSON');
    const scanButton = page.getByRole('button', { name: 'Scan workflow' });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await tabUntilFocused(page, editor);
    await expect(editor).toBeFocused();
    await tabUntilFocused(page, scanButton);
    await expect(scanButton).toBeFocused();

    const motion = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.animation = 'pulse 2s linear infinite';
      probe.style.transition = 'opacity 2s linear';
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const toMilliseconds = (value: string) => value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;
      const result = {
        animationDurationMs: toMilliseconds(style.animationDuration),
        transitionDurationMs: toMilliseconds(style.transitionDuration),
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      };
      probe.remove();
      return result;
    });
    expect(motion.animationDurationMs).toBeLessThanOrEqual(0.01);
    expect(motion.transitionDurationMs).toBeLessThanOrEqual(0.01);
    expect(motion.scrollBehavior).toBe('auto');
    expect(pageErrors).toEqual([]);
  });

  test('scans an unknown node through the real browser worker and labels both coverage codes', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(scannerPath);
    await scan(page, fallbackJson);

    await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).toBeVisible();
    await expect(page.getByLabel('Analysis status: Standard scan')).toBeVisible();
    await expect(page.getByText('SEMANTIC_CATALOGUE_MISS · DEGRADED').first()).toBeVisible();
    await expect(page.getByText('GENERIC_NODE_UNMODELED_CAPABILITY · DEGRADED').first()).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  });

  test('ignores a late worker frame after repeated cancel attempts and exposes no export', async ({ page }) => {
    // The delayed request must still be scanned by the real worker after the cancel, so this
    // case waits for the actual 507 KB fixture to finish on top of the 1.5s delivery delay.
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await installLateWorkerProbe(page);
    const pageErrors = capturePageErrors(page);
    await page.goto(scannerPath);
    await fillWorkflow(page, heavyJson);
    await page.getByRole('button', { name: 'Scan workflow' }).click();
    const cancel = page.getByRole('button', { name: 'Cancel scan' });
    await expect(cancel).toBeVisible();
    const requestId = await waitForLateWorkerRequestId(page);
    await cancel.evaluate((button) => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Cancel is terminal before the delayed request is even delivered.
    await expect(page.getByRole('button', { name: 'Cancel scan' })).toHaveCount(0);
    await expect(page.getByRole('progressbar', { name: 'Scan progress' })).toHaveCount(0);
    await expect(page.getByRole('status', { name: 'Scan status' })).toHaveText(/^$/);
    await expect(page.getByLabel('Workflow JSON')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Scan workflow' })).toBeEnabled();
    await expectNoReportOrExport(page);

    // The abandoned request still reaches the worker, which answers with a real result frame.
    // That frame must be refused by ownership, not merely made unreachable by terminate().
    await expectLateResultFrame(page, requestId);
    await settleAfterFrame(page);

    await expectNoReportOrExport(page);
    await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel scan' })).toHaveCount(0);
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    await expect(page.getByRole('status', { name: 'Scan status' })).toHaveText(/^$/);
    await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Scan workflow' })).toBeEnabled();
    expect(pageErrors).toEqual([]);
  });

  test('times out a silent worker, exposes retry, and withholds export', async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Accelerate only the production 30s deadline so the test exercises the real timeout
    // branch deterministically without holding the browser for the full wall-clock budget.
    // The seam also delays delivery and keeps the worker alive, so the run that missed its
    // deadline still answers instead of being silently unreachable.
    await installLateWorkerProbe(page, { deadlineMs: 100 });
    await page.goto(scannerPath);
    await fillWorkflow(page, cleanJson);
    await page.getByRole('button', { name: 'Scan workflow' }).click();
    const requestId = await waitForLateWorkerRequestId(page);
    const alert = page.getByRole('alert').filter({ hasText: 'TIMEOUT' }).first();
    await expect(alert).toBeVisible({ timeout: 5_000 });
    await expect(alert).toContainText('30-second local time budget');
    await expect(page.getByRole('button', { name: 'Retry scan' })).toBeVisible();
    await expectNoReportOrExport(page);

    // The timed-out request still reaches the worker and is really answered.
    await expectLateResultFrame(page, requestId);
    await settleAfterFrame(page);

    await expect(alert).toBeVisible();
    await expect(alert).toContainText('TIMEOUT');
    await expect(page.getByRole('button', { name: 'Retry scan' })).toBeVisible();
    await expectNoReportOrExport(page);
    await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).toHaveCount(0);
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel scan' })).toHaveCount(0);
  });

  test('retries after a forced worker failure', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const pageErrors = capturePageErrors(page);
    await page.addInitScript(() => {
      const OriginalWorker = window.Worker;
      let first = true;
      window.Worker = function (this: unknown, ...args: ConstructorParameters<typeof Worker>) {
        if (first) { first = false; throw new Error('forced worker failure'); }
        return new OriginalWorker(...args);
      } as unknown as typeof Worker;
    });
    await page.goto(scannerPath);
    await fillWorkflow(page, cleanJson);
    await page.getByRole('button', { name: 'Scan workflow' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'INTERNAL' }).first()).toBeVisible();
    const retry = page.getByRole('button', { name: 'Retry scan' });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).toBeVisible({ timeout: 15000 });
    await expect(pageErrors).toEqual([]);
  });
});
