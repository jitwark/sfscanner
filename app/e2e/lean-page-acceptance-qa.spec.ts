import fs from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { firstLeanSubject, leanSubjects } from './detail-subjects';

/**
 * Phase 4.3c acceptance for FE-05 and FE-07 on the **lean pages** — the 11,214
 * surface the hydrated React components never touch.
 *
 * A lean page is one static HTML file: no framework chunks, no hydration, and
 * `canvas-viewport.tsx` never runs on it. Its canvas comes from
 * `app/src/ui/detail/lean-enhancements-script.ts`, so that string has to be
 * accepted against the served bytes or not at all. There is no component test
 * that can stand in for this file. The byte-range workflow download that script
 * also carries has no control left to attach to, and the last case asserts that
 * it stays that way.
 *
 * Input goes through the browser's own pipeline (`Input.dispatchTouchEvent` with
 * touch emulation, `Input.dispatchMouseEvent` with `pointerType`) exactly as
 * `interaction-acceptance-qa.spec.ts` drives the hydrated component: a
 * synthesized `PointerEvent` cannot be captured by `setPointerCapture` and
 * throws `NotFoundError`, which would break the zero-page-error requirement.
 */

const basePath = (process.env.PLAYWRIGHT_BASE_PATH ?? process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

const DRAG = { dx: 60, dy: 40 } as const;
const WIDTHS = [320, 768, 1024, 1440] as const;
const NOTICE_WIDTHS = [320, 1440] as const;
const VIEWPORT_HEIGHT = 900;

/**
 * One drag, one string — the static script and the hydrated view emit the same
 * inline transform for it, which is what keeps the two surfaces comparable.
 */
const DRAGGED = `translate(${DRAG.dx}px, ${DRAG.dy}px) scale(1)`;
const SERVED = 'translate(0px, 0px) scale(1)';

/** Every role carrying an implicit live region, per MDN's live-region role table. */
const LIVE_REGIONS = '[aria-live], [role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"], [role="progressbar"]';

const panTransform = (target: Locator) => target.evaluate((element) => (element as HTMLElement).style.transform);

/** Two frames after the last dispatched input: what the browser did with it has settled. */
const settleFrames = (page: Page) => page.evaluate(() => {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  return promise;
});

async function openLeanPage(page: Page, width: number, subject = firstLeanSubject()) {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  await page.goto(`${basePath}/w/${subject.slug}/`);
  await expect(page.getByRole('heading', { level: 1, name: subject.title })).toBeVisible({ timeout: 30_000 });
  return subject;
}

async function openLeanCanvas(page: Page, width: number) {
  await openLeanPage(page, width);

  const viewport = page.locator('[data-canvas-viewport]').first();
  const stage = viewport.locator('> [role="img"]');
  const target = viewport.locator('[data-viewport-target]').first();
  await expect(stage, 'canvas stage').toHaveCount(1);
  // The enhancement script, not React: it marks the viewport it wired, and a
  // lean page has no React to do it instead.
  await expect(viewport, 'the static behaviour script enhanced the canvas').toHaveAttribute('data-enhanced', '1');

  await viewport.scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).click();
  return { viewport, stage, target };
}

/** Presses, drags by DRAG and releases — a complete gesture in one pointer type. */
async function pressAndDrag(page: Page, stage: Locator, pointerType: 'mouse' | 'pen' | 'touch') {
  const box = await stage.boundingBox();
  if (!box) throw new Error('the canvas stage has no box');
  const start = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const end = { x: start.x + DRAG.dx, y: start.y + DRAG.dy };
  const client = await page.context().newCDPSession(page);

  if (pointerType === 'touch') {
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start.x, y: start.y, id: 1 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: end.x, y: end.y, id: 1 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  } else {
    const dispatch = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number, y: number, buttons: number) =>
      client.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, pointerType });
    await dispatch('mousePressed', start.x, start.y, 1);
    await dispatch('mouseMoved', end.x, end.y, 1);
    await dispatch('mouseReleased', end.x, end.y, 0);
  }

  return { client, end };
}

for (const width of NOTICE_WIDTHS) {
  test(`the lean pre-run notice is static text, not a live region, at ${width}px`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openLeanPage(page, width);

    // `section`, because the anchor id belongs to the labelled landmark: the
    // section carries it, and the wrapper div that used to duplicate it is gone.
    const notice = page.locator('section#before-you-run');
    await expect(notice, 'pre-run notice').toHaveCount(1);
    await expect(notice).toContainText(
      'Detailed deterministic pre-run checks are available in the interactive view. Review them before importing.',
    );

    const liveRegions = await notice.evaluate(
      (element, selector) => Array.from(element.querySelectorAll(selector))
        .map((node) => `${node.tagName.toLowerCase()}${node.getAttribute('role') ? `[${node.getAttribute('role')}]` : '[aria-live]'}`),
      LIVE_REGIONS,
    );
    expect(liveRegions, `live regions inside the pre-run notice at ${width}px`).toEqual([]);

    // The served page is the only place this is checkable: `aria-labelledby` and
    // `#before-you-run` are resolved by the browser over the whole document, and
    // a duplicated id silently resolves to whichever copy came first.
    const duplicateIds = await page.evaluate(() => {
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const element of document.querySelectorAll('[id]')) {
        if (seen.has(element.id)) duplicates.add(element.id);
        seen.add(element.id);
      }
      return [...duplicates];
    });
    expect(duplicateIds, `ids emitted twice in one served page at ${width}px`).toEqual([]);

    expect(pageErrors).toEqual([]);
  });
}

