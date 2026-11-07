/**
 * Where the rows of a virtualized list actually sit.
 *
 * Result rows are content-sized: measured in a real browser they run 223.4-388.9
 * px at 320px wide, 140.6-223.4 px at 768px and 131.0-168.2 px at 1440px,
 * because a row carries a title, a two-line summary, a chip row that wraps
 * differently at every width, and a metadata column. One unit cannot place them.
 * The unit this replaced did not merely approximate — it placed a row where the
 * rows above it would be if every one of them were the card's `min-h` content box
 * (92px), so the space it reserved for a skipped row was around a third of what
 * that row really occupied, and the page's scroll height came out thousands of
 * pixels short of the rows it contained.
 *
 * So the list carries a height per row instead: measured for rows that have been
 * rendered, and the declared floor for rows that have not. Offsets are the
 * running prefix sum of those heights, which is what makes the space above the
 * window, the window itself and the space below it one continuous statement
 * about where every row is.
 *
 * Heights are keyed by row *identity*, not by slot: results get appended,
 * filtered and replaced under the same indices, and a height measured from one
 * result must never be applied to another.
 *
 * Pure and deterministic: every function here is a function of the model, the
 * seed and the ordered row keys. No clock, no randomness, and no dependence on
 * the order measurements arrived in — `recordRowHeights` is a keyed write, and
 * offsets are read in key order.
 */

export type RowKey = string | number;

/**
 * The card's own content-box floor — `result-card.tsx`'s `min-h-[92px]` and its
 * `contain-intrinsic-size`, which is a *content* box and so is 92, not the
 * pitch between two rows.
 */
export const CARD_MIN_CONTENT_HEIGHT = 92;

/** `py-3` on the card. */
const ROW_PADDING = 24;

/** The hairline the list draws between two rows. */
const ROW_DIVIDER = 1;

/**
 * The smallest pitch a row can have: 92 + 24 + 1 = 117.
 *
 * This is the seed for a row nothing has measured yet, and it is a measurement
 * rather than a guess: a 320px viewport draws every card's chips on their own
 * line, but a card whose contents the browser has deferred is laid out at
 * exactly this height — which is why it is the floor, and why the unit it
 * replaced (92, the content box alone) was never the pitch of anything.
 */
export const MIN_ROW_HEIGHT = CARD_MIN_CONTENT_HEIGHT + ROW_PADDING + ROW_DIVIDER;

export type RowOffsetModel = {
  /** Measured row pitch, keyed by row identity. Sparse: only rendered rows appear. */
  readonly heights: ReadonlyMap<RowKey, number>;
};

export function createRowOffsetModel(): RowOffsetModel {
  return { heights: new Map() };
}

/** One row's height: what was measured for it, or the declared floor. */
export function rowHeightAt(model: RowOffsetModel, key: RowKey, seed: number): number {
  const measured = model.heights.get(key);
  return measured === undefined ? seed : measured;
}

/**
 * Write one frame's measurements into the model.
 *
 * Batched on purpose: a `ResizeObserver` callback delivers every row that changed
 * in the same frame at once, so one copy of the map per frame is what keeps this
 * O(rows) per frame instead of O(rows) per measured row. Returns the model it was
 * given when nothing moved, so React can skip the re-render.
 *
 * A reading of exactly `seed` is the browser's placeholder for a row whose
 * contents it has deferred — the right answer for a row nobody has laid out, and
 * the wrong one for a row this model has already measured. The browser remembers
 * a laid-out row's size only for as long as that element lives, and a virtual
 * list unmounts the rows that leave its window: a row that scrolls back in is a
 * new element, laid out at the floor until it is rendered. The model is what
 * remembers, so the placeholder never replaces a measurement. (The cost is that a
 * row whose own content really does shrink to exactly the floor keeps its larger
 * height until the list is re-seeded at a new width.)
 */
export function recordRowHeights(
  model: RowOffsetModel,
  measurements: Iterable<readonly [RowKey, number]>,
  seed: number = MIN_ROW_HEIGHT
): RowOffsetModel {
  let heights: Map<RowKey, number> | null = null;
  for (const [key, height] of measurements) {
    // A row that reports 0 or NaN is one the browser did not lay out — a
    // detached node, or a hidden list. The floor is a better answer than a
    // measurement that would collapse the list.
    if (!Number.isFinite(height) || height <= 0) continue;
    const measured = model.heights.get(key);
    if (measured === height) continue;
    if (measured !== undefined && measured !== seed && height === seed) continue;
    heights ??= new Map(model.heights);
    heights.set(key, height);
  }
  return heights ? { heights } : model;
}

/**
 * Running prefix sums of the row heights, in the order the keys are given.
 * `sums[index]` is the distance from the top of the list to the start of that
 * row, and `sums[keys.length]` is the height of the whole list.
 */
export function rowPrefixSums(model: RowOffsetModel, keys: readonly RowKey[], seed: number): Float64Array {
  const sums = new Float64Array(keys.length + 1);
  let offset = 0;
  for (let index = 0; index < keys.length; index += 1) {
    sums[index] = offset;
    offset += rowHeightAt(model, keys[index], seed);
  }
  sums[keys.length] = offset;
  return sums;
}

/**
 * The row a distance from the top lands in, clamped to the list. A distance that
 * falls exactly on a row's start belongs to that row.
 */
export function indexAtOffset(sums: Float64Array, offset: number): number {
  let low = 0;
  let high = sums.length - 2;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (sums[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}
