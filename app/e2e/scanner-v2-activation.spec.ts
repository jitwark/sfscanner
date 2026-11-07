import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const cleanWorkflow = fs.readFileSync(path.join(__dirname, 'fixtures', 'clean.json'), 'utf8');
const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
const terminalKinds: Record<string, true> = {
  result: true,
  'result-v2': true,
  error: true,
  'error-v2': true,
};

declare global {
  interface Window {
    __scannerWorkerMessages?: unknown[];
  }
}

function isTerminalWorkerMessage(message: unknown): boolean {
  return typeof message === 'object' && message !== null && 'kind' in message
    && typeof message.kind === 'string' && Object.hasOwn(terminalKinds, message.kind);
}

test('submits a workflow and receives the current v2 result envelope', async ({ page }) => {
  await page.addInitScript(() => {
    window.__scannerWorkerMessages = [];
    const BrowserWorker = window.Worker;

    window.Worker = class extends BrowserWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.addEventListener('message', (event) => {
          window.__scannerWorkerMessages?.push(event.data);
        });
      }
    };
  });

  await page.goto(`${basePath}/scanner/`);
  await page.getByLabel('Workflow JSON').fill(cleanWorkflow);
  await page.getByRole('button', { name: 'Scan workflow' }).click();

  await page.waitForFunction(
    (kinds: Record<string, true>) => {
      const messages = window.__scannerWorkerMessages ?? [];
      return messages.some((message) => typeof message === 'object' && message !== null && 'kind' in message
        && typeof message.kind === 'string' && Object.hasOwn(kinds, message.kind));
    },
    terminalKinds,
    { timeout: 15_000 },
  );

  const messages = await page.evaluate(() => window.__scannerWorkerMessages ?? []);
  const terminalResponses = messages.filter(isTerminalWorkerMessage);

  expect(terminalResponses).toHaveLength(1);
  expect(terminalResponses[0]).toMatchObject({
    kind: 'result-v2',
    result: {
      schemaVersion: 'scanner-result-v2',
      engine: {
        id: 'secureflow-scanner',
        version: expect.any(String),
        buildDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      input: {
        rawSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        semanticSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        ambiguitySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      profile: { id: 'beta-default', version: '2.0.0' },
      analysis: {
        status: expect.stringMatching(/^(COMPLETE|DEGRADED|INDETERMINATE)$/),
        capabilities: expect.any(Array),
        diagnostics: expect.any(Array),
      },
      workflow: {
        name: 'Clean Workflow Example',
        nodeCount: 2,
        rawNodeCount: 2,
        edgeCount: 1,
      },
      limits: { schemaVersion: 'scanner-limits-v2', usage: expect.any(Array) },
      facts: expect.any(Array),
      traces: expect.any(Array),
      findings: expect.any(Array),
      stats: { omittedFindings: expect.any(Number) },
    },
  });
});