for (const width of WIDTHS) {
  test(`the lean canvas pans with mouse, touch and pen at ${width}px`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const { stage, target } = await openLeanCanvas(page, width);
    const reset = page.getByRole('button', { name: 'Reset zoom to 100%' });

    for (const pointerType of ['mouse', 'pen', 'touch'] as const) {
      const { client, end } = await pressAndDrag(page, stage, pointerType);
      await expect.poll(() => panTransform(target), { message: `${pointerType}: the drag pans the lean canvas` }).toBe(DRAGGED);

      // A released pointer must not keep panning; the move that proves it is
      // dispatched through the same pipeline the gesture used.
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: end.x + 200,
        y: end.y + 200,
        buttons: 0,
        pointerType: pointerType === 'touch' ? 'mouse' : pointerType,
      });
      await settleFrames(page);
      expect(await panTransform(target), `${pointerType}: a released pointer stops panning`).toBe(DRAGGED);

      await client.detach();
      await reset.click();
      expect(await panTransform(target), `${pointerType}: reset returns to the served state`).toBe(SERVED);
    }

    // The rest of the script: the controls it owns, on the same served page.
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(reset, 'zoom in').toHaveText('125%');
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect(reset, 'zoom out').toHaveText('100%');

    const svgDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download vector SVG' }).click();
    const svgFile = await svgDownload;
    expect(svgFile.suggestedFilename(), 'the SVG download').toBe('workflow-diagram.svg');
    const svgPath = await svgFile.path();
    expect(svgPath, 'the SVG download produced a file').not.toBeNull();
    expect(fs.readFileSync(svgPath!, 'utf8'), 'the downloaded file is the rendered diagram').toContain('<svg');

    // ctrl+wheel zooms and is consumed; a plain wheel is left to the page.
    // 2 is the CDP bit for Ctrl (1 Alt, 2 Ctrl, 4 Meta, 8 Shift).
    const CTRL_MODIFIER = 2;
    await stage.scrollIntoViewIfNeeded();
    const box = await stage.boundingBox();
    if (!box) throw new Error('the canvas stage has no box');
    const centre = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    const client = await page.context().newCDPSession(page);

    const scrollBefore = await page.evaluate(() => window.scrollY);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: centre.x, y: centre.y, deltaX: 0, deltaY: -100, modifiers: CTRL_MODIFIER,
    });
    await expect(reset, 'ctrl+wheel zoom').toHaveText('115%');
    await settleFrames(page);
    expect(await page.evaluate(() => window.scrollY), 'ctrl+wheel is consumed, not scrolled').toBe(scrollBefore);

    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: centre.x, y: centre.y, deltaX: 0, deltaY: 400, modifiers: 0,
    });
    await settleFrames(page);
    expect(await page.evaluate(() => window.scrollY), 'a plain wheel still scrolls the page').toBeGreaterThan(scrollBefore);
    await client.detach();

    // The hydrated tier's `Expand diagram` opens a dialog whose open/closed and
    // zoom state live in React. This tier never runs React, so the control is
    // not rendered here at all rather than rendered dead.
    await expect(page.getByRole('button', { name: 'Expand diagram' }), 'a control this tier cannot honour').toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });
}

/**
 * The byte-range download this case used to assert — exactly one `Range`
 * request for the entry's own pack slice, and a file that was the workflow
 * rather than the shard line it came from — has no subject left. Audit F-001
 * RULING-2 moved the last redistributable rows to link-only and cleared every
 * `download` pointer, and P3-3 took the pack store out of the export with them.
 *
 * Absence is the honest contract now, and it is what this case has to keep
 * honest. A lean page renders its download control from the entry's `download`
 * pointer alone, so zero pointers across the corpus is what makes "no lean page
 * advertises a byte range" true of all 11,214 of them; the served page then has
 * to agree — no control, no live region to report into, and no request to the
 * pack store, which covers what the old "exactly its own byte range" assertions
 * were protecting: a lean page cannot serve its own bytes as a file, and cannot
 * serve another entry's. Reinstating the surface means recording per-item rights
 * evidence and re-targeting this case to the byte range that evidence names.
 */
test('no lean page advertises a download byte range, so none can serve pack bytes', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const carriers = leanSubjects().filter((entry) => entry.download !== null);
  expect(carriers.map((entry) => entry.id), 'lean entries carrying a pack byte range').toEqual([]);

  const packRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/data/packs/')) packRequests.push(new URL(request.url()).pathname);
  });

  await openLeanPage(page, 1280);

  await expect(
    page.locator('[data-download-pack], [data-download-offset], [data-download-length]'),
    'a byte range the served page advertises',
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download workflow' }), 'the served download control').toHaveCount(0);
  await expect(
    page.locator('[data-download-status]'),
    'the region a workflow download would announce into',
  ).toHaveCount(0);

  expect(packRequests, 'pack bytes fetched by a lean page').toEqual([]);

  expect(pageErrors).toEqual([]);
});
