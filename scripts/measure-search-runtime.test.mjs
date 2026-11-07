import { describe, expect, it } from 'vitest';
import { percentile, summarizeResourceEntries, summarizeResponses } from './measure-search-runtime.mjs';

describe('search runtime measurement helpers', () => {
  it('sums available resource timing bytes and names missing fields', () => {
    expect(summarizeResourceEntries([
      { transferSize: 10, encodedBodySize: 8, decodedBodySize: 20 },
      { transferSize: 5, encodedBodySize: 4, decodedBodySize: null },
    ])).toEqual({
      requests: 2,
      transferBytes: 15,
      encodedBytes: 12,
      decodedBytes: 20,
      unavailable: ['decodedBodySize'],
    });
  });

  it('does not invent content lengths for chunked responses', () => {
    expect(summarizeResponses([
      { contentLength: '12' },
      { contentLength: null },
      { contentLength: 'not-a-number' },
    ])).toEqual({ responses: 3, contentLengthBytes: 12, knownContentLengthResponses: 1 });
  });

  it('calculates deterministic interpolated percentiles from unsorted samples', () => {
    expect(percentile([40, 10, 30, 20], 50)).toBe(25);
    expect(percentile([40, 10, 30, 20], 95)).toBe(38.5);
    expect(percentile([], 50)).toBeNull();
  });
});
