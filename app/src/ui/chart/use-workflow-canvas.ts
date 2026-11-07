'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import {
  fitGraphToViewport,
  readableFitTransform,
  zoomAboutPoint,
  type CanvasFitOptions,
  type CanvasFocusNode,
  type CanvasGraphBounds,
  type CanvasTransform,
  type CanvasViewport,
} from './canvas-transform';

export type { CanvasFitOptions, CanvasFocusNode, CanvasGraphBounds, CanvasTransform, CanvasViewport };
export { fitGraphToViewport, READABLE_SCALE } from './canvas-transform';

type Point = { x: number; y: number };
type Gesture =
  | { kind: 'pan'; pointerId: number; start: Point; origin: CanvasTransform }
  | { kind: 'pinch'; pointerIds: [number, number]; distance: number; worldCenter: Point; originScale: number };

/**
 * Controls and the inspector must not be draggable surfaces. Nodes deliberately
 * are: once a graph is bigger than its viewport, most of the canvas is covered
 * in nodes, and refusing to pan from one makes the graph feel stuck.
 */
const DRAG_CONTROL_SELECTOR = '[data-canvas-control], aside, summary';
const ZOOM_CONTROL_SELECTOR = '[data-canvas-control], aside[aria-label="Node Inspector"]';
const matchesClosest = (target: EventTarget | null, selector: string) =>
  target instanceof Element && Boolean(target.closest(selector));

type UseWorkflowCanvasOptions = CanvasFitOptions & { initialScale?: number; anchor?: CanvasFocusNode };

