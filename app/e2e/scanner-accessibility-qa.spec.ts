import { expect, test, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const cleanJson = fs.readFileSync(path.join(__dirname, 'fixtures', 'clean.json'), 'utf8');
// A workflow the engine genuinely cannot assess: `parameters` is not an object, so the
// generic-node fallback is refused and the result stays `INDETERMINATE` with a null
// assessment (`docs/decisions/ADR-generic-node-semantic-fallback.md` §4). That is the
// withheld state this test drives; "Decision and next step" also renders for a graded
// result, so this is not its only consumer.
const unreadableParametersJson = JSON.stringify({
  nodes: [
    { id: 'Start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
    { id: 'Broken', name: 'Broken', type: 'n8n-nodes-base.googleSheets', typeVersion: 1, parameters: 'not-an-object' },
  ],
  connections: {},
});
const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? '').replace(/\/+$/, '');
const scannerPath = `${basePath}/scanner`;

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

async function hasVisibleFocusIndicator(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    return (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0)
      || style.boxShadow !== 'none';
  });
}

test.describe('scanner accessibility and zoom evidence', () => {
  test('exposes labelled input, primary controls, and page landmarks', async ({ page }) => {
    await page.goto(scannerPath);

    await expect(page.locator('main#main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: 'Check a workflow before you run it' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Scan a workflow' })).toBeVisible();
    await expect(page.getByLabel('Workflow JSON')).toBeVisible();
    await expect(page.getByLabel('Workflow JSON')).toHaveAttribute('id', 'workflow-json');
    await expect(page.getByRole('button', { name: 'Scan workflow' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload .json' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load safe sample' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Expected domains' })).toBeVisible();
  });

  test('reaches the editor and scan action by keyboard with visible focus and touch-sized controls', async ({ page }) => {
    await page.goto(scannerPath);

    const editor = page.getByLabel('Workflow JSON');
    const scanButton = page.getByRole('button', { name: 'Scan workflow' });
    await fillWorkflow(page, cleanJson);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await tabUntilFocused(page, editor);
    await expect(editor).toBeFocused();
    expect(await hasVisibleFocusIndicator(editor)).toBe(true);

    await tabUntilFocused(page, scanButton);
    await expect(scanButton).toBeFocused();
    expect(await hasVisibleFocusIndicator(scanButton)).toBe(true);

    for (const control of [
      page.getByRole('button', { name: 'Upload .json' }),
      page.getByRole('button', { name: 'Load safe sample' }),
      page.getByRole('button', { name: 'Expected domains' }),
      scanButton,
    ]) {
      await expect(control).toHaveClass(/min-h-11/);
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test('honours reduced-motion preferences for scanner-page transitions and scrolling', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(scannerPath);

    const motion = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.animation = 'pulse 2s linear infinite';
      probe.style.transition = 'opacity 2s linear';
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const toMilliseconds = (value: string) => value.endsWith('ms')
        ? Number.parseFloat(value)
        : Number.parseFloat(value) * 1000;
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
  });

  test('does not introduce horizontal overflow at a 200 percent zoom approximation', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await page.goto(scannerPath);
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });

    const overflow = await page.evaluate(() => ({
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      viewportWidth: window.innerWidth,
    }));
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
  });

  test('keeps completed report headings and focus target reachable', async ({ page }) => {
    await page.goto(scannerPath);
    await fillWorkflow(page, cleanJson);
    await page.getByRole('button', { name: 'Scan workflow' }).click();

    const coverage = page.getByRole('heading', { name: 'Analysis coverage', level: 2 });
    await expect(coverage).toBeVisible({ timeout: 15000 });
    await expect(coverage).toHaveAttribute('tabindex', '-1');
    await expect(coverage).toBeFocused();

    for (const name of [
      // The v2 report's section headings on a graded result. "Analyst summary" and
      // "Readiness and integrations" were v1 surfaces and left with the cutover.
      'Evidence and conclusions',
      'Applicability and target context',
      'Verified traces',
      'Critical and high findings',
      'Remediation',
      'Export or copy',
    ]) {
      const heading = page.getByRole('heading', { name });
      await heading.scrollIntoViewIfNeeded();
      await expect(heading).toBeVisible();
    }

    // "Decision and next step" now renders for graded results too; this second scan keeps a
    // subject that genuinely reaches the withheld state, so the same heading is proven on a
    // no-grade report as well, on a fresh page so a stale report cannot satisfy the assertion.
    await page.goto(scannerPath);
    await fillWorkflow(page, unreadableParametersJson);
    await page.getByRole('button', { name: 'Scan workflow' }).click();
    await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).toBeVisible({ timeout: 15000 });
    const decision = page.getByRole('heading', { name: 'Decision and next step' });
    await decision.scrollIntoViewIfNeeded();
    await expect(decision).toBeVisible();
  });
});
