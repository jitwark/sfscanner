import { expect, test, type Page } from '@playwright/test';
import { LIMITS } from '../../contracts/limits';

/**
 * P4-1 (11.1) matrix rows that had no coverage in `app/e2e` before this file:
 * adversarial document-nesting depths (255 accept / 256 reject / 513 reject), the
 * 10,000-node fast-fail, and the visible proof that the operator-supplied
 * expected-domain allowlist is not silently dropped (F-003).
 *
 * The limits asserted here are the product's own numbers, read from source:
 * `contracts/scanner-limits-v2.ts:69` (`maxDocumentDepth: 256`),
 * `packages/scanner-core/src/source/source-preflight.ts` (`MAX_SOURCE_PARSER_DEPTH = 512`),
 * `packages/scanner-core/src/source/source-tree.ts:62` (`depth > maxDocumentDepth` rejects), and
 * `contracts/scanner-limits.ts:36` (`maxNodes`). A fixture with `levels` nested arrays under the root
 * object reaches container depth `levels + 1`.
 *
 * Measured boundary, not assumed: `scanWorkflowV2` with `DEFAULT_SCANNER_LIMITS_V2` accepts 254 levels and
 * rejects 255 with `WORKFLOW_TOO_COMPLEX` / `DOCUMENT_DEPTH_LIMIT`. The plan's nominal pair (255 accept /
 * 256 reject) counts document depth from 0 at the root object; the shipped guard counts from 1, so the
 * plan's pair is this fixture's 254/255. Both sides of the edge are asserted below.
 */

const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

/**
 * The host's worker deadline. Read from `contracts/limits.ts` (`LIMITS.scanTimeoutMs`, which
 * `contracts/scanner-limits.ts` hands to the app as `DEFAULT_SCANNER_LIMITS.workerDeadlineMs` and
 * `run-scan.ts` arms as the timer that terminates the worker) instead of restated here, so the bound below
 * cannot drift from the deadline it enforces.
 */
const WORKER_DEADLINE_MS = LIMITS.scanTimeoutMs;

type TerminalMessage = { kind: string; code?: string; message?: string; result?: { schemaVersion?: string } };

declare global {
  interface Window {
    __scannerWorkerMessages?: unknown[];
  }
}

const TERMINAL_KINDS = ['result', 'result-v2', 'error', 'error-v2'];

/**
 * Records every worker message so a rejection can be asserted on the code the engine emits
 * (`WORKFLOW_TOO_COMPLEX`) rather than only on the copy the UI renders for it.
 */
async function captureWorkerMessages(page: Page): Promise<void> {
  await page.addInitScript((kinds: string[]) => {
    window.__scannerWorkerMessages = [];
    const BrowserWorker = window.Worker;
    window.Worker = class extends BrowserWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.addEventListener('message', (event) => {
          const data = event.data as { kind?: unknown } | null;
          if (typeof data === 'object' && data !== null && typeof data.kind === 'string' && kinds.includes(data.kind)) {
            window.__scannerWorkerMessages?.push(data);
          }
        });
      }
    };
  }, TERMINAL_KINDS);
}

async function waitForTerminal(page: Page): Promise<void> {
  await page.waitForFunction(
    (kinds: string[]) => {
      const messages = (window.__scannerWorkerMessages ?? []) as Array<{ kind?: unknown }>;
      return messages.some((message) => typeof message.kind === 'string' && kinds.includes(message.kind));
    },
    TERMINAL_KINDS,
    { timeout: 20_000 },
  );
}

function workflowWithNesting(levels: number): string {
  const nested = `${'['.repeat(levels)}0${']'.repeat(levels)}`;
  return `{"name":"Nesting Fixture","nodes":[{"id":"n1","name":"Trigger","type":"n8n-nodes-base.manualTrigger","typeVersion":1,"position":[0,0],"parameters":{}}],"connections":{},"metadata":${nested}}`;
}

/**
 * 10,000 over-budget node entries totalling 300,056 bytes — under the shared 1,536,000-byte `maxBytes`
 * budget, so the node count is the only budget this fixture can violate, and every entry names a real n8n
 * node type so the document reads as a wide export rather than a synthetic array.
 *
 * The bodies stay this thin because the cost of walking the document is what decides whether the shipped
 * engine's rejection beats the host's deadline at all. Measured in Chromium against the shipped
 * export at this same node count (with the host deadline then 5,000 ms): 1,190-1,437 ms for these entries, 1,794-2,303 ms when each also carries
 * an `id`, 2,534-4,893 ms when each carries `id` and `parameters` (and past the deadline on one attempt),
 * and never inside the deadline when the entries are shaped like a real export (1,125,836 bytes).
 * `app/src/scanner/scan.worker.ts` counts the entries before the engine walks the document, which is what
 * removes the timing from the outcome.
 */
function workflowWithNodes(count: number): string {
  const nodes = Array.from({ length: count }, () => '{"type":"n8n-nodes-base.set"}').join(',');
  return `{"name":"Many Nodes Fixture","nodes":[${nodes}],"connections":{}}`;
}

function workflowWithDestination(url: string): string {
  return `{"name":"Destination Fixture","nodes":[{"id":"h1","name":"HTTP","type":"n8n-nodes-base.httpRequest","typeVersion":1,"position":[0,0],"parameters":{"url":"${url}"}}],"connections":{}}`;
}

async function submit(page: Page, json: string): Promise<void> {
  await page.getByLabel('Workflow JSON').fill(json);
  await page.getByRole('button', { name: 'Scan workflow' }).click();
}

async function setExpectedDomains(page: Page, value: string): Promise<void> {
  const input = page.locator('#domains-input');
  if (!(await input.isVisible())) await page.getByRole('button', { name: 'Expected domains' }).click();
  await input.fill(value);
}

