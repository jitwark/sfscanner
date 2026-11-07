/**
 * Compact embedded n8n editor coordinates without losing the author's layout.
 *
 * 99.80% of catalogue charts carry real editor coordinates, and those sprawl:
 * the median graph spans 2,516 units and the widest 20,660, because people drag
 * nodes apart in the n8n canvas. Passing them through meant the fitted zoom
 * landed at 0.33 on desktop and 0.18 on mobile.
 *
 * The fix is to clamp the *gaps*, not to re-layout. Ordering, alignment, and
 * which-node-sits-beside-which are the author's information; the raw distance
 * between two columns is not. So: collect the distinct coordinates on each
 * axis, walk them in order, and rebuild them with every gap clamped to a
 * sensible maximum. Nodes that shared a coordinate still share it, nodes that
 * were adjacent stay adjacent, and a 5,000-unit void becomes one column gap.
 */

/** Gaps at or below this are already reasonable and pass through untouched. */
type CompactOptions = {
  maxGap: number;
  /** Distinct positions closer than this are treated as the same row/column. */
  snap: number;
  /**
   * Smallest distance two *distinct* rows or columns may end up apart.
   *
   * Without this the function clamped only the maximum, while the renderer
   * draws fixed 140x44 boxes — so two nodes 40 editor-units apart on x stayed
   * 40 apart and their boxes overlapped by 100px. Measured over 13,221 charts,
   * 13.58% had at least one overlapping pair; a minimum gap takes that to 0.28%
   * and costs 0.022 of median fitted scale (audit 2026-08-25, CV-3).
   *
   * Optional so a caller that only wants gaps collapsed keeps the old
   * behaviour.
   */
  minGap?: number;
};

/**
 * Build a map from each distinct original coordinate to its compacted position.
 */
function compactAxis(values: number[], { maxGap, snap, minGap }: CompactOptions): Map<number, number> {
  const mapping = new Map<number, number>();
  if (values.length === 0) return mapping;

  const distinct = [...new Set(values)].sort((a, b) => a - b);
  let previousOriginal = distinct[0]!;
  let position = 0;
  mapping.set(previousOriginal, position);
  // A minimum wider than the maximum would make the band empty; the floor wins,
  // because overlapping nodes are a worse failure than a wide graph.
  const ceiling = minGap === undefined ? maxGap : Math.max(maxGap, minGap);

  for (let index = 1; index < distinct.length; index += 1) {
    const original = distinct[index]!;
    const gap = original - previousOriginal;
    // Sub-`snap` jitter (a node nudged 3px in the editor) collapses to a shared
    // line, which is almost always what the author meant to draw. Anything
    // further apart is a distinct row or column and gets clamped into a band
    // rather than only under a ceiling.
    const compacted = gap < snap ? 0 : Math.min(Math.max(gap, minGap ?? 0), ceiling);
    position += compacted;
    mapping.set(original, position);
    previousOriginal = original;
  }

  return mapping;
}

export type CompactablePoint = { x: number; y: number };

export type CompactCoordinatesOptions = {
  maxXGap: number;
  maxYGap: number;
  snapX?: number;
  snapY?: number;
  /** Node width plus a gutter. Omit to keep the pre-CV-3 behaviour. */
  minXGap?: number;
  /** Node height plus a gutter. Omit to keep the pre-CV-3 behaviour. */
  minYGap?: number;
};

/**
 * Returns a new position for every input point, in the same order.
 *
 * Pure: it neither reads nor mutates anything outside its arguments, so it is
 * cheap to test against a real catalogue record.
 */
export function compactCoordinates(
  points: readonly CompactablePoint[],
  { maxXGap, maxYGap, snapX = 24, snapY = 24, minXGap, minYGap }: CompactCoordinatesOptions,
): CompactablePoint[] {
  const xMap = compactAxis(points.map((point) => point.x), { maxGap: maxXGap, snap: snapX, minGap: minXGap });
  const yMap = compactAxis(points.map((point) => point.y), { maxGap: maxYGap, snap: snapY, minGap: minYGap });
  return points.map((point) => ({
    x: xMap.get(point.x) ?? 0,
    y: yMap.get(point.y) ?? 0,
  }));
}
