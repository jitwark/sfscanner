import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { appPath } from './app-paths';
import { firstPrerenderedSubject } from './detail-subjects';

const cleanJson = fs.readFileSync(path.join(__dirname, 'fixtures', 'clean.json'), 'utf8');
const CREDENTIAL_CANARY = 'credential-secret-canary-b7d1';
const PARAMETER_CANARY = 'sk-live-parameter-canary-4f2a';
const KEY_CANARY = 'private-dynamic-key-canary';

const prerequisiteJson = JSON.stringify({
  name: 'Prerequisite canary',
  nodes: [
    { name: 'Duplicate', type: 'n8n-nodes-base.slack', typeVersion: 1, credentials: { 'a/b~c': { id: CREDENTIAL_CANARY, name: 'Shared account' } }, parameters: { options: { headers: { authorization: `Bearer ${PARAMETER_CANARY}` } } } },
    { name: 'Duplicate', type: 'n8n-nodes-base.slack', typeVersion: 2, credentials: { slackApi: { id: 'cred-2' } }, parameters: {} },
    { name: 'Community', type: 'n8n-nodes-acme.extension', typeVersion: '2.1', parameters: { url: '{{ $env.API_URL }}', [KEY_CANARY]: '{{ $env.HIDDEN }}' } },
    { name: 'Dynamic child', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1, parameters: { workflowId: '={{ $json.workflowId }}' } },
    { name: 'Literal child', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1, parameters: { workflowId: 'child-123' } },
    { name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 1, parameters: { text: '{{ $vars.MESSAGE }}' } },
  ],
  connections: {},
});

