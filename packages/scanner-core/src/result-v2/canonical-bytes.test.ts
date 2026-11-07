import { describe, expect, it } from 'vitest';
import { canonicalBytesV1 } from './canonical-bytes';

const text = (value: unknown): string => new TextDecoder().decode(canonicalBytesV1(value));

describe('canonicalBytesV1', () => {
  it('sorts object keys by Unicode code point, not UTF-16 code unit', () => {
    expect(text({ '\u{1f600}': 1, '\ue000': 2 })).toBe('{"\ue000":2,"😀":1}');
  });

  it('uses compact JSON and fixed escaping', () => {
    expect(text({ value: '"\\\b\t\n\f\r\u0000' })).toBe('{"value":"\\\"\\\\\\b\\t\\n\\f\\r\\u0000"}');
    expect(text({ negativeZero: -0, fraction: 1.5 })).toBe('{"fraction":1.5,"negativeZero":0}');
  });

  it('retains array order and returns UTF-8 bytes', () => {
    expect(text(['é', '😀', true, null])).toBe('["é","😀",true,null]');
    expect(canonicalBytesV1('é')).toEqual(Uint8Array.of(0x22, 0xc3, 0xa9, 0x22));
  });

  it.each([
    ['undefined', undefined], ['nan', Number.NaN], ['infinity', Number.POSITIVE_INFINITY],
    ['function', () => undefined], ['symbol', Symbol('x')], ['bigint', 1n],
  ])('rejects %s', (_, value) => expect(() => canonicalBytesV1(value)).toThrow(TypeError));

  it('rejects cycles, accessors, sparse arrays, symbols, and non-plain objects', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const accessor = {}; Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 });
    const sparse = new Array(1);
    const symbols = {}; Object.defineProperty(symbols, Symbol('x'), { enumerable: false, value: 1 });
    expect(() => canonicalBytesV1(cycle)).toThrow(TypeError);
    expect(() => canonicalBytesV1(accessor)).toThrow(TypeError);
    expect(() => canonicalBytesV1(sparse)).toThrow(TypeError);
    expect(() => canonicalBytesV1(symbols)).toThrow(TypeError);
    expect(() => canonicalBytesV1(new Date(0))).toThrow(TypeError);
  });
});
