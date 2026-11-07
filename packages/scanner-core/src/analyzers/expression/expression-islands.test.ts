import { describe, expect, it } from 'vitest';
import { expressionIslands, segmentExpressionIslands, type ExpressionIslandV2 } from './expression-islands';

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value as Record<string, unknown>)) expectDeepFrozen(child, seen);
}

function spans(value: string): readonly ExpressionIslandV2[] {
  return segmentExpressionIslands(value);
}

describe('expression island segmentation', () => {
  it('returns one frozen literal for plain text and preserves UTF-16 offsets', () => {
    const result = spans('😀 plain');
    expect(result).toEqual([{ kind: 'LITERAL', start: 0, end: 8 }]);
    expect(result[0]?.start).toBe(0);
    expect(result[0]?.end).toBe('😀 plain'.length);
    expectDeepFrozen(result);
  });

  it('segments prefix, island, suffix, and inter-island literals in source order', () => {
    expect(spans('pre{{ one }}mid{{two}}post')).toEqual([
      { kind: 'LITERAL', start: 0, end: 3 },
      { kind: 'EXPRESSION', start: 3, end: 12 },
      { kind: 'LITERAL', start: 12, end: 15 },
      { kind: 'EXPRESSION', start: 15, end: 22 },
      { kind: 'LITERAL', start: 22, end: 26 },
    ]);
  });

  it('does not close on quoted delimiters and handles nested template interpolation', () => {
    const value = '{{ "}}" + `x ${call("}}")} y` }}';
    const result = spans(value);
    expect(result).toEqual([{ kind: 'EXPRESSION', start: 0, end: value.length }]);
  });
  it('ignores closing delimiters inside each supported quote form', () => {
    for (const value of ['{{ "foo }} bar" }}', "{{ 'foo }} bar' }}", '{{ `foo }} bar` }}']) {
      expect(spans(value)).toEqual([{ kind: 'EXPRESSION', start: 0, end: value.length }]);
    }
  });

  it('recovers malformed and unclosed islands without throwing', () => {
    const value = 'prefix {{ broken "unterminated';
    expect(() => spans(value)).not.toThrow();
    expect(spans(value)).toEqual([
      { kind: 'LITERAL', start: 0, end: 7 },
      { kind: 'EXPRESSION', start: 7, end: value.length },
    ]);
  });

  it('keeps unmatched closing delimiters in a literal segment', () => {
    expect(spans('value }} remains')).toEqual([{ kind: 'LITERAL', start: 0, end: 16 }]);
  });
});

describe('normalized expression islands', () => {
  const islands = (value: string, maxWork = 1000) => expressionIslands(value, maxWork);

  it('returns exact UTF-16 island/body offsets and multiple islands', () => {
    const value = '😀{{ one }}x{{two}}';
    expect(islands(value)).toEqual({
      islands: [
        { startUtf16: 2, endUtf16: 11, bodyStartUtf16: 4, bodyEndUtf16: 9 },
        { startUtf16: 12, endUtf16: 19, bodyStartUtf16: 14, bodyEndUtf16: 17 },
      ],
      status: 'COMPLETE', work: value.length,
    });
  });

  it('does not terminate inside strings, templates, comments or regex literals', () => {
    const value = '{{ "}}" + `x ${call("}}")}` + /* }} */ /}}/.test(x) }}';
    const result = islands(value);
    expect(result.status).toBe('COMPLETE');
    expect(result.islands).toHaveLength(1);
    expect(result.islands[0]?.endUtf16).toBe(value.length);
  });

  it('keeps regex braces after a line comment inside the island', () => {
    const source = '{{ // comment\n /}}/.test(x) }}';
    expect(expressionIslands(source, source.length)).toEqual({
      islands: [{
        startUtf16: 0,
        endUtf16: source.length,
        bodyStartUtf16: 2,
        bodyEndUtf16: source.length - 2,
      }],
      status: 'COMPLETE',
      work: source.length,
    });

    const division = '{{ a // c\n / b }}';
    expect(segmentExpressionIslands(division)).toEqual([
      { kind: 'EXPRESSION', start: 0, end: division.length },
    ]);

    const trailing = '{{ /ok/.test(x) }} trailing';
    const boundary = trailing.indexOf(' trailing');
    expect(segmentExpressionIslands(trailing)).toEqual([
      { kind: 'EXPRESSION', start: 0, end: boundary },
      { kind: 'LITERAL', start: boundary, end: trailing.length },
    ]);
  });

  it('reports incomplete islands as MALFORMED and exact work limits', () => {
    for (const value of ['{{ "}}', '{{ /* }}', '{{ `}}']) expect(islands(value, 100).status).toBe('MALFORMED');
    expect(islands('{{ incomplete', 100)).toMatchObject({ status: 'MALFORMED', work: 13 });
    expect(islands('{{x}}', 5)).toMatchObject({ status: 'COMPLETE', work: 5 });
    expect(islands('{{x}}', 4)).toEqual({ islands: [{ startUtf16: 0, endUtf16: 4, bodyStartUtf16: 2, bodyEndUtf16: 4 }], status: 'LIMITED', work: 4 });
  });
});
