import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fitGraphToViewport, useWorkflowCanvas } from './use-workflow-canvas';

class ResizeObserverFake {
  static instances: ResizeObserverFake[] = [];
  readonly callback: ResizeObserverCallback;
  readonly disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverFake.instances.push(this);
  }

  observe() {}
  unobserve() {}
}

function setElementSize(element: HTMLElement, width: number, height: number) {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
}

function pointerEvent(element: HTMLDivElement, pointerId: number, clientX: number, clientY: number) {
  return {
    target: element,
    currentTarget: element,
    pointerId,
    clientX,
    clientY,
  } as unknown as React.PointerEvent<HTMLDivElement>;
}

beforeEach(() => {
  ResizeObserverFake.instances = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverFake);
});

describe('fitGraphToViewport', () => {
  it('keeps an identity transform for a zero-size viewport', () => {
    expect(fitGraphToViewport({ width: 800, height: 400 }, { width: 0, height: 0 })).toEqual({
      x: 0,
      y: 0,
      scale: 1,
    });
  });

  it('fits a wide graph by its width', () => {
    expect(fitGraphToViewport(
      { width: 1_000, height: 200 },
      { width: 500, height: 300 },
      { padding: 50, minScale: 0.1, maxScale: 2 },
    )).toEqual({ scale: 0.4, x: 50, y: 110 });
  });

  it('fits a tall graph by its height', () => {
    expect(fitGraphToViewport(
      { width: 200, height: 1_000 },
      { width: 500, height: 300 },
      { padding: 50, minScale: 0.1, maxScale: 2 },
    )).toEqual({ scale: 0.2, x: 230, y: 50 });
  });

  it('clamps the fitted scale to the configured minimum and maximum', () => {
    expect(fitGraphToViewport(
      { width: 1_000, height: 1_000 },
      { width: 100, height: 100 },
      { padding: 0, minScale: 0.25, maxScale: 2 },
    )).toEqual({ scale: 0.25, x: -75, y: -75 });
    expect(fitGraphToViewport(
      { width: 100, height: 100 },
      { width: 1_000, height: 1_000 },
      { padding: 0, minScale: 0.25, maxScale: 1.5 },
    )).toEqual({ scale: 1.5, x: 425, y: 425 });
  });

  it('centers the graph with symmetric margins', () => {
    const graph = { width: 320, height: 180 };
    const viewport = { width: 800, height: 500 };
    const transform = fitGraphToViewport(graph, viewport, { padding: 24 });

    const horizontalMargins = [
      transform.x,
      viewport.width - transform.x - graph.width * transform.scale,
    ];
    const verticalMargins = [
      transform.y,
      viewport.height - transform.y - graph.height * transform.scale,
    ];
    expect(horizontalMargins[0]).toBeCloseTo(horizontalMargins[1]);
    expect(verticalMargins[0]).toBeCloseTo(verticalMargins[1]);
  });
});

