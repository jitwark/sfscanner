import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { getLeanPageEnhancementsScript } from './lean-enhancements-script';

/**
 * This string is the whole canvas on 11,214 lean pages: they are one static HTML
 * file with no React, so nothing else pans, zooms or downloads there. These tests
 * run it in jsdom against the markup `canvas-viewport.tsx` renders statically and
 * assert what a reader gets.
 *
 * It is mounted once for the file, because the script registers its download
 * listener on `document`; re-running it per test would handle one click several
 * times. Tests that depend on canvas state reset through the canvas's own Reset
 * control first, exactly as the browser acceptance does.
 *
 * jsdom cannot stand in for the browser input pipeline that gives
 * `setPointerCapture` a live pointer, for `touch-action`, or for real scrolling,
 * so touch and pen panning are proven against a served lean page in
 * `app/e2e/lean-page-acceptance-qa.spec.ts`. What is asserted here is the wiring:
 * which events pan, which pointer ends the gesture, and that no pointer type is
 * privileged over the others.
 */

/**
 * The download control as `download-control.tsx` renders it: the button the
 * script owns, the `sr-only` live region it announces through, and the licence
 * note beside them. The wrapper is load-bearing — the script finds the region
 * as a sibling inside the control, not by a document-wide query.
 */
const DOWNLOAD_CONTROL = `
<div class="flex flex-col items-end gap-1.5">
  <button type="button" data-download-pack="0" data-download-offset="100" data-download-length="100" data-download-slug="redistributable-entry">Download workflow</button>
  <span class="sr-only" aria-live="polite" data-download-status=""></span>
  <span class="max-w-56 text-right text-2xs leading-4 text-ink-muted">Includes the upstream licence notice.</span>
</div>`;

const PAGE = `
<div data-canvas-viewport="true">
  <div class="toolbar">
    <button type="button" aria-label="Zoom out">-</button>
    <button type="button" aria-label="Reset zoom to 100%">100%</button>
    <button type="button" aria-label="Zoom in">+</button>
    <button type="button" aria-label="Download vector SVG">SVG</button>
  </div>
  <div role="img" aria-label="Workflow vector diagram" style="touch-action:none">
    <div data-viewport-target="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg></div>
  </div>
</div>
${DOWNLOAD_CONTROL}`;

const RESET = 'translate(0px, 0px) scale(1)';

/**
 * The lean control asks for `bytes=100-199`, so the served body must be exactly
 * 100 bytes with a `206` that names that range. JSON permits trailing
 * whitespace, so the pad keeps the document valid while making the length
 * assertion the script performs true.
 */
const RANGE_JSON = '{"name":"workflow","nodes":[]}\n';
const RANGE_BODY = RANGE_JSON + ' '.repeat(100 - RANGE_JSON.length);
const rangeResponse = (body = RANGE_BODY, contentRange = 'bytes 100-199/1000') => ({
  status: 206,
  headers: new Headers({ 'content-range': contentRange }),
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});

let viewport: HTMLElement;
let stage: HTMLElement;
let target: HTMLElement;
let reset: HTMLButtonElement;
let zoomIn: HTMLButtonElement;
let zoomOut: HTMLButtonElement;
let svg: HTMLButtonElement;
let downloadButton: HTMLButtonElement;
let status: HTMLElement;
const capture = vi.fn();
const blobs: Blob[] = [];
const anchors: HTMLAnchorElement[] = [];

/** One complete gesture: down, move, up. */
function drag(pointerType: string, points: { pointerId?: number; from?: [number, number]; to?: [number, number] } = {}) {
  const pointerId = points.pointerId ?? 7;
  const [fromX, fromY] = points.from ?? [100, 80];
  const [toX, toY] = points.to ?? [160, 120];
  fireEvent.pointerDown(stage, { pointerId, pointerType, isPrimary: true, button: 0, clientX: fromX, clientY: fromY });
  fireEvent.pointerMove(stage, { pointerId, pointerType, isPrimary: true, clientX: toX, clientY: toY });
  fireEvent.pointerUp(stage, { pointerId, pointerType, isPrimary: true, button: 0 });
}

