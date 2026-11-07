import { describe, expect, it } from 'vitest';
import { MAX_BYTE_RANGE_BYTES, parseByteRangeIndex } from './byte-range-index';

const HASH = 'a'.repeat(64);

describe('parseByteRangeIndex', () => {
  it('accepts bounded offset, length, and hash records', () => {
    expect(parseByteRangeIndex({
      workflow: { offset: 12, length: 40, sha256: HASH },
    })).toEqual({
      workflow: { offset: 12, length: 40, sha256: HASH },
    });
  });

  it('rejects non-record indexes and malformed entries', () => {
    expect(() => parseByteRangeIndex([])).toThrow(/expected an object/i);
    expect(() => parseByteRangeIndex({ workflow: null })).toThrow(/invalid entry/i);
    expect(() => parseByteRangeIndex({ workflow: { offset: -1, length: 1, sha256: HASH } })).toThrow(/invalid entry/i);
    expect(() => parseByteRangeIndex({ workflow: { offset: 0, length: 1, sha256: 'bad' } })).toThrow(/invalid entry/i);
  });

  it('rejects empty IDs, oversized ranges, and arithmetic overflow', () => {
    expect(() => parseByteRangeIndex({ '': { offset: 0, length: 1, sha256: HASH } })).toThrow(/invalid entry/i);
    expect(() => parseByteRangeIndex({ workflow: { offset: 0, length: MAX_BYTE_RANGE_BYTES + 1, sha256: HASH } })).toThrow(/invalid entry/i);
    expect(() => parseByteRangeIndex({ workflow: { offset: Number.MAX_SAFE_INTEGER, length: 1, sha256: HASH } })).toThrow(/invalid entry/i);
  });

  it('does not allow a JSON __proto__ key to mutate the parsed index prototype', () => {
    const parsed = parseByteRangeIndex(JSON.parse(
      `{"__proto__":{"offset":0,"length":1,"sha256":"${HASH}"}}`,
    ));
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});
