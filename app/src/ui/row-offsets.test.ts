import { describe, expect, it } from 'vitest';
import {
  CARD_MIN_CONTENT_HEIGHT,
  MIN_ROW_HEIGHT,
  createRowOffsetModel,
  indexAtOffset,
  recordRowHeights,
  rowHeightAt,
  rowPrefixSums,
} from './row-offsets';

const offsets = (model: ReturnType<typeof createRowOffsetModel>, count: number, seed = MIN_ROW_HEIGHT) =>
  Array.from(rowPrefixSums(model, Array.from({ length: count }, (_, index) => `row-${index}`), seed));

describe('row offsets', () => {
  it('declares the card floor and the row pitch it implies', () => {
    // The card's content box is 92 (`min-h-[92px]`); a row adds `py-3` (24) and
    // the divider (1). Both numbers are pinned against the real card in the
    // browser spec, so a change to either the card or the seed fails there.
    expect(CARD_MIN_CONTENT_HEIGHT).toBe(92);
    expect(MIN_ROW_HEIGHT).toBe(117);
  });

  it('places rows nothing has measured on the floor', () => {
    const model = createRowOffsetModel();
    expect(offsets(model, 4)).toEqual([0, 117, 234, 351, 468]);
    expect(rowHeightAt(model, 'never-rendered', MIN_ROW_HEIGHT)).toBe(MIN_ROW_HEIGHT);
    expect(rowPrefixSums(model, ['a', 'b', 'c', 'd'], MIN_ROW_HEIGHT)[4]).toBe(4 * MIN_ROW_HEIGHT);
  });

  it('moves every row after a measured one, and only those', () => {
    const model = recordRowHeights(createRowOffsetModel(), [['row-2', 300]]);
    expect(offsets(model, 6)).toEqual([0, 117, 234, 534, 651, 768, 885]);
    expect(rowHeightAt(model, 'row-2', MIN_ROW_HEIGHT)).toBe(300);
    // Above the measured row nothing moved: this is what keeps the rows the
    // reader is looking at still while a row below them is corrected.
    expect(offsets(model, 3).slice(0, 3)).toEqual([0, 117, 234]);
  });

  it('keys a measurement to the row, not to the slot', () => {
    const model = recordRowHeights(createRowOffsetModel(), [['b', 300]]);
    expect(Array.from(rowPrefixSums(model, ['a', 'b', 'c'], MIN_ROW_HEIGHT))).toEqual([0, 117, 417, 534]);
    // The same three rows in another order: `b` carries its height with it.
    expect(Array.from(rowPrefixSums(model, ['b', 'a', 'c'], MIN_ROW_HEIGHT))).toEqual([0, 300, 417, 534]);
    // A result the measurement does not describe is not affected by it.
    expect(Array.from(rowPrefixSums(model, ['x', 'y'], MIN_ROW_HEIGHT))).toEqual([0, 117, 234]);
  });

  it('produces the same offsets however the measurements arrived', () => {
    const forwards = createRowOffsetModel();
    const backwards = createRowOffsetModel();
    const measurements: Array<readonly [string, number]> = [['row-1', 180], ['row-4', 333.8], ['row-7', 210.25]];
    recordRowHeights(forwards, measurements);
    for (const measurement of [...measurements].reverse()) recordRowHeights(backwards, [measurement]);
    expect(offsets(backwards, 9)).toEqual(offsets(forwards, 9));
  });

  it('ignores a height the browser could not have laid out', () => {
    const model = recordRowHeights(createRowOffsetModel(), [
      ['row-0', 0],
      ['row-1', Number.NaN],
      ['row-2', Number.POSITIVE_INFINITY],
      ['row-3', -20],
    ]);
    expect(model.heights.size).toBe(0);
    expect(offsets(model, 4)).toEqual([0, 117, 234, 351, 468]);
  });

  it('keeps the model it was given when a frame changed nothing', () => {
    const measured = recordRowHeights(createRowOffsetModel(), [['row-5', 240]]);
    expect(recordRowHeights(measured, [['row-5', 240]])).toBe(measured);
    expect(recordRowHeights(measured, [['row-5', 240.5]]).heights.get('row-5')).toBe(240.5);
  });

  it('never lets a deferred placeholder replace a measured height', () => {
    const measured = recordRowHeights(createRowOffsetModel(), [['row-1', 300]], MIN_ROW_HEIGHT);
    // A row that leaves the window is unmounted, and the browser remembers a
    // laid-out size only for as long as the element lives. The remounted row is
    // laid out at the floor until it is rendered — the model is what remembers.
    expect(recordRowHeights(measured, [['row-1', MIN_ROW_HEIGHT]], MIN_ROW_HEIGHT).heights.get('row-1')).toBe(300);
    // A row nothing has measured takes the placeholder: it *is* the floor.
    expect(recordRowHeights(createRowOffsetModel(), [['row-9', MIN_ROW_HEIGHT]], MIN_ROW_HEIGHT).heights.get('row-9')).toBe(MIN_ROW_HEIGHT);
    // And a real re-layout still lands, shorter or taller.
    expect(recordRowHeights(measured, [['row-1', 250]], MIN_ROW_HEIGHT).heights.get('row-1')).toBe(250);
    expect(recordRowHeights(measured, [['row-1', 380]], MIN_ROW_HEIGHT).heights.get('row-1')).toBe(380);
  });

  it('lands a scroll distance in the row that contains it', () => {
    const model = recordRowHeights(createRowOffsetModel(), [['row-1', 300]]);
    const keys = Array.from({ length: 10 }, (_, index) => `row-${index}`);
    const sums = rowPrefixSums(model, keys, MIN_ROW_HEIGHT);
    expect([sums[0], sums[1], sums[2]]).toEqual([0, 117, 417]);
    expect(indexAtOffset(sums, 0)).toBe(0);
    expect(indexAtOffset(sums, 116)).toBe(0);
    // A distance that lands exactly on a row's start belongs to that row.
    expect(indexAtOffset(sums, 117)).toBe(1);
    expect(indexAtOffset(sums, 416)).toBe(1);
    expect(indexAtOffset(sums, 417)).toBe(2);
    expect(indexAtOffset(sums, -50)).toBe(0);
    // Past the end: the last row, never an index the list does not have.
    expect(indexAtOffset(sums, 1e9)).toBe(9);
    expect(indexAtOffset(rowPrefixSums(model, [], MIN_ROW_HEIGHT), 100)).toBe(0);
  });
});
