import { describe, expect, it } from 'vitest';
import {
  MAX_EXPRESSION_SEGMENT_BYTES,
  MAX_EXPRESSION_SEGMENTS,
  readParameterExpressions,
} from './taint-expressions';

const read = (value: string) => readParameterExpressions(value);
const firstReference = (value: string) => read(value).references[0];

describe('readParameterExpressions', () => {
  it('finds no reference in a literal parameter value', () => {
    expect(read('SELECT * FROM users').references).toEqual([]);
    expect(read('SELECT * FROM users').diagnostics).toEqual([]);
  });

  it('reads the current-item root and its property path', () => {
    expect(firstReference('={{ $json.body.id }}')).toEqual({
      root: 'CURRENT_ITEM', propertyPath: 'body.id', wrapperCallees: [], pathComplete: true,
    });
  });

  it('folds a split property name so it cannot evade detection', () => {
    expect(firstReference('={{ $json["bo" + "dy"] }}')).toEqual({
      root: 'CURRENT_ITEM', propertyPath: 'body', wrapperCallees: [], pathComplete: true,
    });
  });

  it('reads a statically named node reference in both call and index form', () => {
    expect(firstReference('={{ $(\'Webhook\').item.json.id }}')).toMatchObject({
      root: 'NAMED_NODE', nodeName: 'Webhook', propertyPath: 'json.id',
    });
    expect(firstReference('={{ $node["Webhook"].json.id }}')).toMatchObject({
      root: 'NAMED_NODE', nodeName: 'Webhook', propertyPath: 'json.id',
    });
  });

  it('marks a node reference it cannot resolve to a literal name as dynamic', () => {
    expect(firstReference('={{ $($json.which).json.id }}')).toMatchObject({ root: 'DYNAMIC_NODE' });
  });

  it('ignores roots that carry no workflow data', () => {
    expect(read('={{ $env.HOME }}{{ $vars.region }}{{ $workflow.id }}').references).toEqual([]);
  });

  it('reports an incomplete property path rather than guessing', () => {
    const reference = firstReference('={{ $json[$json.key].value }}');

    expect(reference).toMatchObject({ root: 'CURRENT_ITEM', pathComplete: false });
  });

  it('reads references inside a computed key too', () => {
    expect(read('={{ $json[$node["Webhook"].json.key] }}').references)
      .toContainEqual(expect.objectContaining({ root: 'NAMED_NODE', nodeName: 'Webhook' }));
  });

  it('reads every segment of a multi-segment parameter', () => {
    expect(read('=https://host/{{ $json.a }}/{{ $json.b }}').references.map((r) => r.propertyPath))
      .toEqual(['a', 'b']);
  });

  it('works without the leading equals sign', () => {
    expect(read('{{ $json.a }}').references).toHaveLength(1);
  });
});

describe('wrapper chains', () => {
  it('is empty for a bare reference', () => {
    expect(firstReference('={{ $json.a }}').wrapperCallees).toEqual([]);
  });

  it('records callees outermost first', () => {
    expect(firstReference('={{ decodeURIComponent(encodeURIComponent($json.a)) }}').wrapperCallees)
      .toEqual(['decodeURIComponent', 'encodeURIComponent']);
  });

  it('dots a member callee', () => {
    expect(firstReference('={{ JSON.stringify($json.a) }}').wrapperCallees).toEqual(['JSON.stringify']);
  });

  it('does not treat a method called on the result as the outermost wrapper', () => {
    expect(firstReference('={{ encodeURIComponent($json.a).trim() }}').wrapperCallees)
      .toEqual(['encodeURIComponent']);
  });

  it('records only the wrapper the reference is an argument of', () => {
    expect(firstReference('={{ "prefix" + encodeURIComponent($json.a) }}').wrapperCallees)
      .toEqual(['encodeURIComponent']);
  });
});

describe('expression budgets', () => {
  it('diagnoses an unparseable segment without echoing its source', () => {
    const result = read('={{ $json.( }}');

    expect(result.diagnostics).toEqual(['EXPRESSION_PARSE_FAILED']);
    expect(JSON.stringify(result)).not.toContain('$json.(');
  });

  it('diagnoses an oversized segment instead of reading it', () => {
    const result = read(`={{ $json.a + "${'x'.repeat(MAX_EXPRESSION_SEGMENT_BYTES)}" }}`);

    expect(result.diagnostics).toEqual(['ANALYSIS_LIMIT_EXCEEDED']);
    expect(result.references).toEqual([]);
  });

  it('diagnoses more segments than the budget allows', () => {
    const result = read('{{ $json.a }}'.repeat(MAX_EXPRESSION_SEGMENTS + 1));

    expect(result.diagnostics).toContain('ANALYSIS_LIMIT_EXCEEDED');
    expect(result.references).toHaveLength(MAX_EXPRESSION_SEGMENTS);
  });

  it('ignores an unterminated segment', () => {
    expect(read('={{ $json.a').references).toEqual([]);
  });
});

describe('malformed island recovery', () => {
  it('keeps earlier complete islands when a later island is unterminated', () => {
    const reading = readParameterExpressions('{{ $json.a }} {{ broken');
    expect(reading.references.length).toBeGreaterThan(0);
  });
});

describe('static selector migration', () => {
  it('uses the shared resolver for single-chain selector references', () => {
    const all = readParameterExpressions("{{ $('A').all() }}");
    expect(all.references[0]).toMatchObject({ root: 'NAMED_NODE', nodeName: 'A', pathComplete: false, item: 'ALL' });
    const item = readParameterExpressions("{{ $('A').item.json.id }}");
    expect(item.references[0]).toMatchObject({ propertyPath: 'json.id', pathComplete: true });
    const dup = readParameterExpressions("{{ $('Dup').x }}", new Map([['Dup', 2]]));
    expect(dup.references[0]).toMatchObject({ root: 'DYNAMIC_NODE', pathComplete: false });
    const missing = readParameterExpressions("{{ $('Gone').x }}", new Map([['Gone', 0]]));
    expect(missing.references[0]).toMatchObject({ root: 'DYNAMIC_NODE', pathComplete: false });
    expect(readParameterExpressions('{{ $json }}').references[0]?.pathComplete).toBe(true);
    expect(readParameterExpressions("{{ $('A') }}").references[0]?.pathComplete).toBe(true);
    expect(readParameterExpressions('{{ $json.a.toUpperCase() }}').references).toHaveLength(0);
    expect(readParameterExpressions('{{ $json.a.toUpperCase().x }}').references).toHaveLength(0);
    const mixed = readParameterExpressions('{{ $json.a.toUpperCase() + $json.b }}');
    expect(mixed.references.map(({ propertyPath }) => propertyPath)).toEqual(['b']);
    expect(readParameterExpressions("{{ !$json.a.includes('x') }}").references).toHaveLength(0);
    expect(readParameterExpressions("{{ $('A').first(1) + 1 }}").references).toHaveLength(0);
    const computed = readParameterExpressions("{{ $json.a['toUpperCase']() + $json.b }}");
    expect(computed.references.map(({ propertyPath }) => propertyPath)).toEqual(['b']);
    expect(readParameterExpressions("{{ $('A').first(1) }}").references).toHaveLength(0);
    expect(readParameterExpressions('{{ $json' + '.a'.repeat(300) + ' }}').references).toHaveLength(0);
  });
});