export function useWorkflowCanvas(graph: CanvasGraphBounds, options: UseWorkflowCanvasOptions = {}) {
  const padding = options.padding ?? 32;
  const minScale = options.minScale ?? 0.25;
  const maxScale = options.maxScale ?? 1.25;
  const anchor = options.anchor;
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<CanvasViewport>({ width: 0, height: 0 });
  const [transform, setTransform] = useState<CanvasTransform>({ x: 0, y: 0, scale: options.initialScale ?? 1 });
  const transformRef = useRef(transform);
  const pointersRef = useRef(new Map<number, Point>());
  const gestureRef = useRef<Gesture | null>(null);
  /** Which (graph, viewport) pair we have already framed, so a resize does not discard the user's view. */
  const framedRef = useRef<string | null>(null);
  const containerRef = useCallback((element: HTMLDivElement | null) => setContainer(element), []);
  const fitOptions = { padding, minScale, maxScale };

  const commitTransform = useCallback((next: CanvasTransform) => {
    transformRef.current = next;
    setTransform(next);
  }, []);

  useEffect(() => {
    if (!container) return;
    const update = () => {
      const next = { width: container.clientWidth, height: container.clientHeight };
      setViewport((current) => (current.width === next.width && current.height === next.height ? current : next));
      if (next.width <= 0 || next.height <= 0) return;
      // Frame once per graph-and-viewport pair. The previous version re-fitted on
      // every ResizeObserver callback, so a mobile URL bar collapsing threw away
      // whatever the reader had panned to.
      const key = `${graph.width}x${graph.height}@${next.width}x${next.height}`;
      if (framedRef.current === key) return;
      framedRef.current = key;
      commitTransform(readableFitTransform(graph, next, fitOptions, anchor));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitTransform, container, graph.height, graph.width, maxScale, minScale, padding, anchor]);

  const fitAll = useCallback(() => {
    if (viewport.width > 0 && viewport.height > 0) {
      commitTransform(fitGraphToViewport(graph, viewport, fitOptions));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitTransform, graph, maxScale, minScale, padding, viewport]);

  // "Reset" used to jump to translate(0,0) scale(1) — an empty padding corner on
  // any real graph. Fitting is what the reader meant by it.
  const reset = fitAll;

  const focusNode = useCallback((node: CanvasFocusNode) => {
    if (viewport.width <= 0 || viewport.height <= 0) return;
    // Keep the reader's zoom; only pull it up if they are too far out to read.
    const scale = Math.min(maxScale, Math.max(minScale, Math.max(transformRef.current.scale, 0.75)));
    commitTransform({
      scale,
      x: viewport.width / 2 - (node.x + node.width / 2) * scale,
      y: viewport.height / 2 - (node.y + node.height / 2) * scale,
    });
  }, [commitTransform, maxScale, minScale, viewport]);

  const zoomAt = useCallback((nextScale: number, point: Point) => {
    commitTransform(zoomAboutPoint(transformRef.current, nextScale, point, { minScale, maxScale }));
  }, [commitTransform, maxScale, minScale]);

  /**
   * React registers `wheel` passively at the root, so `preventDefault()` inside
   * an `onWheel` prop is discarded — the page scrolled while the reader zoomed
   * and the console logged an error on every tick. A native non-passive
   * listener is the only way to hold the gesture.
   */
  useEffect(() => {
    if (!container) return;
    const onNativeWheel = (event: globalThis.WheelEvent) => {
      if (matchesClosest(event.target, ZOOM_CONTROL_SELECTOR)) return;
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      zoomAt(transformRef.current.scale * (event.deltaY < 0 ? 1.12 : 0.88), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    container.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => container.removeEventListener('wheel', onNativeWheel);
  }, [container, zoomAt]);

  const beginGesture = useCallback((element: HTMLDivElement) => {
    const entries = Array.from(pointersRef.current.entries());
    if (entries.length === 0) {
      gestureRef.current = null;
      return;
    }
    if (entries.length === 1) {
      const [pointerId, start] = entries[0]!;
      gestureRef.current = { kind: 'pan', pointerId, start, origin: transformRef.current };
      return;
    }
    const [[firstId, first], [secondId, second]] = entries as [[number, Point], [number, Point]];
    const rect = element.getBoundingClientRect();
    const center = { x: (first.x + second.x) / 2 - rect.left, y: (first.y + second.y) / 2 - rect.top };
    const current = transformRef.current;
    gestureRef.current = {
      kind: 'pinch',
      pointerIds: [firstId, secondId],
      distance: Math.hypot(second.x - first.x, second.y - first.y),
      worldCenter: { x: (center.x - current.x) / current.scale, y: (center.y - current.y) / current.scale },
      originScale: current.scale,
    };
  }, []);

  const onDoubleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (matchesClosest(event.target, ZOOM_CONTROL_SELECTOR)) return;
    fitAll();
  }, [fitAll]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (matchesClosest(event.target, DRAG_CONTROL_SELECTOR)) return;
    // A capture request for an unknown pointer id throws, and an exception here
    // would abort the gesture before it is recorded.
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* not capturable */ }
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    beginGesture(event.currentTarget);
  }, [beginGesture]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (gesture.kind === 'pan') {
      const point = pointersRef.current.get(gesture.pointerId);
      if (point) {
        commitTransform({
          ...gesture.origin,
          x: gesture.origin.x + point.x - gesture.start.x,
          y: gesture.origin.y + point.y - gesture.start.y,
        });
      }
      return;
    }
    const [first, second] = gesture.pointerIds.map((id) => pointersRef.current.get(id));
    if (!first || !second) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const center = { x: (first.x + second.x) / 2 - rect.left, y: (first.y + second.y) / 2 - rect.top };
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    const scale = Math.min(maxScale, Math.max(minScale, gesture.originScale * distance / Math.max(1, gesture.distance)));
    commitTransform({ scale, x: center.x - gesture.worldCenter.x * scale, y: center.y - gesture.worldCenter.y * scale });
  }, [commitTransform, maxScale, minScale]);

  const onPointerEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    beginGesture(event.currentTarget);
  }, [beginGesture]);

  const zoomIn = useCallback(() => zoomAt(transformRef.current.scale * 1.2, { x: viewport.width / 2, y: viewport.height / 2 }), [viewport, zoomAt]);
  const zoomOut = useCallback(() => zoomAt(transformRef.current.scale * 0.8, { x: viewport.width / 2, y: viewport.height / 2 }), [viewport, zoomAt]);

  return {
    containerRef, viewport, transform, fitAll, reset, focusNode, zoomIn, zoomOut, onDoubleClick,
    onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd,
  };
}
