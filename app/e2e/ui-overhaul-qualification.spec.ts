import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
const related = '9a366a688a57c198,418dbcd24b4f3257,b0a8e7757835f64c,23989dded507086a,36a59699dc15cd56,3d67918986ec8b61';
const viewPath = `/w/view/?id=26006871febf2139&related=${related}`;
const leanPath = '/w/clientflow-lite-simple-onboarding-email-log-26006871/';

for (const width of [320, 768, 1024, 1440]) {
  test(`workflow summary and reported bookmark remain useful at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(`${basePath}${leanPath}`);
    const leanSummary = page.locator('section#security');
    await expect(leanSummary.getByRole('heading', { name: 'Security summary' })).toBeVisible();
    await expect(leanSummary).toContainText('Require webhook authentication or place the endpoint behind trusted controls.');
    await expect(leanSummary).toContainText('Review the code path, remove unnecessary scripting, and require approval.');
    await expect(leanSummary.getByRole('link')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`workflow-lean-${width}.png`), fullPage: true });

    await page.goto(`${basePath}${viewPath}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ClientFlow Lite — Simple Onboarding (Email + Log)');
    const security = page.locator('#security');
    await expect(security).toContainText('Require webhook authentication or place the endpoint behind trusted controls.');
    await expect(security).toContainText('Review the code path, remove unnecessary scripting, and require approval.');
    await expect(security.getByRole('link')).toHaveCount(0);
    await expect(page.locator('aside[aria-labelledby="related-heading"] > section').first().getByRole('link')).toHaveCount(6);
    const breadcrumbs = page.getByRole('navigation', { name: 'Breadcrumbs' });
    await breadcrumbs.getByRole('link', { name: 'Integrations', exact: true }).hover();
    await breadcrumbs.getByRole('link', { name: 'gmail', exact: true }).hover();
    await page.screenshot({ path: testInfo.outputPath(`workflow-view-${width}.png`), fullPage: true });
    await breadcrumbs.getByRole('link', { name: 'gmail', exact: true }).click();
    await expect(page).toHaveURL(/\/library\//);
    await expect(page).toHaveURL(/integration=gmail/);
    await expect(page.locator('#search-results-list')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`library-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });

  test(`analytics shows the bound snapshot without removed coverage sections at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${basePath}/analytics/`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('What is actually in the catalogue');
    await expect(page.locator('time')).toHaveText('7 Nov 2026');
    await expect(page.locator('time')).toHaveAttribute('datetime', '2026-11-07T09:32:14.957Z');
    await expect(page.getByRole('heading', { name: /^(Node semantics coverage|Scan coverage)$/i })).toHaveCount(0);
    const totals = page.getByRole('region', { name: 'Catalogue totals' });
    await expect(totals).toContainText('11,464');
    await expect(totals).toContainText('11,245');
    await expect(totals).toContainText('8,017');
    await expect(totals).toContainText('69.9%');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`analytics-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`analytics-light-${width}.png`), fullPage: true });
  });
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [320, 1440]) {
    test(`scanner decision and unavailable states are legible in ${theme} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${basePath}/scanner/`);
      if (theme === 'light') await page.getByRole('button', { name: 'Switch to light theme' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Check a workflow before you run it');
      await page.screenshot({ path: testInfo.outputPath(`scanner-input-${theme}-${width}.png`), fullPage: true });
      await page.getByRole('textbox', { name: 'Workflow JSON', exact: true }).fill(fs.readFileSync(path.join(__dirname, 'fixtures', 'clean.json'), 'utf8'));
      await page.getByRole('button', { name: 'Scan workflow', exact: true }).click();
      const decision = page.locator('[aria-labelledby="scanner-decision-heading"]');
      await expect(decision.getByText('Risk grade', { exact: true })).toBeVisible();
      await expect(decision.getByText('Risk score', { exact: true })).toBeVisible();
      await expect(decision.getByText('Analysis coverage', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Analysis coverage', level: 2, exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`scanner-result-${theme}-${width}.png`), fullPage: true });
      await decision.screenshot({ path: testInfo.outputPath(`scanner-decision-${theme}-${width}.png`) });
      const order = await page.evaluate(() => {
        const decision = document.getElementById('scanner-decision-heading')!;
        const findings = document.getElementById('scanner-findings-heading')!;
        const coverage = document.getElementById('scanner-v2-coverage-heading')!;
        return Boolean((decision.compareDocumentPosition(findings) & Node.DOCUMENT_POSITION_FOLLOWING)
          && (findings.compareDocumentPosition(coverage) & Node.DOCUMENT_POSITION_FOLLOWING));
      });
      expect(order).toBe(true);
      await page.getByRole('button', { name: 'Edit JSON', exact: true }).click();
      await page.getByRole('textbox', { name: 'Workflow JSON', exact: true }).fill(JSON.stringify({
        nodes: [{ id: 'Broken', name: 'Broken', type: 'n8n-nodes-base.discord', typeVersion: 1, parameters: 'not-an-object' }], connections: {},
      }));
      await page.getByRole('button', { name: 'Scan workflow', exact: true }).click();
      await expect(decision.getByText('No grade', { exact: true })).toBeVisible();
      await expect(decision.getByText('No score', { exact: true })).toBeVisible();
      await expect(decision.getByLabel(/^Risk score: \d/)).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`scanner-unavailable-${theme}-${width}.png`), fullPage: true });
    });
  }
}
