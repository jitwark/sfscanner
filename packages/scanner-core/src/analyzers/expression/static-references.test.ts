import { describe, expect, it } from 'vitest';
import { resolveStaticReference } from './static-references';

const ref = (expression: string, maxWork = 1000, labels?: ReadonlyMap<string, number>) => resolveStaticReference(expression, maxWork, labels);

describe('static expression references', () => {
  it('resolves current input and unique node paths exactly', () => {
    expect(ref('$json.customer.email')).toMatchObject({ kind: 'CURRENT_INPUT', path: ['customer', 'email'], item: 'CURRENT', status: 'EXACT' });
    expect(ref("$node['A'].payload.id")).toMatchObject({ kind: 'NODE', nodeLabel: 'A', path: ['payload', 'id'], status: 'EXACT' });
    expect(ref('$node.A.payload')).toMatchObject({ nodeLabel: 'A', path: ['payload'], status: 'EXACT' });
  });

  it('keeps all/first/last/item distinct', () => {
    expect(ref("$('A').all()")).toMatchObject({ item: 'ALL', status: 'BROAD', reason: 'ALL_COLLECTION' });
    expect(ref("$('A').first().x")).toMatchObject({ item: 'FIRST', path: ['x'], status: 'EXACT' });
    expect(ref("$('A').last().x")).toMatchObject({ item: 'LAST', path: ['x'], status: 'EXACT' });
    expect(ref("$('A').item.x")).toMatchObject({ item: 'CURRENT', path: ['x'], status: 'EXACT' });
    expect(ref('$input.all()')).toMatchObject({ kind: 'CURRENT_INPUT', item: 'ALL', status: 'BROAD' });
    expect(ref('$input.item.json.id')).toMatchObject({ item: 'CURRENT', path: ['json', 'id'], status: 'EXACT' });
    expect(ref('$input.item')).toMatchObject({ item: 'CURRENT', path: [], status: 'BROAD' });
  });

  it('keeps dynamic, missing and unsupported forms UNKNOWN', () => {
    expect(ref('$(name).x')).toMatchObject({ status: 'UNKNOWN', reason: 'DYNAMIC_LABEL' });
    expect(ref('$node[selector].x')).toMatchObject({ status: 'UNKNOWN', reason: 'DYNAMIC_PATH' });
    expect(ref('$json')).toMatchObject({ status: 'BROAD', reason: 'NO_PATH', path: [] });
    expect(ref('$node')).toMatchObject({ status: 'UNKNOWN', reason: 'MISSING_LABEL' });
    expect(ref("$('A').foo()")).toMatchObject({ status: 'UNKNOWN', reason: 'UNSUPPORTED_CALL', kind: 'NODE' });
    expect(ref("$('A').first(1)")).toMatchObject({ status: 'UNKNOWN', reason: 'UNSUPPORTED_CALL', kind: 'NODE' });
    expect(ref('$json..x')).toMatchObject({ status: 'UNKNOWN', reason: 'PARSE_ERROR' });
  });

  it('supports escaped labels, numeric indexes and exact work limits', () => {
    expect(ref("$node['A\\'B'].x")).toMatchObject({ nodeLabel: "A'B", path: ['x'], status: 'EXACT' });
    expect(ref('$json[0].x')).toMatchObject({ path: ['0', 'x'], status: 'EXACT' });
    expect(ref('$json.x', '$json.x'.length)).toMatchObject({ status: 'EXACT' });
    expect(ref("$('A').first().last()")).toMatchObject({ status: 'UNKNOWN', reason: 'CHAINED_SELECTOR' });
    expect(ref("$('A').first().item")).toMatchObject({ status: 'UNKNOWN', reason: 'CHAINED_SELECTOR' });
    expect(ref('$json[3].x')).toMatchObject({ path: ['3', 'x'], status: 'EXACT' });
    for (const value of ['$json.first()', '$json.a.all()', '$node.A.first()']) {
      expect(ref(value)).toMatchObject({ status: 'UNKNOWN', reason: 'UNSUPPORTED_CHAIN' });
    }
    expect(ref("$('A').first().x", 1000)).toMatchObject({ status: 'EXACT', item: 'FIRST' });
    expect(ref('$json.x', 3)).toMatchObject({ status: 'UNKNOWN', reason: 'WORK_LIMIT' });
  });

  it('resolves only unique labels when an index is supplied', () => {
    const labels = new Map([['A', 1], ['Dup', 2], ['Gone', 0]]);
    expect(ref("$('A').first().x", 1000, labels)).toMatchObject({ nodeLabel: 'A', status: 'EXACT' });
    expect(ref("$('Dup').x", 1000, labels)).toMatchObject({ status: 'UNKNOWN', reason: 'AMBIGUOUS_LABEL' });
    expect(ref("$('Gone').x", 1000, labels)).toMatchObject({ status: 'UNKNOWN', reason: 'MISSING_LABEL' });
    expect(ref("$('Absent').x", 1000, new Map())).toMatchObject({ status: 'UNKNOWN', reason: 'MISSING_LABEL' });
  });

  it('bounds parser depth and path length without throwing', () => {
    expect(ref('('.repeat(3000) + '$json' + ')'.repeat(3000), 1_000_000)).toMatchObject({ status: 'UNKNOWN', reason: 'PARSE_LIMIT' });
    expect(ref('$json' + '.a'.repeat(300), 10_000)).toMatchObject({ status: 'UNKNOWN', reason: 'PATH_TOO_LONG' });
  });

  it('never evaluates or copies code', () => {
    const value = '$json.x + (globalThis.__pwned = true)';
    const result = ref(value);
    expect(result.status).toBe('UNKNOWN');
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined();
  });
});
