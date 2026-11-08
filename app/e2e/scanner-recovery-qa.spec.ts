import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const cleanJson = fs.readFileSync(path.join(__dirname, 'fixtures', 'clean.json'), 'utf8');
const heavyJson = fs.readFileSync(path.join(__dirname, 'fixtures', 'heavy.json'), 'utf8');
const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? '').replace(/\/+$/, '');
const appPath = (pathname: string) => `${basePath}${pathname}`;

async function fillTextarea(page: Page, value: string): Promise<void> {
  await page.getByLabel('Workflow JSON').evaluate((element, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function submit(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Scan workflow' }).click();
}

test.describe('scanner recovery and accessible outcomes', () => {
  test('invalid JSON reports an accessible validation error without a report', async ({ page }) => {
    await page.goto(appPath('/scanner'));
    await fillTextarea(page, '{ invalid json');
    await submit(page);

    const alert = page.getByRole('alert').filter({ hasText: 'INVALID_JSON' });
    await expect(alert).toContainText('INVALID_JSON');
    await expect(alert).toContainText('not valid JSON');
    await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).not.toBeVisible();
    await expect(page.getByLabel(/Analysis status:/)).toHaveCount(0);
  });

  test('wrong root shape reports an accessible validation error without a report', async ({ page }) => {
    await page.goto(appPath('/scanner'));
    await fillTextarea(page, JSON.stringify({ credentials: {}, settings: {} }));
    await submit(page);

    const alert = page.getByRole('alert').filter({ hasText: 'NOT_A_WORKFLOW' });
    await expect(alert).toContainText('NOT_A_WORKFLOW');
    await expect(alert).toContainText('no n8n workflow nodes array');
    await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).not.toBeVisible();
  });

  test('correcting invalid input and retrying completes with an accessible status and focus target', async ({ page }) => {
    await page.goto(appPath('/scanner'));
    await fillTextarea(page, '{ invalid json');
    await submit(page);
    await expect(page.getByRole('alert').filter({ hasText: 'INVALID_JSON' })).toBeVisible();

    await fillTextarea(page, cleanJson);
    await submit(page);

    const coverage = page.getByRole('heading', { name: 'Analysis coverage', level: 2 });
    await expect(coverage).toBeVisible();
    await expect(coverage).toHaveAttribute('tabindex', '-1');
    await expect(page.getByRole('alert').filter({ hasText: /INVALID_JSON|NOT_A_WORKFLOW/ })).toHaveCount(0);
  });

  test('cancelling exposes idle controls and allows a fresh scan', async ({ page }) => {
    await page.goto(appPath('/scanner'));
    await fillTextarea(page, heavyJson);
    await submit(page);

    const cancel = page.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeVisible();
    await expect(page.locator('div[aria-busy="true"]')).toBeVisible();
    await cancel.dispatchEvent('click');

    await expect(cancel).not.toBeVisible();
    const action = page.getByRole('button', { name: 'Scan workflow' });
    await expect(action).toBeEnabled();
    await expect(page.getByLabel('Workflow JSON')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).not.toBeVisible();

    await fillTextarea(page, cleanJson);
    await submit(page);
    await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2 })).toBeVisible();
  });
});