describe('useWorkflowCanvas', () => {
  /**
   * The opening view is deliberately NOT "fit everything". The median catalogue
   * workflow is a long horizontal chain, so fitting it resolves to roughly 0.33
   * on desktop — an unreadable thumbnail. The canvas opens at a legible zoom
   * and offers fit-to-screen as an explicit action instead.
   */
  it('opens at a readable zoom when the graph cannot fit legibly', async () => {
    const element = document.createElement('div');
    element.setPointerCapture = vi.fn();
    element.releasePointerCapture = vi.fn();
    element.hasPointerCapture = vi.fn(() => false);
    setElementSize(element, 0, 0);
    const { result } = renderHook(() => useWorkflowCanvas(
      { width: 800, height: 400 },
      { padding: 0, minScale: 0.1, maxScale: 2 },
    ));

    act(() => result.current.containerRef(element));
    expect(result.current.transform).toEqual({ x: 0, y: 0, scale: 1 });

    // True fit here would be 0.5 — legible enough to see, too small to read.
    setElementSize(element, 400, 300);
    act(() => ResizeObserverFake.instances[0].callback([], ResizeObserverFake.instances[0]));
    await waitFor(() => expect(result.current.transform.scale).toBe(0.75));

    // Explicit fit still goes all the way out; that is the reader's choice.
    act(() => result.current.fitAll());
    await waitFor(() => expect(result.current.transform).toEqual({ x: 0, y: 50, scale: 0.5 }));
  });

  it('uses the true fit when the graph already fits at a readable size', async () => {
    const element = document.createElement('div');
    setElementSize(element, 600, 300);
    const { result } = renderHook(() => useWorkflowCanvas(
      { width: 800, height: 400 },
      { padding: 0, minScale: 0.1, maxScale: 2 },
    ));

    act(() => result.current.containerRef(element));
    // fit = min(600/800, 300/400) = 0.75, which clears the readable floor.
    await waitFor(() => expect(result.current.transform).toEqual({ x: 0, y: 0, scale: 0.75 }));
  });

  it('re-frames when graph bounds change', async () => {
    const element = document.createElement('div');
    setElementSize(element, 400, 300);
    const { result, rerender } = renderHook(
      ({ width }) => useWorkflowCanvas(
        { width, height: 200 },
        { padding: 0, minScale: 0.1, maxScale: 2 },
      ),
      { initialProps: { width: 400 } },
    );

    act(() => result.current.containerRef(element));
    await waitFor(() => expect(result.current.transform).toEqual({ x: 0, y: 50, scale: 1 }));

    // Widening past what fits legibly drops to the readable floor, not to 0.5.
    rerender({ width: 800 });
    await waitFor(() => expect(result.current.transform.scale).toBe(0.75));
  });

  it('zooms around the midpoint of two active pointers', async () => {
    const element = document.createElement('div');
    element.setPointerCapture = vi.fn();
    element.releasePointerCapture = vi.fn();
    element.hasPointerCapture = vi.fn(() => false);
    setElementSize(element, 400, 300);
    const { result } = renderHook(() => useWorkflowCanvas(
      { width: 500, height: 500 },
      { padding: 0, minScale: 0.1, maxScale: 3 },
    ));

    act(() => result.current.containerRef(element));
    // True fit would be 0.6; the readable floor opens it at 0.75.
    await waitFor(() => expect(result.current.transform.scale).toBe(0.75));
    act(() => {
      result.current.onPointerDown(pointerEvent(element, 1, 100, 100));
      result.current.onPointerDown(pointerEvent(element, 2, 200, 100));
      result.current.onPointerMove(pointerEvent(element, 2, 300, 100));
    });

    // Pinching from 100px to 200px apart doubles the scale about the midpoint.
    expect(result.current.transform.scale).toBeCloseTo(1.5);
    expect(result.current.transform.x).toBeCloseTo(-100);
    expect(result.current.transform.y).toBeCloseTo(-100);
  });

  it('claims wheel zoom so the page does not scroll under the canvas', async () => {
    const element = document.createElement('div');
    setElementSize(element, 320, 240);
    const { result } = renderHook(() => useWorkflowCanvas({ width: 500, height: 300 }));

    act(() => result.current.containerRef(element));
    await waitFor(() => expect(result.current.viewport).toEqual({ width: 320, height: 240 }));
    const wheel = new WheelEvent('wheel', { cancelable: true, deltaY: -100 });

    act(() => element.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(true);
    expect(result.current.transform.scale).toBeGreaterThan(0.75);
  });

  it('removes the native wheel listener when the canvas unmounts', async () => {
    const element = document.createElement('div');
    setElementSize(element, 320, 240);
    const removeEventListener = vi.spyOn(element, 'removeEventListener');
    const { result, unmount } = renderHook(() => useWorkflowCanvas({ width: 500, height: 300 }));

    act(() => result.current.containerRef(element));
    await waitFor(() => expect(result.current.viewport).toEqual({ width: 320, height: 240 }));
    unmount();

    expect(removeEventListener).toHaveBeenCalledWith('wheel', expect.any(Function));
    const wheel = new WheelEvent('wheel', { cancelable: true, deltaY: -100 });
    element.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });

  it('disconnects its ResizeObserver when the canvas unmounts', async () => {
    const element = document.createElement('div');
    setElementSize(element, 320, 240);
    const { result, unmount } = renderHook(() => useWorkflowCanvas({ width: 500, height: 300 }));

    act(() => result.current.containerRef(element));
    await waitFor(() => expect(result.current.viewport).toEqual({ width: 320, height: 240 }));
    const observer = ResizeObserverFake.instances[0];
    unmount();

    expect(observer?.disconnect).toHaveBeenCalledOnce();
  });
});