async function fillWorkflow(page: Page, value: string): Promise<void> {
  await page.getByLabel('Workflow JSON').evaluate((element, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function scan(page: Page, workflow: string): Promise<void> {
  await fillWorkflow(page, workflow);
  await page.getByRole('button', { name: 'Scan workflow' }).click();
  await expect(page.getByRole('heading', { name: 'Analysis coverage' })).toBeVisible({ timeout: 15_000 });
}

const FRAMEWORK_PREFETCH_PATHS = ['/', '/library/', '/takedown/'] as const;

async function isOptionalFrameworkPrefetch(request: Request, baseURL: string | undefined, offline: boolean): Promise<boolean> {
  if (!baseURL || request.method() !== 'HEAD' || request.resourceType() !== 'fetch') return false;
  if (!FRAMEWORK_PREFETCH_PATHS.some((path) => request.url() === new URL(appPath(path), baseURL).href)) return false;
  const headers = await request.allHeaders();
  if ('next-router-prefetch' in headers) return false;
  const failure = request.failure()?.errorText;
  const referer = new URL(appPath('/scanner/'), baseURL).href;
  if (offline) {
    return failure === 'net::ERR_INTERNET_DISCONNECTED'
      && headers.referer === referer
      && (headers['sec-fetch-dest'] === undefined || headers['sec-fetch-dest'] === 'empty');
  }
  return failure === 'net::ERR_ABORTED'
    && headers.referer === referer
    && headers['sec-fetch-dest'] === 'empty'
    && headers['sec-fetch-mode'] === 'cors'
    && headers['sec-fetch-site'] === 'same-origin';
}

async function recordUnexpectedFailure(request: Request, baseURL: string | undefined, offline: boolean, failures: string[]): Promise<void> {
  const label = `${request.failure()?.errorText ?? 'request failed'} ${request.url()}`;
  try {
    if (await isOptionalFrameworkPrefetch(request, baseURL, offline)) return;
  } catch {}
  failures.push(label);
}

test.describe('scanner first-release browser qualification', () => {
  test('renders closed prerequisites and safe provenance for a completed browser scan', async ({ page }) => {
    await page.goto(appPath('/scanner/'));
    await scan(page, prerequisiteJson);

    const prerequisites = page.getByRole('region', { name: 'Prerequisites and provenance' });
    await expect(prerequisites).toBeVisible();
    await expect(prerequisites).toContainText('Observations come from this workflow export');
    await expect(prerequisites.getByLabel('Prerequisite observation counts')).toContainText('Credentials: 2');
    await expect(prerequisites.getByLabel('Prerequisite observation counts')).toContainText('Environment references: 2');
    await expect(prerequisites.getByText('/nodes/0/credentials/a~1b~0c')).toBeVisible();
    await expect(prerequisites.getByText(/\$env\.API_URL/)).toBeVisible();
    await expect(prerequisites.getByText(/\$vars\.MESSAGE/)).toBeVisible();
    await expect(prerequisites.getByText('Live access: UNKNOWN').first()).toBeVisible();
    await expect(prerequisites.getByText('Environment value: UNKNOWN').first()).toBeVisible();
    await expect(prerequisites.getByRole('heading', { name: 'Export provenance' })).toBeVisible();
    await expect(prerequisites).toContainText('Source: WORKFLOW_EXPORT');
    await expect(prerequisites).toContainText('Repository: UNKNOWN');
    await expect(prerequisites).toContainText('Verification: UNKNOWN');

    const text = await prerequisites.innerText();
    expect(text).not.toContain(CREDENTIAL_CANARY);
    expect(text).not.toContain(PARAMETER_CANARY);
    expect(text).not.toContain(KEY_CANARY);
  });

  test('a fresh loaded scanner completes its first real worker scan offline', async ({ browser, baseURL }, testInfo) => {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    const evidence = { workers: [] as string[], requests: [] as string[], failures: [] as string[], httpErrors: [] as string[] };
    const failureChecks: Promise<void>[] = [];
    let disconnected = false;
    page.on('worker', (worker) => evidence.workers.push(worker.url()));
    context.on('request', (request) => { if (disconnected) evidence.requests.push(`${request.method()} ${request.url()}`); });
    context.on('requestfailed', (request) => {
      if (disconnected) failureChecks.push(recordUnexpectedFailure(request, baseURL, true, evidence.failures));
    });
    context.on('response', (response) => {
      if (disconnected && response.status() >= 400) evidence.httpErrors.push(`${response.status()} ${response.url()}`);
    });
    try {
      await page.goto(appPath('/scanner/'));
      await expect(page.getByLabel('Workflow JSON')).toBeVisible();
      const worker = page.workers()[0] ?? await page.waitForEvent('worker', { timeout: 15_000 });
      expect(worker.url()).not.toBe('');
      expect(await worker.evaluate(() => typeof self.postMessage)).toBe('function');
      await page.waitForLoadState('networkidle');
      await context.setOffline(true);
      disconnected = true;
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
      await scan(page, cleanJson);
      await expect(page.getByLabel('Analysis status: Analysis complete')).toBeVisible();
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
      expect(evidence.workers).toEqual([worker.url()]);
      await Promise.all(failureChecks);
      expect(evidence.failures).toEqual([]);
      expect(evidence.httpErrors).toEqual([]);
    } finally {
      await testInfo.attach('offline-worker-network-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
      await context.close();
    }
  });

  for (const width of [320, 768, 1024]) {
    test(`retries after a forced worker failure at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.addInitScript(() => {
        const OriginalWorker = window.Worker;
        let first = true;
        window.Worker = function (this: unknown, ...args: ConstructorParameters<typeof Worker>) {
          if (first) {
            first = false;
            throw new Error('forced worker failure');
          }
          return new OriginalWorker(...args);
        } as unknown as typeof Worker;
      });

      await page.goto(appPath('/scanner/'));
      await fillWorkflow(page, cleanJson);
      await page.getByRole('button', { name: 'Scan workflow' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'INTERNAL' }).first()).toBeVisible();

      const retry = page.getByRole('button', { name: 'Retry scan' });
      await expect(retry).toBeVisible();
      await retry.click();
      await expect(page.getByRole('heading', { name: 'Analysis coverage' })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByLabel('Analysis status: Analysis complete')).toBeVisible();
      expect(pageErrors).toEqual([]);
    });
  }

  test('downloads parseable COMPLETE JSON and SARIF reports', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(appPath('/scanner/'));
    await scan(page, cleanJson);
    await expect(page.getByLabel('Analysis status: Analysis complete')).toBeVisible();

    const jsonDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download redacted JSON' }).click();
    const jsonFile = await jsonDownload;
    expect(jsonFile.suggestedFilename()).toBe('secureflow-scan-report.json');
    const jsonPath = await jsonFile.path();
    expect(jsonPath, 'the JSON download produced a file').not.toBeNull();
    const exported = JSON.parse(fs.readFileSync(jsonPath!, 'utf8'));
    expect(exported.report.schemaVersion).toBe('scanner-result-v2');
    expect(exported.report.analysis.status).toBe('COMPLETE');
    expect(exported.report.assessment).toMatchObject({
      grade: expect.stringMatching(/^(?:LOW|MEDIUM|HIGH|CRITICAL)$/),
      score: expect.any(Number),
    });
    expect(exported.report.findings).toEqual([]);

    const sarifDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download SARIF 2.1.0' }).click();
    const sarifFile = await sarifDownload;
    expect(sarifFile.suggestedFilename()).toBe('secureflow-scan-report.sarif');
    const sarifPath = await sarifFile.path();
    expect(sarifPath, 'the SARIF download produced a file').not.toBeNull();
    const sarif = JSON.parse(fs.readFileSync(sarifPath!, 'utf8'));
    const [run] = sarif.runs;
    expect(sarif.version).toBe('2.1.0');
    expect(run.properties).toMatchObject({
      analysisStatus: 'COMPLETE',
      secureflow: expect.objectContaining({ analysisStatus: 'COMPLETE' }),
    });
    expect(run.invocations[0].executionSuccessful).toBe(true);
    expect(run.invocations[0].toolExecutionNotifications).toEqual([]);
    expect(run.results).toEqual([]);
  });

  test('hydrated workflow pages download a non-empty SVG', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const subject = firstPrerenderedSubject();
    await page.goto(appPath(`/w/${subject.slug}/`));
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download vector SVG' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/-diagram\.svg$/);
    const filePath = await file.path();
    expect(filePath, 'the SVG download produced a file').not.toBeNull();
    const bytes = fs.readFileSync(filePath!);
    const svg = bytes.toString('utf8');
    expect(bytes.length).toBeGreaterThan(1_024);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).not.toContain('\u0000');
  });

  test('a clean scanner run has no unexpected request failures or HTTP error responses', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const failures: string[] = [];
    const failureChecks: Promise<void>[] = [];
    let responsesObserved = 0;
    page.on('requestfailed', (request) => {
      failureChecks.push(recordUnexpectedFailure(request, baseURL, false, failures));
    });
    page.on('response', (response) => {
      responsesObserved += 1;
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
    });

    await page.goto(appPath('/scanner/'));
    await scan(page, cleanJson);
    await Promise.all(failureChecks);
    expect(responsesObserved).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
