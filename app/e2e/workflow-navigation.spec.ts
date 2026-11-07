import { expect, test } from '@playwright/test';
import { firstLeanSubject } from './detail-subjects';
import { appPath } from './app-paths';

test.describe('workflow detail navigation', () => {
  test('link-only cards resolve through the manifest index', async ({ page }) => {
    const failures: string[] = [];
    const chartRequests: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    page.on('requestfailed', (request) => {
      if (request.failure()?.errorText !== 'net::ERR_ABORTED') failures.push(`request failed: ${request.url()}`);
    });
    page.on('request', (request) => {
      if (request.url().includes('/data/charts/')) chartRequests.push(request.url());
    });
    // A bare "Failed to load resource: 404" from the console names nothing, and
    // a four-line array of identical strings is not a diagnosis.
    page.on('response', (response) => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
    });
    // The card must still resolve through the library — that is what this spec
    // is about — but the card has to be one whose detail page is LEAN, because
    // the deferred canvas below only exists there. Filtering to link-only was
    // the previous attempt at determinism and did not work: link-only is 97.5%
    // of the corpus. See `detail-subjects.ts`.
    const subject = firstLeanSubject();
    await page.goto(appPath(`/library/?q=${encodeURIComponent(subject.title)}`));
    // A list, not a listbox: the results are a <ul aria-label="Workflow
    // results">. This spec had asked for a role the page has never had.
    // Located by href, not by a regex over the title: a title can contain
    // regex metacharacters, and escaping them here would be the only reason
    // this line was hard to read.
    const card = page.getByRole('list', { name: 'Workflow results' })
      .locator(`a[href="${appPath(`/w/${subject.slug}/`)}"]`)
      .first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Every entry has a slug page now, so a result never routes to the client
    // shell. `/w/view/?id=` is where the canvas lives, one click on from here.
    await card.click();
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('body')).not.toContainText('Workflow not found');

    // The long tail carries a static preview and an explicit way to reach the
    // client-only interactive view. The view must still make no chart request
    // until its explicit action.
    await page.getByRole('link', { name: /Open the interactive view/i }).click();
    await expect(page.getByRole('button', { name: /Explore interactive canvas/i })).toBeVisible({ timeout: 30_000 });
    expect(chartRequests).toEqual([]);
    await page.getByRole('button', { name: /Explore interactive canvas/i }).click();
    // role="group", not role="img". The static default has no chart request;
    // this assertion proves the existing interactive canvas still works after
    // the explicit opt-in.
    await expect(page.getByRole('group', { name: /Workflow diagram/ })).toBeVisible({ timeout: 30_000 });
    expect(failures).toEqual([]);
  });

  test('unknown IDs render an accessible error state', async ({ page }) => {
    await page.goto(appPath('/w/view/?id=unknown-workflow-id-for-e2e'));
    await expect(page.getByRole('heading', { name: 'Workflow not found' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to library' })).toBeVisible();
  });
});
