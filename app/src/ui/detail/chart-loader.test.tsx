// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry, SvgPreviewArtifact } from '@hub/contracts';
import { ChartLoader } from './chart-loader';
import { makeEntry } from '../../../../pipeline/__fixtures__/make-entry';

/**
 * P5.7. The static preview is the default. The chart request and interactive
 * module must not start until the reader explicitly selects the canvas.
 *
 * Every chart result still settles into a finite state after that action.
 */

const loadChartMock = vi.hoisted(() => vi.fn());
vi.mock('../../catalogue/shard-client', () => ({ loadChart: loadChartMock }));
const loadPreviewMock = vi.hoisted(() => vi.fn());
vi.mock('../../catalogue/preview-client', () => ({ loadPreviewById: loadPreviewMock }));

/** jsdom has no ResizeObserver, and the canvas observes its container. */
class ResizeObserverFake {
  observe() {}
  disconnect() {}
  unobserve() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverFake);

function entryWithChart(): Entry {
  return { ...makeEntry(), chartRef: { shard: 0, offset: 0, length: 128 } } as Entry;
}

function entryWithoutChart(): Entry {
  const entry = { ...makeEntry() } as Entry;
  delete (entry as { chartRef?: unknown }).chartRef;
  return entry;
}

const preview: SvgPreviewArtifact = {
  schemaVersion: 'svg-preview-v1',
  tier: 'A',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text>Safe</text></svg>',
  nodeList: [{ id: 'a', name: 'Start', type: 'n8n-nodes-base.manualTrigger', category: 'trigger' }],
  contentHash: 'a'.repeat(64),
  unresolvedEdgeCount: 0,
};

const explore = () => fireEvent.click(screen.getByRole('button', { name: /explore interactive canvas/i }));

beforeEach(() => {
  loadChartMock.mockReset();
  loadPreviewMock.mockReset();
});
afterEach(() => cleanup());

