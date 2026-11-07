import { describe, expect, it } from 'vitest';
import { preflightJson, type StructuralLimits } from './json-preflight';

const limits = (overrides: Partial<StructuralLimits> = {}): StructuralLimits => ({
  maxBytes: 10_000, maxDepth: 8, maxTokens: 100, maxRawStringBytes: 10_000, maxWork: 10_000, ...overrides,
});
const bytes = (value: string) => new TextEncoder().encode(value);
const inspect = (value: string, overrides: Partial<StructuralLimits> = {}) => preflightJson(bytes(value), limits(overrides));

describe('JSON structural preflight', () => {
  it.each([
    ['null', 1, 0], ['[]', 2, 1], ['{}', 2, 1], ['{"a":1}', 5, 1], ['[1,2]', 5, 1],
    ['{"a":[true,null]}', 9, 2], ['{"s":"{},type"}', 5, 1],
  ])('counts %s as %i tokens at depth %i', (source, tokens, depth) => {
    expect(inspect(source)).toMatchObject({ ok: true, tokens, maxDepthSeen: depth });
  });

  it('accepts exact token and depth maxima and rejects the next unit', () => {
    expect(inspect('{"a":1}', { maxTokens: 5, maxDepth: 1 }).ok).toBe(true);
    expect(inspect('{"a":1}', { maxTokens: 4 })).toMatchObject({ ok: false, reason: 'TOKENS' });
    expect(inspect('{"a":{}}', { maxDepth: 1 })).toMatchObject({ ok: false, reason: 'DEPTH' });
  });

  it('rejects malformed, unterminated, mismatched and invalid UTF-8 input', () => {
    for (const source of ['', '{', '{"a":', '{"a":1]', '{"a":"unterminated', 'truex', '"\\q"', '{"a":"\\u12zz"}']) {
      expect(inspect(source)).toMatchObject({ ok: false, reason: 'MALFORMED' });
    }
    expect(preflightJson(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]), limits())).toMatchObject({ ok: false, reason: 'MALFORMED' });
  });

  it('ignores structural bytes and escapes inside strings but bounds raw string bytes', () => {
    expect(inspect('{"s":"\\"}}}{{[],"}\n')).toMatchObject({ ok: true, tokens: 5 });
    expect(inspect('{"s":"12345"}', { maxRawStringBytes: 6 })).toMatchObject({ ok: false, reason: 'STRING' });
  });

  it('charges work for trailing malformed input and honors byte/work bounds', () => {
    expect(inspect('null', { maxWork: 4 })).toMatchObject({ ok: true, work: 4 });
    expect(inspect('false', { maxWork: 5 })).toMatchObject({ ok: true, work: 5 });
    expect(inspect('null', { maxWork: 3 })).toMatchObject({ ok: false, reason: 'WORK' });
    expect(inspect('null trailing')).toMatchObject({ ok: false, reason: 'MALFORMED' });
    expect(inspect('null', { maxWork: 2 })).toMatchObject({ ok: false, reason: 'WORK' });
    expect(inspect('null', { maxBytes: 3 })).toMatchObject({ ok: false, reason: 'BYTES' });
  });

  it('charges escape bytes and handles an enormous scalar without spreading it', () => {
    const unicode = '{"s":"\\u0041"}';
    const escaped = '{"s":"\\""}';
    expect(inspect(unicode)).toMatchObject({ ok: true, work: unicode.length });
    expect(inspect(escaped)).toMatchObject({ ok: true, work: escaped.length });
    const huge = `{"n":${'1'.repeat(200_000)}}`;
    expect(() => inspect(huge)).not.toThrow();
    expect(inspect(huge, { maxBytes: 300_000, maxWork: 300_000 })).toMatchObject({ ok: true, tokens: 5 });
  });

  it('accepts a leading UTF-8 BOM without charging a token', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('null')]);
    expect(preflightJson(withBom, limits())).toMatchObject({ ok: true, tokens: 1 });
  });
});
