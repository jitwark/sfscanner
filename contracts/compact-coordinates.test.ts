import { describe, expect, it } from 'vitest';
import { compactCoordinates } from './compact-coordinates';

describe('compactCoordinates', () => {
  it('collapses a runaway gap to the maximum', () => {
    const result = compactCoordinates([{ x: 0, y: 0 }, { x: 5000, y: 0 }], { maxXGap: 200, maxYGap: 70 });
    expect(result[1]!.x).toBe(200);
  });

  it('leaves an already-reasonable gap alone', () => {
    const result = compactCoordinates([{ x: 0, y: 0 }, { x: 180, y: 0 }], { maxXGap: 200, maxYGap: 70 });
    expect(result[1]!.x).toBe(180);
  });

  it('preserves ordering and shared coordinates', () => {
    const points = [{ x: 400, y: 10 }, { x: 0, y: 10 }, { x: 900, y: 10 }];
    const result = compactCoordinates(points, { maxXGap: 200, maxYGap: 70 });
    // Original order 0 < 400 < 900 must survive as 0 < mid < max.
    expect(result[1]!.x).toBeLessThan(result[0]!.x);
    expect(result[0]!.x).toBeLessThan(result[2]!.x);
    // All three shared a y, so they must still share one.
    expect(new Set(result.map((point) => point.y)).size).toBe(1);
  });

  it('snaps sub-threshold jitter onto a shared line', () => {
    // A node nudged a few pixels in the editor is not a new row.
    const result = compactCoordinates([{ x: 0, y: 0 }, { x: 0, y: 6 }], { maxXGap: 200, maxYGap: 70 });
    expect(result[0]!.y).toBe(result[1]!.y);
  });

  it('returns an empty result for no points', () => {
    expect(compactCoordinates([], { maxXGap: 200, maxYGap: 70 })).toEqual([]);
  });
});