describe('ChartLoader', () => {
  it('renders a valid workflow source URL', () => {
    const entry = entryWithoutChart();
    render(createElement(ChartLoader, { entry }));
    expect(screen.getByRole('link', { name: 'Open the workflow at its source' }).getAttribute('href'))
      .toBe(entry.source.permalink);
  });

  it('withholds a workflow source link with an unsafe URL', () => {
    const entry = entryWithoutChart();
    entry.source.permalink = 'javascript:alert(1)';
    const { container } = render(createElement(ChartLoader, { entry }));

    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open the workflow at its source' })).toBeNull();
  });

  it('leaves the loading state when the chart cannot be fetched', async () => {
    loadChartMock.mockResolvedValue({ ok: false, reason: 'network' });

    render(createElement(ChartLoader, { entry: entryWithChart() }));
    explore();

    await waitFor(() => expect(screen.queryByText(/loading interactive canvas/i)).toBeNull());
    expect(screen.getAllByRole('status').some((status) => /could not|not available|unavailable/i.test(status.textContent ?? ''))).toBe(true);
  });

  it('offers a retry when the failure was transport rather than absence', async () => {
    loadChartMock.mockResolvedValue({ ok: false, reason: 'range-unsupported' });

    render(createElement(ChartLoader, { entry: entryWithChart() }));
    explore();

    await waitFor(() => expect(screen.queryByText(/loading interactive canvas/i)).toBeNull());
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined();
  });

  it('offers a retry when the chart is corrupt', async () => {
    loadChartMock.mockResolvedValue({ ok: false, reason: 'malformed' });

    render(createElement(ChartLoader, { entry: entryWithChart() }));
    explore();

    await waitFor(() => expect(screen.queryByText(/loading interactive canvas/i)).toBeNull());
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined();
  });

  it('settles a hung chart request into a retryable timeout', async () => {
    let resolveChart: (value: unknown) => void = () => undefined;
    loadChartMock.mockReturnValue(new Promise((resolve: (value: unknown) => void) => { resolveChart = resolve; }));

    render(createElement(ChartLoader, {
      entry: entryWithChart(),
      interactiveTimeoutMs: 10,
      loadCanvasModule: async () => ({ WorkflowChartComponent: () => createElement('div') }),
    }));
    explore();
    await waitFor(() => expect(screen.getByText(/timed out/i)).toBeDefined(), { timeout: 1_000 });
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined();
    resolveChart({ ok: false, reason: 'aborted' });
  });

  it('does not turn a cancelled pending module load into a timeout', async () => {
    type CanvasModule = Awaited<ReturnType<NonNullable<ComponentProps<typeof ChartLoader>['loadCanvasModule']>>>;
    let resolveModule: (value: CanvasModule) => void = () => undefined;
    const loadCanvasModule = () => new Promise<CanvasModule>((resolve) => { resolveModule = resolve; });
    render(createElement(ChartLoader, { entry: entryWithChart(), interactiveTimeoutMs: 10, loadCanvasModule }));
    explore();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /explore interactive canvas/i })).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText(/timed out/i)).toBeNull();
    resolveModule({ WorkflowChartComponent: () => createElement('div') });
  });

  it('clears the interactive timeout after a successful chart load', async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
    loadChartMock.mockResolvedValue({
      ok: true,
      chart: { nodes: [{ id: 'a', name: 'Trigger', type: 'n8n-nodes-base.webhook', x: 0, y: 0 }], edges: [] },
    });
    const loadCanvasModule = async () => ({ WorkflowChartComponent: () => createElement('div', { 'data-testid': 'workflow-chart' }) });

    render(createElement(ChartLoader, { entry: entryWithChart(), interactiveTimeoutMs: 250, loadCanvasModule }));
    explore();
    await waitFor(() => expect(screen.getByTestId('workflow-chart')).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(abortSpy).not.toHaveBeenCalled();

    abortSpy.mockRestore();
  });

  it('does not offer a retry when there is simply no diagram', async () => {
    render(createElement(ChartLoader, { entry: entryWithoutChart() }));

    expect(screen.queryByRole('button', { name: /explore interactive canvas/i })).toBeNull();
    expect(screen.getByText(/no interactive diagram/i)).toBeDefined();
  });

  it('does not pretend to load a chart that does not exist', async () => {
    render(createElement(ChartLoader, { entry: entryWithoutChart() }));

    expect(screen.queryByText(/loading interactive canvas/i)).toBeNull();
    expect(loadChartMock).not.toHaveBeenCalled();
    expect(screen.getByText(/no interactive diagram/i)).toBeDefined();
  });

  it('keeps a reserved preview region when the static preview resolves', async () => {
    let resolvePreview: (value: unknown) => void = () => undefined;
    loadPreviewMock.mockReturnValue(new Promise((resolve: (value: unknown) => void) => { resolvePreview = resolve; }));

    render(createElement(ChartLoader, { entry: entryWithoutChart(), loadPreview: true }));

    const initialRegion = screen.getByTestId('chart-preview-region');
    expect(initialRegion.className).toContain('min-h-48');
    expect(screen.getByText(/loading static workflow preview/i)).toBeDefined();

    resolvePreview({ ok: true, preview });
    await waitFor(() => expect(screen.getByTestId('chart-preview-region').querySelector('[data-static-preview]')).not.toBeNull());
    expect(screen.getByTestId('chart-preview-region').className).toContain('min-h-48');
  });

  it('renders the canvas when a chart arrives', async () => {
    loadChartMock.mockResolvedValue({
      ok: true,
      chart: { nodes: [{ id: 'a', name: 'Trigger', type: 'n8n-nodes-base.webhook', x: 0, y: 0 }], edges: [] },
    });

    render(createElement(ChartLoader, { entry: entryWithChart() }));
    expect(loadChartMock).not.toHaveBeenCalled();
    explore();

    await waitFor(() => expect(screen.getByTestId('workflow-chart')).toBeDefined());
    expect(screen.queryByText(/loading interactive canvas/i)).toBeNull();
  });

  it('cancels stale chart work when the displayed entry changes', async () => {
    type CanvasModule = Awaited<ReturnType<NonNullable<ComponentProps<typeof ChartLoader>['loadCanvasModule']>>>;
    let resolveModule: (value: CanvasModule) => void = () => undefined;
    const loadCanvasModule = () => new Promise<CanvasModule>((resolve) => { resolveModule = resolve; });
    const first = { ...entryWithChart(), id: 'first', title: 'First workflow' } as Entry;
    const second = { ...entryWithChart(), id: 'second', title: 'Second workflow', chartRef: { shard: 1, offset: 128, length: 128 } } as Entry;
    const view = render(createElement(ChartLoader, { entry: first, loadCanvasModule }));
    explore();

    view.rerender(createElement(ChartLoader, { entry: second, loadCanvasModule }));
    resolveModule({ WorkflowChartComponent: () => createElement('div') });
    await waitFor(() => expect(loadChartMock).not.toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /explore interactive canvas/i })).toBeDefined();
  });
});