const move = (x: number, y: number, pointerId = 7, pointerType = 'mouse') =>
  fireEvent.pointerMove(stage, { pointerId, pointerType, isPrimary: true, clientX: x, clientY: y });

const down = (element: HTMLElement, pointerId: number, pointerType = 'mouse') =>
  fireEvent.pointerDown(element, { pointerId, pointerType, isPrimary: true, button: 0, clientX: 100, clientY: 80 });

beforeAll(() => {
  document.body.innerHTML = PAGE;
  viewport = document.querySelector<HTMLElement>('[data-canvas-viewport]')!;
  stage = viewport.querySelector<HTMLElement>('[role="img"]')!;
  target = viewport.querySelector<HTMLElement>('[data-viewport-target]')!;
  reset = viewport.querySelector<HTMLButtonElement>('[aria-label="Reset zoom to 100%"]')!;
  zoomIn = viewport.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;
  zoomOut = viewport.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!;
  svg = viewport.querySelector<HTMLButtonElement>('[aria-label="Download vector SVG"]')!;
  downloadButton = document.querySelector<HTMLButtonElement>('[data-download-pack]')!;
  status = document.querySelector<HTMLElement>('[data-download-status]')!;

  Object.defineProperty(viewport, 'setPointerCapture', { configurable: true, value: capture });
  // jsdom has neither of these, and they are how a download becomes a file: the
  // Blobs handed to `createObjectURL` and the anchors that were clicked are the
  // observable result.
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => { blobs.push(blob); return `blob:lean-${blobs.length}`; },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
  HTMLAnchorElement.prototype.click = function recordAnchor(this: HTMLAnchorElement) { anchors.push(this); };

  new Function(getLeanPageEnhancementsScript())();
  expect(viewport.dataset.enhanced, 'the script enhanced the canvas on a page with no React').toBe('1');
});

