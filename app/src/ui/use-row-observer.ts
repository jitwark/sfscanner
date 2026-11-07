import { useCallback, useEffect, useRef } from 'react';
import type { RowKey } from './row-offsets';

/** One row's measured border-box height, keyed by row identity. */
export type RowMeasurement = readonly [RowKey, number];

/** The border-box height a row reports, whatever shape the entry carries. */
function rowBorderBoxHeight(entry: ResizeObserverEntry): number {
  const box = entry.borderBoxSize?.[0];
  if (box) return box.blockSize;
  return entry.target.getBoundingClientRect().height;
}

/**
 * One `ResizeObserver` over the rendered rows, reporting each row's own height by
 * row identity.
 *
 * A listener on the window would be the wrong instrument: what changes a row's
 * height here is the row's own content — a chip row wrapping at 320px, a summary
 * that lands on two lines — and the browser already knows when that happens.
 *
 * Rows register as they mount and unregister when they are removed, so what is
 * observed is exactly what is rendered, and a row that leaves the window keeps
 * whatever the model measured for it.
 *
 * `onMeasurements` is an effect dependency: it must be stable, or the observer is
 * rebuilt on every render.
 */
export function useRowObserver(onMeasurements: (measurements: RowMeasurement[]) => void) {
  const registrations = useRef(new Map<RowKey, HTMLElement>());
  const keyByElement = useRef(new WeakMap<Element, RowKey>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const elementRefs = useRef(new Map<RowKey, (element: HTMLElement | null) => void>());

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const measurements: RowMeasurement[] = [];
      for (const entry of entries) {
        const key = keyByElement.current.get(entry.target);
        if (key !== undefined) measurements.push([key, rowBorderBoxHeight(entry)]);
      }
      // One callback per frame however many rows moved, so the model is copied
      // once per frame rather than once per row.
      if (measurements.length > 0) onMeasurements(measurements);
    });
    observerRef.current = observer;
    for (const element of registrations.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [onMeasurements]);

  const register = useCallback((key: RowKey, element: HTMLElement | null) => {
    const previous = registrations.current.get(key);
    if (element === previous) return;
    if (previous) {
      keyByElement.current.delete(previous);
      observerRef.current?.unobserve(previous);
    }
    if (!element) {
      registrations.current.delete(key);
      return;
    }
    registrations.current.set(key, element);
    keyByElement.current.set(element, key);
    observerRef.current?.observe(element);
  }, []);

  /** The ref for one rendered row, taken by row identity and cached per row. */
  return useCallback((key: RowKey) => {
    const cached = elementRefs.current.get(key);
    if (cached) return cached;
    const ref = (element: HTMLElement | null) => register(key, element);
    elementRefs.current.set(key, ref);
    return ref;
  }, [register]);
}
