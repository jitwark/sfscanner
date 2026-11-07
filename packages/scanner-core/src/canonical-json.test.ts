import { describe, expect, it } from 'vitest';
import { canonicalJsonBytes, canonicalizeJson } from './canonical-json';

describe('scanner-core canonical JSON', () => {
  it('produces byte-identical output for equivalent key orderings', () => {
    const first = { z: 'café', nested: { b: true, a: null }, a: 7 };
    const second = { a: 7, nested: { a: null, b: true }, z: 'café' };
    const expected = '{"a":7,"nested":{"a":null,"b":true},"z":"café"}';

    expect(canonicalizeJson(first)).toBe(expected);
    expect(canonicalizeJson(second)).toBe(expected);
    expect(Array.from(canonicalJsonBytes(first))).toEqual(
      Array.from(new TextEncoder().encode(expected)),
    );
    expect(canonicalJsonBytes(first)).toEqual(canonicalJsonBytes(second));
  });

  it('encodes primitive JSON values explicitly', () => {
    expect(canonicalizeJson({ string: 'line\n"', number: -0, decimal: 1.5, boolean: false, nil: null }))
      .toBe('{"boolean":false,"decimal":1.5,"nil":null,"number":0,"string":"line\\n\\\""}');
  });

  it('recursively orders nested objects without changing array order', () => {
    expect(canonicalizeJson({ outer: { z: 1, a: [{ y: 'second', x: 'first' }, 2, null] } }))
      .toBe('{"outer":{"a":[{"x":"first","y":"second"},2,null],"z":1}}');
  });

  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s outside the canonical JSON domain', (_label, value) => {
    expect(() => canonicalizeJson(value)).toThrow(/canonical JSON/);
  });

  it('rejects sparse arrays instead of silently dropping holes', () => {
    const sparse = [] as unknown[];
    sparse.length = 1;
    expect(() => canonicalizeJson(sparse)).toThrow(/sparse array/);
  });
});