beforeEach(() => {
  capture.mockClear();
  blobs.length = 0;
  anchors.length = 0;
  // Every gesture- and download-dependent test starts from the served state:
  // 100%, no pan, the control's own label and no announcement in the region.
  fireEvent.click(reset);
  downloadButton.textContent = 'Download workflow';
  downloadButton.removeAttribute('disabled');
  status.textContent = '';
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('lean canvas panning', () => {
  it.each(['mouse', 'touch', 'pen'] as const)('pans with a %s pointer and stops when the gesture ends', (pointerType) => {
    drag(pointerType);

    expect(capture, `${pointerType}: capture requested`).toHaveBeenCalledWith(7);
    expect(target.style.transform, `${pointerType}: panned`).toBe('translate(60px, 40px) scale(1)');

    move(400, 400, 7, pointerType);
    expect(target.style.transform, `${pointerType}: panning after release`).toBe('translate(60px, 40px) scale(1)');
  });

  it('shows the grab state for the duration of the gesture only', () => {
    down(stage, 7, 'touch');
    expect(viewport.style.cursor).toBe('grabbing');

    fireEvent.pointerUp(stage, { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0 });
    expect(viewport.style.cursor).toBe('default');
  });

  it('ends on pointercancel and on lostpointercapture, so a cancelled touch cannot stick', () => {
    for (const [pointerId, end] of [[2, 'cancel'], [4, 'lostcapture']] as const) {
      down(stage, pointerId, 'touch');

      if (end === 'cancel') fireEvent.pointerCancel(stage, { pointerId, pointerType: 'touch', isPrimary: true });
      else fireEvent.lostPointerCapture(stage, { pointerId, pointerType: 'touch', isPrimary: true });

      move(500, 500, pointerId, 'touch');
      expect(target.style.transform, `${end} ends the gesture`).toBe(RESET);
      expect(viewport.style.cursor, `${end} releases the cursor`).toBe('default');
    }
  });

  it('ignores other buttons, non-primary pointers, and a second pointer mid-drag', () => {
    fireEvent.pointerDown(stage, { pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 2, clientX: 10, clientY: 10 });
    move(90, 90);
    expect(target.style.transform, 'a right button does not pan').toBe(RESET);

    fireEvent.pointerDown(stage, { pointerId: 7, pointerType: 'touch', isPrimary: false, button: 0, clientX: 10, clientY: 10 });
    move(90, 90, 7, 'touch');
    expect(target.style.transform, 'a secondary pointer does not pan').toBe(RESET);

    down(stage, 7, 'touch');
    down(stage, 8, 'touch');
    move(500, 500, 8, 'touch');
    move(140, 110, 7, 'touch');
    expect(target.style.transform, 'the first pointer keeps the gesture').toBe('translate(40px, 30px) scale(1)');
  });

  it('still pans when a browser refuses the capture, as a synthesized event does', () => {
    Object.defineProperty(viewport, 'setPointerCapture', {
      configurable: true,
      value: () => { throw new Error('NotFoundError'); },
    });
    try {
      drag('mouse');
      expect(target.style.transform).toBe('translate(60px, 40px) scale(1)');
    } finally {
      Object.defineProperty(viewport, 'setPointerCapture', { configurable: true, value: capture });
    }
  });
});

describe('lean canvas controls', () => {
  it('zooms from the toolbar and reset returns to the served state', () => {
    fireEvent.click(zoomIn);
    fireEvent.click(zoomIn);
    expect(reset.textContent).toBe('150%');

    fireEvent.click(zoomOut);
    expect(reset.textContent).toBe('125%');

    fireEvent.click(reset);
    expect(reset.textContent).toBe('100%');
    expect(target.style.transform).toBe(RESET);
  });

  it('zooms on ctrl+wheel without letting the page scroll, and leaves a plain wheel alone', () => {
    expect(fireEvent.wheel(stage, { deltaY: -100, ctrlKey: true }), 'ctrl+wheel is consumed').toBe(false);
    expect(reset.textContent).toBe('115%');

    expect(fireEvent.wheel(stage, { deltaY: -100 }), 'a wheel without ctrl is the page scroll').toBe(true);
    expect(reset.textContent).toBe('115%');

    expect(fireEvent.wheel(stage, { deltaY: 100, ctrlKey: true })).toBe(false);
    expect(reset.textContent).toBe('100%');
  });

  it('zooms on meta+wheel too, matching the advertised Ctrl/⌘ shortcut', () => {
    expect(fireEvent.wheel(stage, { deltaY: -100, metaKey: true }), 'meta+wheel is consumed').toBe(false);
    expect(reset.textContent).toBe('115%');

    expect(fireEvent.wheel(stage, { deltaY: -100 }), 'a wheel without a modifier is the page scroll').toBe(true);
    expect(reset.textContent).toBe('115%');
  });

  it('starts a gesture on the canvas, not on a control it would break', () => {
    down(zoomIn, 7, 'touch');
    expect(capture, 'a control must not capture the pointer').not.toHaveBeenCalled();
    move(200, 200, 7, 'touch');
    expect(target.style.transform).toBe(RESET);

    fireEvent.click(zoomIn);
    expect(reset.textContent, 'the control still receives its click').toBe('125%');
  });
});

describe('lean canvas downloads', () => {
  it('fetches exactly the workflow byte range and reports Downloading... then Downloaded!', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => rangeResponse());
    vi.stubGlobal('fetch', fetchMock);

    fireEvent.click(downloadButton);
    expect(downloadButton.textContent).toBe('Downloading...');
    expect(downloadButton.hasAttribute('disabled')).toBe(true);
    expect(status.textContent, 'the control live region announces progress, instead of staying empty').toBe('Downloading...');

    await vi.waitFor(() => expect(downloadButton.textContent).toBe('Downloaded!'));
    expect(status.textContent, 'and the result').toBe('Downloaded!');
    expect(fetchMock, 'one range request, no redirect hop').toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/data/packs/pack-0.jsonl');
    expect((init as RequestInit).headers).toEqual({ Range: 'bytes=100-199' });
    expect(anchors.at(-1)?.download).toBe('redistributable-entry.json');
    expect(await blobs.at(-1)!.text()).toBe(JSON.stringify({ name: 'workflow', nodes: [] }, null, 2));
  });

  it('says Download failed when the range request fails, instead of a silent nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => '' })));

    fireEvent.click(downloadButton);
    await vi.waitFor(() => expect(downloadButton.textContent).toBe('Download failed'));
    expect(status.textContent, 'the failure is announced too, not only painted on the button').toBe('Download failed');
    expect(anchors, 'no file is offered when the fetch failed').toHaveLength(0);
  });

  it('refuses a 200 that ignored the Range header instead of slicing a full pack blind', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode(RANGE_BODY).buffer,
    })));

    fireEvent.click(downloadButton);
    await vi.waitFor(() => expect(downloadButton.textContent).toBe('Download failed'));
    expect(anchors, 'a whole pack is never offered as this workflow file').toHaveLength(0);
  });

  it('refuses a 206 whose Content-Range names a different range', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rangeResponse(RANGE_BODY, 'bytes 0-99/1000')));

    fireEvent.click(downloadButton);
    await vi.waitFor(() => expect(downloadButton.textContent).toBe('Download failed'));
    expect(anchors).toHaveLength(0);
  });

  it('refuses a 206 whose body is not the requested length', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rangeResponse(RANGE_BODY.slice(0, 99))));

    fireEvent.click(downloadButton);
    await vi.waitFor(() => expect(downloadButton.textContent).toBe('Download failed'));
    expect(anchors).toHaveLength(0);
  });

  it('returns the control and its live region to the resting state once the result has been announced', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async () => rangeResponse()));

      fireEvent.click(downloadButton);
      await vi.advanceTimersByTimeAsync(0);
      expect(downloadButton.textContent).toBe('Downloaded!');

      await vi.advanceTimersByTimeAsync(2000);
      expect(downloadButton.textContent, 'the button goes back to its own label').toBe('Download workflow');
      expect(status.textContent, 'and the region stops carrying a stale announcement').toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The base path is baked in where the script is emitted, exactly as
   * `download.ts` inlines `sitePath()` for the hydrated control: this is one
   * build artifact per deployment, so the prefix is fixed by the build rather
   * than guessed from `location` at click time. Proving it therefore means
   * running a second, differently configured instance — re-running the script
   * in this file's document would register a second click handler on the same
   * button, which is the thing the mount comment above exists to avoid.
   */
  it('requests the pack shard under the deployment base path, not the domain root', async () => {
    const deployment = document.implementation.createHTMLDocument('deployment');
    deployment.body.innerHTML = DOWNLOAD_CONTROL;
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      return rangeResponse();
    });

    vi.stubGlobal('document', deployment);
    vi.stubGlobal('fetch', fetchMock);
    try {
      new Function(getLeanPageEnhancementsScript('/n8n-Secureflow'))();
      // A created document has no `defaultView`, so `fireEvent` refuses it; the
      // script's listener is on the document itself, so a bubbling event is
      // exactly what a click delivers.
      deployment.querySelector<HTMLButtonElement>('[data-download-pack]')!
        .dispatchEvent(new Event('click', { bubbles: true }));

      await vi.waitFor(() => expect(urls).toHaveLength(1));
      expect(urls[0], 'a root-absolute URL leaves the site and 404s on Pages').toBe('/n8n-Secureflow/data/packs/pack-0.jsonl');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('downloads the rendered SVG from the toolbar', async () => {
    fireEvent.click(svg);

    expect(anchors.at(-1)?.download).toBe('workflow-diagram.svg');
    expect(blobs.at(-1)!.type).toBe('image/svg+xml;charset=utf-8');
    expect(await blobs.at(-1)!.text()).toContain('<svg');
  });
});
