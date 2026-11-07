import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  decodeJsonPointer,
  structuralEqual,
  validatePatch,
  type JsonValue,
} from './json-patch';

function doc(text: string): JsonValue {
  return JSON.parse(text) as JsonValue;
}

describe('decodeJsonPointer', () => {
  it('decodes the empty pointer and escaped segments in RFC 6901 order', () => {
    expect(decodeJsonPointer('')).toEqual([]);
    expect(decodeJsonPointer('/a~1b/~0c')).toEqual(['a/b', '~c']);
    expect(decodeJsonPointer('/~01')).toEqual(['~1']);
  });

  it('rejects pointers that are not RFC 6901', () => {
    expect(decodeJsonPointer('a/b')).toBeUndefined();
    expect(decodeJsonPointer('/a~2')).toBeUndefined();
    expect(decodeJsonPointer('/a~')).toBeUndefined();
  });
});

describe('applyPatch root operations', () => {
  it('adds and replaces the whole document at the root pointer', () => {
    expect(applyPatch(doc('1'), [{ op: 'add', path: '', value: { a: 1 } }]))
      .toEqual({ ok: true, value: { a: 1 } });
    expect(applyPatch(doc('{"a":1}'), [{ op: 'replace', path: '', value: [2] }]))
      .toEqual({ ok: true, value: [2] });
  });

  it('refuses root removal because no document would remain', () => {
    expect(applyPatch(doc('{"a":1}'), [{ op: 'remove', path: '' }]))
      .toMatchObject({ ok: false, code: 'MALFORMED_PATCH', path: '' });
  });
});

describe('applyPatch object operations', () => {
  it('adds new members, replaces existing members and removes members', () => {
    const start = doc('{"a":{"b":1}}');
    expect(applyPatch(start, [{ op: 'add', path: '/a/c', value: 2 }]))
      .toEqual({ ok: true, value: { a: { b: 1, c: 2 } } });
    expect(applyPatch(start, [{ op: 'add', path: '/a/b', value: 2 }]))
      .toEqual({ ok: true, value: { a: { b: 2 } } });
    expect(applyPatch(start, [{ op: 'replace', path: '/a/b', value: 3 }]))
      .toEqual({ ok: true, value: { a: { b: 3 } } });
    expect(applyPatch(start, [{ op: 'remove', path: '/a/b' }]))
      .toEqual({ ok: true, value: { a: {} } });
  });

  it('refuses remove and replace of absent members and addition below a scalar', () => {
    expect(applyPatch(doc('{}'), [{ op: 'remove', path: '/x' }]))
      .toMatchObject({ ok: false, code: 'MALFORMED_PATCH' });
    expect(applyPatch(doc('{}'), [{ op: 'replace', path: '/x', value: 1 }]))
      .toMatchObject({ ok: false, code: 'MALFORMED_PATCH' });
    expect(applyPatch(doc('{"a":1}'), [{ op: 'add', path: '/a/b', value: 1 }]))
      .toMatchObject({ ok: false, code: 'MALFORMED_PATCH' });
  });

  it('supports escaped slash and tilde member names', () => {
    const start = doc('{"a/b":{"~":1}}');
    expect(applyPatch(start, [{ op: 'add', path: '/a~1b/~0', value: 2 }]))
      .toEqual({ ok: true, value: { 'a/b': { '~': 2 } } });
    expect(applyPatch(start, [{ op: 'remove', path: '/a~1b/~0' }]))
      .toEqual({ ok: true, value: { 'a/b': {} } });
    expect(applyPatch(start, [{ op: 'add', path: '/a~1b/x~2y', value: 1 }]))
      .toMatchObject({ ok: false, code: 'MALFORMED_PATCH', path: '/a~1b/x~2y' });
  });

  it('does not mutate the input document', () => {
    const start = doc('{"a":{"b":1}}');
    expect(applyPatch(start, [{ op: 'add', path: '/a/c', value: 2 }]).ok).toBe(true);
    expect(start).toEqual({ a: { b: 1 } });
  });
});

