import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
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

const chart: WorkflowChart = {
  nodes: [
    { id: 'trigger', name: 'Start', type: 'n8n-nodes-base.manualTrigger', x: 0, y: 0 },
    { id: 'action', name: 'Send message', type: 'n8n-nodes-base.slack', x: 0, y: 0 },
  ],
  edges: [{ from: 'trigger', to: 'action', kind: 'main' }],
};

function measureCanvas(width: number, height: number) {
  const viewport = screen.getByTestId('workflow-canvas-viewport');
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
  act(() => ResizeObserverFake.instances[0].callback([], ResizeObserverFake.instances[0]));
  return viewport;
}

beforeEach(() => {
  ResizeObserverFake.instances = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverFake);
  document.body.style.overflow = '';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

describe('WorkflowChartComponent', () => {
  it('uses a measured narrow viewport without creating a wider canvas', () => {
    render(<WorkflowChartComponent chart={chart} entryTitle="Support triage" />);
    const viewport = measureCanvas(320, 300);
    const diagram = screen.getByRole('group', {
      name: 'Workflow diagram for Support triage with 2 nodes, trigger: Start',
    });

    expect(viewport.className).toContain('max-w-full');
    expect(viewport.style.touchAction).toBe('none');
    expect(screen.getByTestId('workflow-chart').className).toContain('min-w-0');
    expect(diagram.getAttribute('width')).toBe('320');
    expect(diagram.getAttribute('height')).toBe('300');
    expect(diagram.getAttribute('viewBox')).toBe('0 0 320 300');
  });

  it('keeps a visible 44px fit control outside the SVG drag surface', () => {
    render(<WorkflowChartComponent chart={chart} />);
    const viewport = screen.getByTestId('workflow-canvas-viewport');
    const fit = screen.getByRole('button', { name: 'Fit workflow to view' });

    expect(viewport.contains(fit)).toBe(false);
    expect(fit.closest('[data-canvas-control]')).not.toBeNull();
    expect(fit.className).toContain('min-h-11');
    expect(fit.className).toContain('focus-visible:ring-accent-border');
  });

  it('describes reset as fitting the graph rather than claiming a 100% scale', () => {
    render(<WorkflowChartComponent chart={chart} />);

    expect(screen.getByRole('button', { name: 'Reset workflow view to fit' })).toBeTruthy();
  });

  it('offers keyboard activation in the diagram and authoritative node list', () => {
    render(<WorkflowChartComponent chart={chart} />);
    const node = screen.getByRole('button', { name: 'Node: Start (trigger)' });
    fireEvent.focus(node);
    fireEvent.keyDown(node, { key: 'Enter' });

    expect(node.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('complementary', { name: 'Node Inspector' })).toBeTruthy();
    const disclosure = screen.getByText('View workflow node list (2 nodes, 1 connection)');
    expect(disclosure).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Focus Send message node' }));
    expect(screen.getByRole('heading', { name: 'Send message' })).toBeTruthy();
  });

  it('moves keyboard focus through the diagram without selecting a node', () => {
    render(<WorkflowChartComponent chart={chart} />);
    const start = screen.getByRole('button', { name: 'Node: Start (trigger)' });
    const send = screen.getByRole('button', { name: 'Node: Send message (other)' });
    start.focus();
    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(send);
    expect(send.getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(send, { key: 'Home' });
    expect(document.activeElement).toBe(start);
    fireEvent.keyDown(start, { key: 'End' });
    expect(document.activeElement).toBe(send);
    const boundary = createEvent.keyDown(start, { key: 'ArrowUp' });
    fireEvent(start, boundary);
    expect(boundary.defaultPrevented).toBe(true);
  });

  it('uses flat theme-token node fills and exposes selected and focus states', () => {
    const { container } = render(<WorkflowChartComponent chart={chart} />);
    const node = screen.getByRole('button', { name: 'Node: Start (trigger)' });
    const card = node.querySelector('rect');

    expect(container.querySelector('linearGradient')).toBeNull();
    expect(card?.getAttribute('fill')).toBe('var(--color-panel)');
    fireEvent.focus(node);
    expect(node.getAttribute('data-focused')).toBe('true');
    expect(node.querySelector('rect')?.getAttribute('stroke')).toBe('var(--color-accent-border)');
    fireEvent.click(node);
    expect(node.getAttribute('data-selected')).toBe('true');
  });

  it('exits fullscreen with Escape and restores focus to its toggle', () => {
    document.body.style.overflow = 'auto';
    render(<WorkflowChartComponent chart={chart} />);
    const enter = screen.getByRole('button', { name: 'Fullscreen view' });
    const removeEventListener = vi.spyOn(document, 'removeEventListener');
    enter.focus();
    fireEvent.click(enter);

    const exit = screen.getByRole('button', { name: 'Exit fullscreen' });
    expect(document.activeElement).toBe(exit);
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByTestId('workflow-chart').className).toContain('fixed');
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByTestId('workflow-chart').className).not.toContain('fixed');
    expect(document.body.style.overflow).toBe('auto');
    expect(removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fullscreen view' }));
  });

  it('restores body scrolling when fullscreen is unmounted', () => {
    document.body.style.overflow = 'scroll';
    render(<WorkflowChartComponent chart={chart} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen view' }));
    expect(document.body.style.overflow).toBe('hidden');

    cleanup();

    expect(document.body.style.overflow).toBe('scroll');
  });

  it('keeps the fullscreen canvas bounded at a 320px viewport', () => {
    render(<WorkflowChartComponent chart={chart} />);
    measureCanvas(320, 300);
    const enter = screen.getByRole('button', { name: 'Fullscreen view' });

    fireEvent.click(enter);
    const overlay = screen.getByTestId('workflow-chart');
    expect(overlay.className).toContain('fixed');
    expect(overlay.className).toContain('min-w-0');
    expect(overlay.className).toContain('max-w-full');
    expect(screen.getByTestId('workflow-canvas-viewport').className).toContain('overflow-hidden');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(overlay.className).not.toContain('fixed');
  });
});

/**
 * CV-2a (audit 2026-08-25). 1,755 entries (13.27%) render a canvas with no
 * arrows at all, because their upstream connection graphs do not resolve --
 * 1,744 of them from a single source. The renderer drops nothing; the graphs
 * arrive broken.
 *
 * What belongs to the UI is that it said nothing. A 174-node workflow rendered
 * as a silent field of boxes with an edge count of 0 beside a node count of
 * 174, and the reader concluded the canvas was broken. It is the data that is
 * broken, and the page should say so.
 */
describe('WorkflowChartComponent with no resolvable connections', () => {
  const disconnected: WorkflowChart = {
    nodes: [
      { id: 'a', name: 'Webhook', type: 'n8n-nodes-base.webhook', x: 0, y: 0 },
      { id: 'b', name: 'Slack', type: 'n8n-nodes-base.slack', x: 400, y: 0 },
      { id: 'c', name: 'Code', type: 'n8n-nodes-base.code', x: 800, y: 0 },
    ],
    edges: [],
  };

  it('says the connections could not be resolved rather than showing a silent field of boxes', () => {
    render(<WorkflowChartComponent chart={disconnected} entryTitle="Broken workflow" />);
    const notice = screen.getByRole('status', { name: /connection/i });
    expect(notice.textContent).toMatch(/no connections/i);
  });

  it('reports how many connections the upstream file declared', () => {
    const withDangling: WorkflowChart = {
      ...disconnected,
      // Every target is a node that does not exist -- the shape the audit found.
      edges: [
        { from: 'a', to: 'error-handler-a-1', kind: 'main' },
        { from: 'b', to: 'error-handler-b-2', kind: 'main' },
      ],
    };
    render(<WorkflowChartComponent chart={withDangling} entryTitle="Broken workflow" />);
    expect(screen.getByRole('status', { name: /connection/i }).textContent).toMatch(/\b2\b/);
  });

  it('counts connections the chart already dropped, not just ones it still carries', () => {
    // Once `buildChart` stopped emitting references to nothing, the dangling
    // connections left `chart.edges` entirely. Reading only `edges.length`
    // would then report "declares none" on precisely the workflows this notice
    // exists to explain.
    const dropped: WorkflowChart = { ...disconnected, edges: [], unresolvedEdgeCount: 7 };

    render(<WorkflowChartComponent chart={dropped} entryTitle="Broken workflow" />);

    expect(screen.getByRole('status', { name: /connection/i }).textContent).toMatch(/\b7\b/);
  });

  it('says nothing when the graph is connected', () => {
    render(<WorkflowChartComponent chart={chart} entryTitle="Fine workflow" />);
    expect(screen.queryByRole('status', { name: /connection/i })).toBeNull();
  });

  it('says nothing for a single-node workflow, which has nothing to connect', () => {
    const single: WorkflowChart = { nodes: [disconnected.nodes[0]!], edges: [] };
    render(<WorkflowChartComponent chart={single} entryTitle="One node" />);
    expect(screen.queryByRole('status', { name: /connection/i })).toBeNull();
  });
});
