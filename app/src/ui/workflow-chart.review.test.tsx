import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowChart } from '@hub/contracts';
import { WorkflowChartComponent } from './workflow-chart';

class ResizeObserverFake {
  static instances: ResizeObserverFake[] = [];
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverFake.instances.push(this);
  }

  observe() {}
  disconnect() {}
  unobserve() {}
}

const functionalChart: WorkflowChart = {
  nodes: [
    { id: 'opaque-trigger-id', name: 'Start', type: 'n8n-nodes-base.manualTrigger', x: 100, y: 100 },
    { id: 'opaque-action-id', name: 'Send message', type: 'n8n-nodes-base.slack', x: 300, y: 100 },
  ],
  edges: [{ from: 'opaque-trigger-id', to: 'opaque-action-id', kind: 'main' }],
};

function measureCanvas(width = 400, height = 300) {
  const viewport = screen.getByTestId('workflow-canvas-viewport');
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
  act(() => ResizeObserverFake.instances.at(-1)?.callback([], ResizeObserverFake.instances.at(-1)!));
  return viewport;
}

// <g> carries an implicit ARIA role of group, so a bare getByRole('group')
// matches the world-transform layer as well as the canvas. Scope by the
// viewport instead.
function canvasSvg() {
  return screen.getByTestId('workflow-canvas-viewport').querySelector('svg')!;
}

function worldTransform() {
  return canvasSvg().querySelector('g[transform]')?.getAttribute('transform');
}

beforeEach(() => {
  ResizeObserverFake.instances = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverFake);
});

afterEach(() => cleanup());