test.describe('scanner v2 adversarial input limits', () => {
  test.beforeEach(async ({ page }) => {
    await captureWorkerMessages(page);
    await page.goto(`${basePath}/scanner`);
  });

  test('document nesting just inside the boundary (254 levels) is accepted and returns a v2 result', async ({ page }) => {
    await submit(page, workflowWithNesting(254));
    await waitForTerminal(page);

    const terminals = (await page.evaluate(() => window.__scannerWorkerMessages ?? [])) as unknown as TerminalMessage[];
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ kind: 'result-v2', result: { schemaVersion: 'scanner-result-v2' } });
    await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).toBeVisible({ timeout: 15_000 });
    // The scanner error panel is the only alert with the code line; Next's route announcer is also role=alert.
    await expect(page.getByText('V2_TOO_COMPLEX', { exact: true })).toHaveCount(0);
  });

  test('document nesting at the boundary (255 levels) is rejected as WORKFLOW_TOO_COMPLEX with the v2 too-complex notice', async ({ page }) => {
    await submit(page, workflowWithNesting(255));
    await waitForTerminal(page);

    const terminals = (await page.evaluate(() => window.__scannerWorkerMessages ?? [])) as unknown as TerminalMessage[];
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.kind).toBe('error-v2');
    expect(terminals[0]?.code).toBe('WORKFLOW_TOO_COMPLEX');
    await expect(page.getByRole('alert').filter({ hasText: 'V2_TOO_COMPLEX' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).toHaveCount(0);
  });

  test('document nesting far beyond the boundary (513 levels) is rejected as WORKFLOW_TOO_COMPLEX', async ({ page }) => {
    await submit(page, workflowWithNesting(513));
    await waitForTerminal(page);

    const terminals = (await page.evaluate(() => window.__scannerWorkerMessages ?? [])) as unknown as TerminalMessage[];
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.kind).toBe('error-v2');
    expect(terminals[0]?.code).toBe('WORKFLOW_TOO_COMPLEX');
    await expect(page.getByRole('alert').filter({ hasText: 'V2_TOO_COMPLEX' })).toBeVisible();
  });

  test('10,000 nodes fast-fails as WORKFLOW_TOO_COMPLEX rather than reaching the 30 s worker deadline', async ({ page }) => {
    // The fixture is pushed through the editor untimed: that cost belongs to the test's own fixture
    // handling, not to the scan this case bounds. The clock starts immediately before the click that starts
    // the scan and therefore also carries the driver round-trip that delivers it, so it measures the slower
    // end of what the user waits.
    await page.getByLabel('Workflow JSON').fill(workflowWithNodes(10_000));
    const startedAt = Date.now();
    await page.getByRole('button', { name: 'Scan workflow' }).click();
    await waitForTerminal(page);
    const elapsedMs = Date.now() - startedAt;

    const terminals = (await page.evaluate(() => window.__scannerWorkerMessages ?? [])) as unknown as TerminalMessage[];
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.kind).toBe('error-v2');
    expect(terminals[0]?.code).toBe('WORKFLOW_TOO_COMPLEX');
    // Bound from the contract, not invented: `WORKER_DEADLINE_MS` is the timer that tears the worker down,
    // and the requirement is that this rejection lands inside it rather than at it. The shipped engine
    // spends 1,190-1,437 ms of that budget on this fixture, because the node budget is evaluated only after
    // `parseSourceDocument` has walked the document; the gate that removes that walk is guarded by
    // `app/src/scanner/scan.worker.test.ts`, which asserts the engine is never called for such a document.
    expect(elapsedMs).toBeLessThan(WORKER_DEADLINE_MS);
    console.log(`[MEASUREMENT] 10,000-node fast-fail: ${elapsedMs} ms of the ${WORKER_DEADLINE_MS} ms worker deadline`);
    await expect(page.getByRole('alert').filter({ hasText: 'V2_TOO_COMPLEX' })).toBeVisible();
    // The host deadline terminates the worker, so a TIMEOUT leaves no terminal message behind at all and
    // this panel is the only thing on screen: the bound above can never be satisfied by a timed-out scan.
    await expect(page.getByRole('alert').filter({ hasText: 'TIMEOUT' })).toHaveCount(0);
  });

  test('the expected-domain allowlist visibly changes the report instead of being dropped (F-003)', async ({ page }) => {
    const destination = 'api.untrusted.example';

    await setExpectedDomains(page, 'api.other.example');
    await submit(page, workflowWithDestination(`https://${destination}/v1/items`));
    await waitForTerminal(page);

    const excluded = (await page.evaluate(() => window.__scannerWorkerMessages ?? [])) as unknown as TerminalMessage[];
    expect(excluded[0]?.kind).toBe('result-v2');
    await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).toBeVisible({ timeout: 15_000 });
    // The finding's rule id is rendered whether or not a rule-reference URL is configured
    // (the link itself is covered by `report-trust.test.tsx`); this asserts the allowlist
    // change is visible in the report.
    await expect(page.getByText('UNAPPROVED_DOMAIN', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Edit JSON' }).click();
    await setExpectedDomains(page, destination);
    await page.getByRole('button', { name: 'Scan workflow' }).click();
    await page.waitForFunction(
      () => ((window.__scannerWorkerMessages ?? []) as unknown[]).length >= 2,
      undefined,
      { timeout: 20_000 },
    );
    await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).toBeVisible({ timeout: 15_000 });

    const included = (await page.evaluate(() => window.__scannerWorkerMessages ?? [])) as unknown as TerminalMessage[];
    expect(included).toHaveLength(2);
    expect(included[1]?.kind).toBe('result-v2');
    await expect(page.getByText('UNAPPROVED_DOMAIN', { exact: true })).toHaveCount(0);
  });
});
