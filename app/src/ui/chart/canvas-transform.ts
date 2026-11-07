/**
 * Pure viewport maths for the workflow canvas.
 *
 * Kept separate from the hook so the arithmetic that decides what a user sees
 * on first paint can be tested without rendering anything.
 */

export type CanvasGraphBounds = { width: number; height: number };
export type CanvasViewport = { width: number; height: number };
export type CanvasTransform = { x: number; y: number; scale: number };
export type CanvasFocusNode = { x: number; y: number; width: number; height: number };
export type CanvasFitOptions = { padding?: number; minScale?: number; maxScale?: number };

/**
 * Below this scale a 44-unit-tall node renders under ~33 CSS px and its label
 * stops being readable. It is the floor for the *default* view, never for the
 * explicit "Fit" action — choosing to zoom out to an overview is legitimate.
 */
export const READABLE_SCALE = 0.75;

/** Scale that makes the whole graph fit, clamped to the configured bounds. */
export function fitGraphToViewport(
  graph: CanvasGraphBounds,
  viewport: CanvasViewport,
  options: CanvasFitOptions = {},
): CanvasTransform {
  if (viewport.width <= 0 || viewport.height <= 0) return { x: 0, y: 0, scale: 1 };
  const padding = options.padding ?? 32;
  const minScale = options.minScale ?? 0.25;
  const maxScale = options.maxScale ?? 1.25;
  const usableWidth = Math.max(1, viewport.width - padding * 2);
  const usableHeight = Math.max(1, viewport.height - padding * 2);
  const scale = Math.min(
    maxScale,
    Math.max(minScale, Math.min(usableWidth / Math.max(1, graph.width), usableHeight / Math.max(1, graph.height))),
  );
  return {
    scale,
    x: (viewport.width - graph.width * scale) / 2,
    y: (viewport.height - graph.height * scale) / 2,
  };
}

/**
 * The transform a user should land on when the canvas first appears.
 *
 * Fitting the whole graph sounds right and is wrong for this corpus: the median
 * catalogue workflow is a long horizontal chain, so "fit everything" resolves to
 * roughly 0.33 on desktop and pins to the minimum on mobile — an unreadable
 * thumbnail. Real diagram tools default to a legible zoom and offer fit-to-screen
 * as a deliberate action, so that is what this does.
 *
 * When the graph genuinely fits at a readable size, the fitted transform is
 * used unchanged. Otherwise the canvas opens at `READABLE_SCALE`, anchored on
 * the node the reader should start from — the trigger.
 */
export function readableFitTransform(
  graph: CanvasGraphBounds,
  viewport: CanvasViewport,
  options: CanvasFitOptions = {},
  anchor?: CanvasFocusNode,
): CanvasTransform {
  const fitted = fitGraphToViewport(graph, viewport, options);
  if (viewport.width <= 0 || viewport.height <= 0) return fitted;

  const maxScale = options.maxScale ?? 1.25;
  const readable = Math.min(maxScale, READABLE_SCALE);
  if (fitted.scale >= readable) return fitted;

  const padding = options.padding ?? 32;
  const scale = readable;
  if (!anchor) {
    // No anchor: show the top-left of the graph rather than its centre, so the
    // reader starts where a left-to-right flow starts.
    return { scale, x: padding, y: padding };
  }
  return {
    scale,
    // Seat the anchor a little in from the left edge and vertically centred.
    x: padding - anchor.x * scale,
    y: viewport.height / 2 - (anchor.y + anchor.height / 2) * scale,
  };
}

/** Zoom about a fixed viewport point, keeping the world point under it still. */
export function zoomAboutPoint(
  current: CanvasTransform,
  nextScale: number,
  point: { x: number; y: number },
  options: CanvasFitOptions = {},
): CanvasTransform {
  const minScale = options.minScale ?? 0.25;
  const maxScale = options.maxScale ?? 1.25;
  const scale = Math.min(maxScale, Math.max(minScale, nextScale));
  const worldX = (point.x - current.x) / current.scale;
  const worldY = (point.y - current.y) / current.scale;
  return { scale, x: point.x - worldX * scale, y: point.y - worldY * scale };
}