describe('applyPatch array operations', () => {
  it('inserts at the start, the middle, the length and the append token', () => {
    expect(applyPatch(doc('[1,2,3]'), [{ op: 'add', path: '/0', value: 0 }]))
      .toEqual({ ok: true, value: [0, 1, 2, 3] });
    expect(applyPatch(doc('[1,2,3]'), [{ op: 'add', path: '/1', value: 9 }]))
      .toEqual({ ok: true, value: [1, 9, 2, 3] });
    expect(applyPatch(doc('[1,2,3]'), [{ op: 'add', path: '/3', value: 4 }]))
      .toEqual({ ok: true, value: [1, 2, 3, 4] });
    expect(applyPatch(doc('[1,2,3]'), [{ op: 'add', path: '/-', value: 4 }]))
      .toEqual({ ok: true, value: [1, 2, 3, 4] });
  });

  it('removes and replaces indexes below the length only', () => {
    expect(applyPatch(doc('[1,2,3]'), [{ op: 'remove', path: '/1' }]))
      .toEqual({ ok: true, value: [1, 3] });
    expect(applyPatch(doc('[1,2,3]'), [{ op: 'replace', path: '/2', value: 9 }]))
      .toEqual({ ok: true, value: [1, 2, 9] });
    expect(applyPatch(doc('[1,2,3]'), [{ op: 'remove', path: '/-' }]))
      .toMatchObject({ ok: false, code: 'MALFORMED_PATCH' });
    expect(applyPatch(doc('[1,2,3]'), [{ op: 'replace', path: '/3', value: 9 }]))
      .toMatchObject({ ok: false, code: 'MALFORMED_PATCH' });
  });

  it('requires canonical array indexes without leading zeros', () => {
    expect(applyPatch(doc('[1,2,3]'), [{ op: 'add', path: '/4', value: 9 }]))
      .toMatchObject({ ok: false, code: 'MALFORMED_PATCH' });
    expect(applyPatch(doc('[1,2,3]'), [{ op: 'add', path: '/01', value: 9 }]))
      .toMatchObject({ ok: false, code: 'MALFORMED_PATCH' });
    expect(applyPatch(doc('[1,2,3]'), [{ op: 'remove', path: '/-1' }]))
      .toMatchObject({ ok: false, code: 'MALFORMED_PATCH' });
  });
});

describe('applyPatch test operations', () => {
  it('ignores object key order but keeps array order', () => {
    const start = doc('{"a":{"b":1,"c":2},"list":[1,2]}');
    expect(applyPatch(start, [{ op: 'test', path: '/a', value: { c: 2, b: 1 } }]))
      .toEqual({ ok: true, value: { a: { b: 1, c: 2 }, list: [1, 2] } });
    expect(applyPatch(start, [{ op: 'test', path: '/list', value: [2, 1] }]))
      .toMatchObject({ ok: false, code: 'CONFLICTING_PATCH', path: '/list' });
    expect(applyPatch(start, [{ op: 'test', path: '/missing', value: null }]))
      .toMatchObject({ ok: false, code: 'CONFLICTING_PATCH', path: '/missing' });
  });
});

describe('applyPatch prototype safety', () => {
  it('writes __proto__ as own data without touching Object.prototype', () => {
    const result = applyPatch(doc('{}'), [{ op: 'add', path: '/__proto__', value: { polluted: true } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as Readonly<Record<string, JsonValue>>;
    expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(value['__proto__']).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('replaces an own __proto__ data member without changing the prototype', () => {
    const start = doc('{"__proto__":{"a":1}}');
    const result = applyPatch(start, [{ op: 'replace', path: '/__proto__', value: { a: 2 } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as Readonly<Record<string, JsonValue>>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(value['__proto__']).toEqual({ a: 2 });
  });
});

describe('validatePatch', () => {
  it('accepts only test, add, remove and replace', () => {
    expect(validatePatch([{ op: 'add', path: '/a', value: 1 }])).toMatchObject({ ok: true });
    expect(validatePatch([{ op: 'copy', path: '/a', from: '/b' }]))
      .toMatchObject({ ok: false, code: 'UNSUPPORTED_OPERATION' });
    expect(validatePatch([{ op: 'move', path: '/a' }]))
      .toMatchObject({ ok: false, code: 'UNSUPPORTED_OPERATION' });
    expect(validatePatch([{ op: 'frobnicate', path: '/a' }]))
      .toMatchObject({ ok: false, code: 'UNSUPPORTED_OPERATION' });
  });

  it('refuses non-arrays, non-JSON values and unknown members', () => {
    expect(validatePatch('nope')).toMatchObject({ ok: false, code: 'MALFORMED_PATCH' });
    expect(validatePatch([{ op: 'add', path: '/a', value: undefined }]))
      .toMatchObject({ ok: false, code: 'MALFORMED_PATCH' });
    expect(validatePatch([{ op: 'add', path: '/a', value: 1, from: '/b' }]))
      .toMatchObject({ ok: false, code: 'MALFORMED_PATCH' });
  });

  it('refuses duplicate and ancestor/descendant write paths but allows test overlap', () => {
    expect(validatePatch([{ op: 'add', path: '/a', value: 1 }, { op: 'add', path: '/a', value: 2 }]))
      .toMatchObject({ ok: false, code: 'CONFLICTING_PATCH' });
    expect(validatePatch([{ op: 'remove', path: '/a' }, { op: 'replace', path: '/a/b', value: 2 }]))
      .toMatchObject({ ok: false, code: 'CONFLICTING_PATCH' });
    expect(validatePatch([{ op: 'test', path: '/a', value: 1 }, { op: 'add', path: '/a', value: 2 }]))
      .toMatchObject({ ok: true });
  });
});

describe('structuralEqual', () => {
  it('compares objects by members and arrays by order', () => {
    expect(structuralEqual(doc('{"a":1,"b":{"c":2}}'), doc('{"b":{"c":2},"a":1}'))).toBe(true);
    expect(structuralEqual(doc('[1,2]'), doc('[2,1]'))).toBe(false);
    expect(structuralEqual(doc('"a"'), doc('"a"'))).toBe(true);
    expect(structuralEqual(doc('1'), doc('"1"'))).toBe(false);
  });
});
