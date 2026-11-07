import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { assertNoOverflow } from './web-qa-helpers';

/**
 * The 11.3 four-breakpoint exit required the scanner's **input** surface
 * (`scanner-responsive.spec.ts`) and its **report** (`scanner-report-v2.spec.ts`)
 * at 320 / 768 / 1024 / 1440 px, but the cancellation and error surfaces were
 * only ever exercised at Playwright's default 1280×720 viewport
 * (`scanner.spec.ts:127`, `scanner-recovery-qa.spec.ts`, `scanner-v2-limits-qa.spec.ts`).
 * This file closes that gap: each state is rendered and measured at all four widths,
 * so a width-specific regression in the cancellation affordance or the alert copy
 * (the two surfaces that card/padding changes hit hardest at 320 px) fails here.
 */

const heavyJson = fs.readFileSync(path.join(__dirname, 'fixtures', 'heavy.json'), 'utf8');
const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
const scannerPath = `${basePath}/scanner/`;
const viewports = [320, 768, 1024, 1440];

/**
 * A fixture with `levels` nested arrays under the root object. `levels = 255` is the
 * measured rejection edge for the shipped guard (`scanner-v2-limits-qa.spec.ts` records
 * the calibration: 254 accepted, 255 rejected with `WORKFLOW_TOO_COMPLEX`).
 */
function workflowWithNesting(levels: number): string {
  const nested = `${'['.repeat(levels)}0${']'.repeat(levels)}`;
  return `{"name":"Nesting Fixture","nodes":[{"id":"n1","name":"Trigger","type":"n8n-nodes-base.manualTrigger","typeVersion":1,"position":[0,0],"parameters":{}}],"connections":{},"metadata":${nested}}`;
}

async function startScan(page: Page, workflow: string): Promise<void> {
  // The `heavy.json` cancellation fixture is ~507 KB; Playwright's `fill` exceeds its
  // 30 s timeout on it. The native-setter + `input` dispatch is the technique
  // `scanner.spec.ts` and `scanner-recovery-qa.spec.ts` already use for the same
  // reason, so it is reused here rather than re-derived.
  await page.getByLabel('Workflow JSON').evaluate((element, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, workflow);
  await page.getByRole('button', { name: 'Scan workflow' }).click();
}

for (const width of viewports) {
  test.describe(`scanner cancellation and error surfaces at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(scannerPath);
    });

    test('cancelling returns the page to idle with no stale report', async ({ page }) => {
      await startScan(page, heavyJson);

      const cancel = page.getByRole('button', { name: 'Cancel' });
      await expect(cancel).toBeVisible();
      // The progress stream can replace the control between actionability checks;
      // dispatching against the rendered node exercises the same React handler
      // without racing that stream (the same technique `scanner.spec.ts:127` uses).
      await cancel.dispatchEvent('click');

      await expect(cancel).not.toBeVisible();
      await expect(page.getByRole('button', { name: 'Scan workflow' })).toBeEnabled();
      await expect(page.getByRole('heading', { name: 'Analysis coverage' })).toHaveCount(0);
      await assertNoOverflow(page);
    });

    test('an invalid-JSON error is announced, leaves no report, and does not overflow', async ({ page }) => {
      await startScan(page, '{ invalid json');

      const alert = page.getByRole('alert').filter({ hasText: 'INVALID_JSON' });
      await expect(alert).toBeVisible();
      await expect(alert).toContainText('not valid JSON');
      await expect(page.getByRole('heading', { name: 'Analysis coverage' })).toHaveCount(0);
      await assertNoOverflow(page);
    });

    test('a too-complex rejection notice is visible, leaves no report, and does not overflow', async ({ page }) => {
      await startScan(page, workflowWithNesting(255));

      const notice = page.getByRole('alert').filter({ hasText: 'V2_TOO_COMPLEX' });
      await expect(notice).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Analysis coverage' })).toHaveCount(0);
      await assertNoOverflow(page);
    });
  });
}