describe('WorkflowChartComponent review regressions', () => {
  it('moves Tier-C-sized keyboard access to the bounded node list', () => {
    const chart: WorkflowChart = {
      nodes: Array.from({ length: 63 }, (_, index) => ({
        id: `large-node-${index}`,
        name: `Node ${index}`,
        type: 'n8n-nodes-base.set',
        x: index * 100,
        y: 0,
      })),
      edges: [],
    };
    const { container } = render(<WorkflowChartComponent chart={chart} />);
    const svg = canvasSvg();

    expect(svg.querySelectorAll('[data-node-id]')).toHaveLength(63);
    expect(svg.querySelectorAll('[tabindex="0"]')).toHaveLength(0);
    expect(svg.querySelectorAll('[aria-hidden="true"][data-node-id]')).toHaveLength(63);
    expect(screen.getByText(/View workflow node list \(63 nodes/)).toBeTruthy();
    expect(container.querySelectorAll('[data-node-id]')).toHaveLength(63);
  });

  it('fits hidden sticky notes out of the functional graph and refits when shown', () => {
    const chart: WorkflowChart = {
      ...functionalChart,
      nodes: [
        ...functionalChart.nodes,
        { id: 'note', name: 'Internal note', type: 'n8n-nodes-base.stickyNote', x: 10_000, y: 100 },
      ],
    };
    const { container } = render(<WorkflowChartComponent chart={chart} />);
    measureCanvas();

    const rightmostNodeX = () => Math.max(...Array.from(container.querySelectorAll('[data-node-id]'))
      .map((node) => Number(node.getAttribute('transform')?.match(/translate\((-?[\d.]+)/)?.[1] ?? 0)));

    expect(canvasSvg().getAttribute('aria-label')).toContain('with 2 nodes');
    expect(container.querySelectorAll('[data-node-id]')).toHaveLength(2);
    const functionalWidth = rightmostNodeX();

    fireEvent.click(screen.getByRole('button', { name: 'Show annotation nodes' }));

    expect(canvasSvg().getAttribute('aria-label')).toContain('with 3 nodes');
    expect(container.querySelectorAll('[data-node-id]')).toHaveLength(3);
    // Admitting the note must extend the graph — it is laid out, not dropped.
    expect(rightmostNodeX()).toBeGreaterThan(functionalWidth);

    // The note sits 10,000 units out in the source. It used to drag the fitted
    // zoom down to the 0.18 floor; gap compaction now absorbs the outlier, so
    // the reader's framing survives it. Asserting the transform *changed* would
    // be asserting the old defect.
    expect(worldTransform()).toContain('scale(0.75)');
  });

  it('zooms over interactive SVG nodes without consuming inspector wheel or double-click events', () => {
    render(<WorkflowChartComponent chart={functionalChart} />);
    measureCanvas(800, 400);
    const svgNode = screen.getByRole('button', { name: 'Node: Start (trigger)' });
    const fitted = worldTransform();
    const nodeWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 170, clientY: 140 });

    act(() => svgNode.dispatchEvent(nodeWheel));
    expect(worldTransform()).not.toBe(fitted);
    fireEvent.doubleClick(svgNode);
    expect(worldTransform()).toBe(fitted);

    fireEvent.click(screen.getByRole('button', { name: 'Focus Start node' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const inspector = screen.getByRole('complementary', { name: 'Node Inspector' });
    const before = worldTransform();
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });

    act(() => inspector.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(false);
    expect(worldTransform()).toBe(before);
    fireEvent.doubleClick(inspector);
    expect(worldTransform()).toBe(before);
  });

  it('shows a visible pressed treatment on interactive SVG nodes', () => {
    render(<WorkflowChartComponent chart={functionalChart} />);
    const node = screen.getByRole('button', { name: 'Node: Start (trigger)' });
    const background = node.querySelector('rect');

    fireEvent.click(node);
    expect(node.getAttribute('aria-pressed')).toBe('true');
    expect(background?.getAttribute('fill')).toBe('var(--color-panel)');

    // The pressed state owns the card's *fill* and nothing else: resting it is
    // the panel, pressed it is the accent-dim treatment, and releasing restores
    // it. The card's boundary stroke is deliberately not asserted here — the
    // pressed state does not own it, and which token may draw a boundary is the
    // contrast gates' call. `workflow-chart.test.tsx` already pins the focused
    // card's `--color-accent-border`; the old `--color-accent` expectation here
    // predates that, and amber is a 1.51:1 fill on white that cannot draw one.
    fireEvent.pointerDown(node, { pointerId: 1 });
    expect(node.getAttribute('data-pressed')).toBe('true');
    expect(background?.getAttribute('fill')).toBe('var(--color-accent-dim)');

    fireEvent.pointerUp(node, { pointerId: 1 });
    expect(node.getAttribute('data-pressed')).toBe('false');
    expect(background?.getAttribute('fill')).toBe('var(--color-panel)');
  });

  it('keeps the fallback inside fullscreen and wraps focus within the overlay', () => {
    render(<WorkflowChartComponent chart={functionalChart} />);
    const opener = screen.getByRole('button', { name: 'Fullscreen view' });
    opener.focus();
    fireEvent.click(opener);
    const overlay = screen.getByTestId('workflow-chart');
    const summary = screen.getByText(/View workflow node list/);

    expect(overlay.contains(summary)).toBe(true);
    fireEvent.click(summary);
    const last = screen.getByRole('button', { name: 'Focus Send message node' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fullscreen view' }));
  });

  it('disables absent trigger actions and shows active and selected states', () => {
    const chart: WorkflowChart = {
      nodes: [{ id: 'set', name: 'Transform', type: 'n8n-nodes-base.set', x: 0, y: 0 }],
      edges: [],
    };
    render(<WorkflowChartComponent chart={chart} />);
    const trigger = screen.getByRole('button', { name: 'Focus trigger node' }) as HTMLButtonElement;
    const notes = screen.getByRole('button', { name: 'Show annotation nodes' });

    expect(trigger.disabled).toBe(true);
    expect(trigger.className).toContain('disabled:opacity-40');
    fireEvent.click(notes);
    expect(notes.getAttribute('aria-pressed')).toBe('true');
    expect(notes.className).toContain('bg-accent-dim');
    const fallback = screen.getByRole('button', { name: 'Focus Transform node' });
    fireEvent.click(fallback);
    expect(fallback.getAttribute('aria-pressed')).toBe('true');
    expect(fallback.className).toContain('bg-accent-dim');
    expect(screen.getByRole('button', { name: 'Close inspector' }).className).toContain('active:bg-accent-dim');
  });

  // This test previously asserted the opposite: that below 100% zoom the SVG
  // nodes were pointer-events:none, aria-hidden and absent from the accessibility
  // tree, with the node list as the only route in. The touch-target concern was
  // real, but zoom is not a proxy for target size, and the canvas opens below
  // 100% for 94.56% of the catalogue — so that rule disabled the diagram almost
  // everywhere. The contract now: a small target gets a bigger hit area, and
  // keyboard access never depends on zoom at all.
  it('pads the hit area instead of disabling nodes when zoomed far out', () => {
    const { container } = render(<WorkflowChartComponent chart={functionalChart} />);
    measureCanvas(320, 300);
    const visualNode = () => container.querySelector('[data-node-id="opaque-trigger-id"]');

    // The canvas opens at a readable zoom, so the 44-unit card already clears
    // the 24px minimum here — no padding needed, and the node is operable.
    expect(visualNode()?.querySelector('rect[fill="transparent"]')).toBeNull();
    expect(visualNode()?.getAttribute('pointer-events')).not.toBe('none');

    // Zoom out until the rendered card drops under 24px (0.75 -> 0.6 -> 0.48).
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });
    fireEvent.click(zoomOut);
    fireEvent.click(zoomOut);

    // Now the target is genuinely small — and the answer is a bigger hit area,
    // never a disabled control. Keyboard and AT access never depended on zoom.
    expect(visualNode()?.querySelector('rect[fill="transparent"]')).not.toBeNull();
    expect(visualNode()?.getAttribute('pointer-events')).not.toBe('none');
    expect(visualNode()?.getAttribute('aria-hidden')).not.toBe('true');
    expect(screen.getByRole('button', { name: 'Node: Start (trigger)' })).toBeTruthy();

    // The node list remains, as an equal route rather than the only one.
    expect(screen.getByRole('button', { name: 'Focus Start node' }).className).toContain('min-h-11');
  });

  it('renders fallback destinations as visible node names, never opaque ids', () => {
    render(<WorkflowChartComponent chart={functionalChart} />);
    const fallback = screen.getByRole('button', { name: 'Focus Start node' });

    expect(fallback.textContent).toContain('connects to: Send message');
    expect(fallback.textContent).not.toContain('opaque-action-id');
  });

  it('uses a text-safe token for the storage category label', () => {
    const chart: WorkflowChart = {
      nodes: [{ id: 'db', name: 'Database', type: 'n8n-nodes-base.postgres', x: 0, y: 0 }],
      edges: [],
    };
    render(<WorkflowChartComponent chart={chart} />);
    const node = screen.getByRole('button', { name: 'Node: Database (storage)' });
    const dataLabel = Array.from(node.querySelectorAll('text')).find((item) => item.textContent === 'DATA');

    expect(dataLabel?.getAttribute('fill')).toBe('var(--color-cat-blue)');
  });
});
