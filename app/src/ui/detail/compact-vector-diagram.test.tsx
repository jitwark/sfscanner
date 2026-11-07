import { StrictMode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import type { SvgPreviewArtifact } from '@hub/contracts';
import { CompactVectorDiagram } from './compact-vector-diagram';

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

// jsdom has no top layer. `showModal` deliberately does NOT focus anything: if
// it did, the focus assertion below would pass even when the component never
// focused Close.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});
afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});
afterEach(() => cleanup());

const FIXTURE_PREVIEW: SvgPreviewArtifact = {
  schemaVersion: 'svg-preview-v1',
  tier: 'A',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="100" height="50"/></svg>',
  nodeList: [
    { id: '1', name: 'Start', type: 'n8n-nodes-base.start', category: 'trigger' },
    { id: '2', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', category: 'http' },
  ],
  contentHash: 'a'.repeat(64),
  unresolvedEdgeCount: 0,
};

/**
 * jsdom lays nothing out, so every rect is 0×0. Give the dialog the box a real
 * browser would give a 400×300 panel at (100, 100) so clicks can be placed
 * inside the panel and outside it.
 */
function stubDialogRect(dialog: HTMLElement) {
  const rect = { left: 100, top: 100, right: 500, bottom: 400 };
  dialog.getBoundingClientRect = () => ({
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  }) as DOMRect;
}

describe('CompactVectorDiagram', () => {
  it('renders vector SVG and node stats when preview is provided', () => {
    render(<CompactVectorDiagram preview={FIXTURE_PREVIEW} title="Test Workflow" />);
    expect(screen.getByRole('img')).toBeTruthy();
    expect(screen.getByText('Tier A')).toBeTruthy();
    expect(screen.getByText('2 nodes')).toBeTruthy();
  });

  it('renders fallback when preview is missing', () => {
    render(<CompactVectorDiagram preview={null} />);
    expect(screen.getByText(/Static vector preview not available/i)).toBeTruthy();
  });

  it('says only what the canvas does', () => {
    render(<CompactVectorDiagram preview={FIXTURE_PREVIEW} title="Test Workflow" />);
    expect(screen.getByText(/Ctrl\/⌘ \+ scroll or toolbar to zoom/)).toBeTruthy();
    expect(screen.queryByText(/Scroll or \+\/- to zoom/)).toBeNull();
  });
});

describe('CompactVectorDiagram dialog lifecycle', () => {
  it('focuses Close after showModal and closes on cancel', () => {
    render(<CompactVectorDiagram preview={FIXTURE_PREVIEW} title="Test Workflow" />);
    fireEvent.click(screen.getByTitle('Expand diagram'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '✕ Close' }));
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('restores the Expand diagram opener after Close', () => {
    render(<CompactVectorDiagram preview={FIXTURE_PREVIEW} title="Test Workflow" />);
    const opener = screen.getByTitle('Expand diagram');
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: '✕ Close' }));
    expect(document.activeElement).toBe(opener);
  });

  it('restores focus synchronously, before the queued close event', () => {
    render(<CompactVectorDiagram preview={FIXTURE_PREVIEW} title="Test Workflow" />);
    const opener = screen.getByTitle('Expand diagram');
    fireEvent.click(opener);
    const dispatchingClose = HTMLDialogElement.prototype.close;
    // Model Chromium: close() queues the event instead of firing it inline.
    HTMLDialogElement.prototype.close = function closeWithoutEvent() { this.open = false; };
    try {
      fireEvent.click(screen.getByRole('button', { name: '✕ Close' }));
      expect(document.activeElement).toBe(opener); // fails if restore lives in onClose
    } finally {
      HTMLDialogElement.prototype.close = dispatchingClose;
    }
  });

  it('closes only on a click outside the dialog rectangle', () => {
    render(<CompactVectorDiagram preview={FIXTURE_PREVIEW} title="Test Workflow" />);
    const opener = screen.getByTitle('Expand diagram');
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog') as HTMLDialogElement;
    stubDialogRect(dialog);

    // A click on the panel's padding band is inside the box: the dialog stays open.
    fireEvent.click(dialog, { clientX: 110, clientY: 250 });
    expect(screen.getByRole('dialog')).toBeTruthy();
    // So does the scrollbar edge.
    fireEvent.click(dialog, { clientX: 499, clientY: 250 });
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(dialog, { clientX: 40, clientY: 250 });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('gives each instance its own dialog title id', () => {
    render(
      <>
        <CompactVectorDiagram preview={FIXTURE_PREVIEW} title="First" />
        <CompactVectorDiagram preview={FIXTURE_PREVIEW} title="Second" />
      </>,
    );
    for (const opener of screen.getAllByTitle('Expand diagram')) fireEvent.click(opener);
    const dialogs = screen.getAllByRole('dialog');
    const ids = dialogs.map((dialog) => dialog.getAttribute('aria-labelledby'));
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
    expect(dialogs[0].querySelector('h3')?.id).toBe(ids[0]);
    expect(dialogs[1].querySelector('h3')?.id).toBe(ids[1]);
  });

  it('closes the native dialog when unmounted while open', () => {
    const { unmount } = render(<CompactVectorDiagram preview={FIXTURE_PREVIEW} title="Test Workflow" />);
    fireEvent.click(screen.getByTitle('Expand diagram'));
    const dialog = screen.getByRole('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    unmount();
    expect(dialog.open).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('survives StrictMode setup/cleanup/setup', () => {
    render(<StrictMode><CompactVectorDiagram preview={FIXTURE_PREVIEW} title="Test Workflow" /></StrictMode>);
    const opener = screen.getByTitle('Expand diagram');
    fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '✕ Close' }));
    fireEvent.click(screen.getByRole('button', { name: '✕ Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
