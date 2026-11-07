import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS } from '@hub/contracts';
import {
  DuplicateKeyLocationLimitError,
  MAX_DUPLICATE_KEY_LOCATIONS,
  MAX_DUPLICATE_KEY_POINTER_BYTES,
  parseWorkflowSource,
} from './workflow-source-locations';
import { MAX_SOURCE_PARSER_DEPTH } from './source/source-preflight';

describe('scanner-core workflow source locations', () => {
  it('maps node spans to exact line, column, and byte offsets', () => {
    const json = [
      '{',
      '  "nodes": [',
      '    { "name": "Start", "type": "noOp" }',
      '  ],',
      '  "connections": {}',
      '}',
    ].join('\n');
    const mapped = parseWorkflowSource(json);
    const startOffset = json.indexOf('{ "name"');
    const endOffset = json.indexOf(' }', startOffset) + 2;

    expect(mapped.nodeSpans[0]).toEqual({
      start: { line: 3, column: 5, offset: startOffset },
      end: { line: 3, column: 40, offset: endOffset },
    });
  });

  it('accepts one leading BOM and maps v1 spans to the original string coordinates', () => {
    const json = '\uFEFF{"nodes":[{"name":"N","type":"noOp"}],"connections":{}}';
    const withoutBom = parseWorkflowSource(json.slice(1));
    const mapped = parseWorkflowSource(json);
    const expected = withoutBom.nodeSpans[0]!;

    expect(mapped.value).toEqual(withoutBom.value);
    expect(mapped.nodeSpans[0]).toEqual({
      start: { ...expected.start, column: expected.start.column + 1, offset: expected.start.offset + 1 },
      end: { ...expected.end, column: expected.end.column + 1, offset: expected.end.offset + 1 },
    });
    const multiline = '\uFEFF{\n  "nodes":[{"name":"N","type":"noOp"}],\n  "connections":{}}';
    const plainMultiline = parseWorkflowSource(multiline.slice(1)).nodeSpans[0]!;
    const bomMultiline = parseWorkflowSource(multiline).nodeSpans[0]!;
    expect(bomMultiline.start).toEqual({ ...plainMultiline.start, offset: plainMultiline.start.offset + 1 });
    expect(bomMultiline.end).toEqual({ ...plainMultiline.end, offset: plainMultiline.end.offset + 1 });
    expect(() => parseWorkflowSource('\uFEFF\uFEFF{}')).toThrow();
    expect(() => parseWorkflowSource('{"value":\uFEFF1}')).toThrow();
    expect(parseWorkflowSource('{"nodes":[],"connections":{},"text":"a\uFEFFb"}').value)
      .toMatchObject({ text: 'a\uFEFFb' });
  });

  it('reports duplicate keys anywhere and sorts their JSON pointers', () => {
    const mapped = parseWorkflowSource(
      '{"z":1,"z":2,"nodes":[{"name":"N","type":"noOp",'
      + '"parameters":{"a":1,"a":2}}],"connections":{}}',
    );

    expect(mapped.duplicateKeys).toEqual([
      { pointer: '/nodes/0/parameters/a', key: 'a' },
      { pointer: '/z', key: 'z' },
    ]);
  });

  it('orders duplicate-key diagnostics by stable code-unit order', () => {
    const mapped = parseWorkflowSource(
      '{"ä":1,"ä":2,"a":1,"a":2,"A":1,"A":2,"nodes":[],"connections":{}}',
    );

    expect(mapped.duplicateKeys.map((duplicate) => duplicate.pointer)).toEqual([
      '/A',
      '/a',
      '/ä',
    ]);
  });

  it.each([255, 256, 257])('finds duplicate keys at source depth %i', (depth) => {
    let json = '{"duplicate":1,"duplicate":2}';
    for (let level = 0; level < depth; level += 1) json = `[${json}]`;

    expect(parseWorkflowSource(json).duplicateKeys).toEqual([
      { pointer: `${'/0'.repeat(depth)}/duplicate`, key: 'duplicate' },
    ]);
  });

  it('finds a duplicate in a wide object at the maximum accepted source depth', () => {
    const arrayDepth = MAX_SOURCE_PARSER_DEPTH - 1;
    const members = Array.from({ length: 40_000 }, (_, index) => `"field-${index}":0`).join(',');
    const json = `${'['.repeat(arrayDepth)}{${members},"duplicate":1,"duplicate":2}${']'.repeat(arrayDepth)}`;

    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(DEFAULT_SCANNER_LIMITS.maxBytes);
    expect(parseWorkflowSource(json).duplicateKeys).toEqual([
      { pointer: `${'/0'.repeat(arrayDepth)}/duplicate`, key: 'duplicate' },
    ]);
  });

  it('emits one location for a repeated key below the maximum accepted depth', () => {
    const arrayDepth = MAX_SOURCE_PARSER_DEPTH - 2;
    const repeatedMembers = Array.from({ length: 10_000 }, (_, index) => `"duplicate":${index}`).join(',');
    const json = `${'['.repeat(arrayDepth)}{${repeatedMembers}}${']'.repeat(arrayDepth)}`;
    const pointer = `${'/0'.repeat(arrayDepth)}/duplicate`;

    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(DEFAULT_SCANNER_LIMITS.maxBytes);
    const duplicates = parseWorkflowSource(json).duplicateKeys;
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toEqual({ pointer, key: 'duplicate' });
  });

  it('deduplicates deep locations repeated beneath a duplicated ancestor', () => {
    const arrayDepth = MAX_SOURCE_PARSER_DEPTH - 12;
    const nested = `${'['.repeat(arrayDepth)}{"leaf":1,"leaf":2}${']'.repeat(arrayDepth)}`;
    const repeatedAncestors = Array.from({ length: 1_000 }, () => `"ancestor":${nested}`).join(',');
    const json = `{${repeatedAncestors}}`;

    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(DEFAULT_SCANNER_LIMITS.maxBytes);
    expect(parseWorkflowSource(json).duplicateKeys).toEqual([
      { pointer: '/ancestor', key: 'ancestor' },
      { pointer: `/ancestor${'/0'.repeat(arrayDepth)}/leaf`, key: 'leaf' },
    ]);
  });

  it('bounds aggregate pointer bytes at the inclusive limit before materializing overflow', () => {
    const arrayDepth = 254;
    const pointerBytes = arrayDepth * 2 + 1 + 3;
    expect(pointerBytes).toBe(512);
    const atLimitCount = MAX_DUPLICATE_KEY_POINTER_BYTES / pointerBytes;
    expect(Number.isInteger(atLimitCount)).toBe(true);

    const makeSource = (count: number) => {
      const members = Array.from({ length: count }, (_, index) => {
        const key = index.toString(16).padStart(3, '0');
        return `"${key}":0,"${key}":1`;
      }).join(',');
      return `${'['.repeat(arrayDepth)}{${members}}${']'.repeat(arrayDepth)}`;
    };

    const atLimit = makeSource(atLimitCount);
    const overLimit = makeSource(atLimitCount + 1);
    expect(new TextEncoder().encode(atLimit).length).toBeLessThanOrEqual(DEFAULT_SCANNER_LIMITS.maxBytes);
    expect(new TextEncoder().encode(overLimit).length).toBeLessThanOrEqual(DEFAULT_SCANNER_LIMITS.maxBytes);
    const atLimitDuplicates = parseWorkflowSource(atLimit).duplicateKeys;
    expect(atLimitDuplicates).toHaveLength(atLimitCount);
    expect(atLimitDuplicates.reduce((sum, location) => sum + new TextEncoder().encode(location.pointer).length, 0))
      .toBe(MAX_DUPLICATE_KEY_POINTER_BYTES);
    expect(() => parseWorkflowSource(overLimit)).toThrow(DuplicateKeyLocationLimitError);
  });

  it('bounds duplicate location count at its inclusive limit', () => {
    const makeSource = (count: number) => {
      const members = Array.from({ length: count }, (_, index) => {
        const key = index.toString(16).padStart(4, '0');
        return `"${key}":0,"${key}":1`;
      }).join(',');
      return `{${members}}`;
    };
    const atLimit = makeSource(MAX_DUPLICATE_KEY_LOCATIONS);
    const overLimit = makeSource(MAX_DUPLICATE_KEY_LOCATIONS + 1);

    expect(new TextEncoder().encode(atLimit).length).toBeLessThanOrEqual(DEFAULT_SCANNER_LIMITS.maxBytes);
    expect(new TextEncoder().encode(overLimit).length).toBeLessThanOrEqual(DEFAULT_SCANNER_LIMITS.maxBytes);
    expect(parseWorkflowSource(atLimit).duplicateKeys).toHaveLength(MAX_DUPLICATE_KEY_LOCATIONS);
    expect(() => parseWorkflowSource(overLimit)).toThrow(DuplicateKeyLocationLimitError);
  });

  it('uses the last duplicate nodes array for both evaluation and spans', () => {
    const json = '{"nodes":[{"name":"First","type":"noOp"}],'
      + '"nodes":[{"name":"Last","type":"noOp"}],"connections":{}}';
    const mapped = parseWorkflowSource(json);
    const nodes = mapped.value as { nodes: Array<{ name: string }> };
    const span = mapped.nodeSpans[0];

    expect(nodes.nodes[0].name).toBe('Last');
    expect(span).toBeDefined();
    expect(json.slice(span!.start.offset, span!.end.offset)).toContain('"Last"');
  });
});
