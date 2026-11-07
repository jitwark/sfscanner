import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as sourceIdentities from './source-identities';
import { parseSourceDocument } from './source-parser';
import type { ScannerLimitsV2 } from '@hub/contracts';

const encoder = new TextEncoder();

function limits(overrides: Partial<ScannerLimitsV2> = {}): ScannerLimitsV2 {
  return { ...DEFAULT_SCANNER_LIMITS_V2, ...overrides };
}

function parse(text: string, overrides: Partial<ScannerLimitsV2> = {}) {
  return parseSourceDocument(encoder.encode(text), limits(overrides));
}

function documentOf(text: string, overrides: Partial<ScannerLimitsV2> = {}) {
  const result = parse(text, overrides);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.document;
}

describe('parseSourceDocument', () => {
  it('does not derive each source identity again while building references', () => {
    const refSpy = vi.spyOn(sourceIdentities, 'createSourceMemberRef');
    try {
      documentOf('{"a":[1,{"b":2}]}');
      const repeatedDerivations = refSpy.mock.calls.filter(([input]) => !('astNodeId' in input)).length;
      expect(repeatedDerivations).toBe(0);
    } finally {
      refSpy.mockRestore();
    }
  });

  it('rejects finite-overflow JSON numbers as a closed invalid-input result', () => {
    expect(parse('1e999')).toEqual({
      ok: false, code: 'INVALID_JSON', message: 'Workflow bytes are not valid JSON.',
    });
  });

  it('applies v2 defaults to omitted and partial limits while preserving explicit zero', () => {
    const bytes = encoder.encode('{}');
    expect(parseSourceDocument(bytes).ok).toBe(true);
    expect(parseSourceDocument(bytes, { maxBytes: bytes.length }).ok).toBe(true);
    expect(parseSourceDocument(bytes, { maxBytes: 0 })).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_LARGE' });
  });

  it('rejects invalid partial limits instead of scanning with an unsafe bypass', () => {
    expect(parseSourceDocument(encoder.encode('{}'), { maxBytes: -1 })).toMatchObject({ ok: false });
    expect(parseSourceDocument(encoder.encode('{}'), { maxBytes: Number.POSITIVE_INFINITY })).toMatchObject({ ok: false });
  });

  it('rejects non-Uint8Array runtime inputs as closed invalid JSON', () => {
    expect(parseSourceDocument('{}' as never, DEFAULT_SCANNER_LIMITS_V2)).toEqual({
      ok: false, code: 'INVALID_JSON', message: 'Workflow bytes are not valid JSON.',
    });
  });

  it('rejects accessor and custom-prototype limit objects without invoking getters', () => {
    let called = false;
    const accessor = Object.defineProperty({}, 'maxBytes', {
      enumerable: true,
      get() { called = true; throw new Error('must not read'); },
    });
    expect(parseSourceDocument(encoder.encode('{}'), accessor as never)).toMatchObject({ ok: false, code: 'INVALID_JSON' });
    expect(called).toBe(false);

    const inherited = Object.create({ maxBytes: 1 });
    expect(parseSourceDocument(encoder.encode('{}'), inherited as never)).toMatchObject({ ok: false, code: 'INVALID_JSON' });
  });
  it('rejects invalid UTF-8 before JSON parsing', () => {
    const result = parseSourceDocument(Uint8Array.of(0xc3, 0x28), DEFAULT_SCANNER_LIMITS_V2);

    expect(result).toEqual({
      ok: false,
      code: 'UTF8_DECODING_FAILED',
      message: 'Workflow bytes are not valid UTF-8.',
    });
  });

  it('checks exact input bytes before decoding', () => {
    const bytes = encoder.encode('{}');
    expect(parseSourceDocument(bytes, limits({ maxBytes: bytes.length })).ok).toBe(true);
    expect(parseSourceDocument(bytes, limits({ maxBytes: bytes.length - 1 }))).toMatchObject({
      ok: false, code: 'WORKFLOW_TOO_LARGE',
    });
  });

  it('accepts a UTF-8 BOM, hashes it, and starts offsets after it', async () => {
    const plain = encoder.encode('{"name":"x"}');
    const withBom = Uint8Array.of(0xef, 0xbb, 0xbf, ...plain);
    const first = parseSourceDocument(withBom, limits());
    const second = parseSourceDocument(plain, limits());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.document.bom).toBe('UTF8');
    expect(second.document.bom).toBe('NONE');
    expect(first.document.rawSha256).not.toBe(second.document.rawSha256);
    expect(first.document.utf8Bytes).toBe(withBom.length);
    expect(first.document.rawSha256).toBe(bytesToHex(sha256(withBom)));
    expect(first.document.root.ref.span?.start).toMatchObject({ utf16Offset: 0, utf8ByteOffset: 0 });
  });

  it('accepts at most one leading UTF-8 BOM', () => {
    const json = encoder.encode('{}');
    const doubleBom = Uint8Array.of(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...json);

    expect(parseSourceDocument(doubleBom, limits())).toEqual({
      ok: false, code: 'INVALID_JSON', message: 'Workflow bytes are not valid JSON.',
    });
  });

  it.each(['', '{', '{"a":}', '[1,]', 'undefined'])('returns a closed invalid-JSON error for %j', (text) => {
    const result = parse(text);
    expect(result).toEqual({
      ok: false, code: 'INVALID_JSON', message: 'Workflow bytes are not valid JSON.',
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('preserves scalar and name lexemes, member order, and decoded duplicate occurrences', () => {
    const document = documentOf('{"a":1,"\\u0061":1.0,"flag":true,"nil":null}');
    expect(document.root.kind).toBe('OBJECT');
    if (document.root.kind !== 'OBJECT') return;
    expect(document.root.members.map((member) => [member.nameLexeme, member.name, member.occurrence]))
      .toEqual([["\"a\"", 'a', 0], ['"\\u0061"', 'a', 1], ['"flag"', 'flag', 0], ['"nil"', 'nil', 0]]);
    expect(document.root.members[0].value).toMatchObject({ kind: 'NUMBER', lexeme: '1', value: 1 });
    expect(document.root.members[1].value).toMatchObject({ kind: 'NUMBER', lexeme: '1.0', value: 1 });
    expect(document.root.members[2].value).toMatchObject({ kind: 'BOOLEAN', lexeme: 'true', value: true });
    expect(document.root.members[3].value).toMatchObject({ kind: 'NULL', lexeme: 'null', value: null });
    expect(document.duplicateCount).toBe(1);
    expect(document.root.members[0].ref.pointer).toBe('/a');
    expect(document.root.members[1].ref.pointer).toBe('/a');
    expect(document.root.members[0].ref.occurrencePath).toEqual([0]);
    expect(document.root.members[1].ref.occurrencePath).toEqual([1]);
    expect(document.root.members[0].ref.astNodeId).not.toBe(document.root.members[1].ref.astNodeId);
  });

  it('treats prototype-special names as inert ordered source data', () => {
    const document = documentOf('{"__proto__":1,"constructor":2,"prototype":3}');
    expect(document.root.kind).toBe('OBJECT');
    if (document.root.kind !== 'OBJECT') return;
    expect(document.root.members.map((member) => member.name)).toEqual([
      '__proto__', 'constructor', 'prototype',
    ]);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('uses half-open UTF-16 and UTF-8 positions for Unicode values', () => {
    const document = documentOf('{"é":"🚀"}');
    expect(document.root.kind).toBe('OBJECT');
    if (document.root.kind !== 'OBJECT') return;
    expect(document.root.members[0].ref.span).toEqual({
      start: { line: 1, column: 6, utf16Offset: 5, utf8ByteOffset: 6 },
      end: { line: 1, column: 10, utf16Offset: 9, utf8ByteOffset: 12 },
    });
  });

  it('deep-freezes source arrays, members, values, references, and spans', () => {
    const document = documentOf('{"items":[{"x":"y"}]}');
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.root)).toBe(true);
    if (document.root.kind !== 'OBJECT') return;
    const member = document.root.members[0];
    expect(Object.isFrozen(document.root.members)).toBe(true);
    expect(Object.isFrozen(member)).toBe(true);
    expect(Object.isFrozen(member.ref)).toBe(true);
    expect(Object.isFrozen(member.ref.span)).toBe(true);
    expect(Object.isFrozen(member.value)).toBe(true);
  });

  it('omits presentation spans deterministically after the inclusive budget', () => {
    const document = documentOf('[1,2]', { maxStoredSourceSpans: 1 });
    expect(document.root.ref.span).not.toBeNull();
    expect(document.root.kind).toBe('ARRAY');
    if (document.root.kind !== 'ARRAY') return;
    expect(document.root.items.map((item) => item.ref.span)).toEqual([null, null]);
    expect(documentOf('[1,2]', { maxStoredSourceSpans: 1 })).toEqual(document);
    const all = documentOf('[1]', { maxStoredSourceSpans: 2 });
    const extra = documentOf('[1]', { maxStoredSourceSpans: 3 });
    expect(all.root.kind === 'ARRAY' && all.root.items[0].ref.span).not.toBeNull();
    expect(extra).toEqual(all);
  });

  it('accounts for every span the stored-span budget examined and dropped', () => {
    expect(parse('[1,2]', { maxStoredSourceSpans: 1 })).toMatchObject({
      ok: true, sourceSpanUsage: { examined: 3, omitted: 2 },
    });
    expect(parse('[1,2]', { maxStoredSourceSpans: 3 })).toMatchObject({
      ok: true, sourceSpanUsage: { examined: 3, omitted: 0 },
    });
    expect(parse('[1,2]', { maxStoredSourceSpans: 0 })).toMatchObject({
      ok: true, sourceSpanUsage: { examined: 3, omitted: 3 },
    });
  });

  it.each([
    ['maxSyntaxNodes', '{}', 'SYNTAX_NODE_LIMIT'],
    ['maxDocumentDepth', '{}', 'DOCUMENT_DEPTH_LIMIT'],
    ['maxMembersAndElements', '{"a":1}', 'MEMBER_ELEMENT_LIMIT'],
    ['maxDuplicateKeys', '{"a":1,"a":2}', 'DUPLICATE_KEY_LIMIT'],
  ] as const)('rejects %s at max+1', (field, text, cause) => {
    expect(parse(text, { [field]: 0 })).toMatchObject({
      ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause,
    });
  });

  it('accepts exact inclusive syntax, depth, member, and duplicate limits', () => {
    const baseline = documentOf('{"a":[1],"a":2}');
    const vector = '{"a":[1],"a":2}';
    const fields = [
      ['maxSyntaxNodes', baseline.syntaxNodeCount, 'SYNTAX_NODE_LIMIT'],
      ['maxDocumentDepth', 3, 'DOCUMENT_DEPTH_LIMIT'],
      ['maxMembersAndElements', 3, 'MEMBER_ELEMENT_LIMIT'],
      ['maxDuplicateKeys', 1, 'DUPLICATE_KEY_LIMIT'],
    ] as const;
    for (const [field, maximum, cause] of fields) {
      expect(parse(vector, { [field]: maximum - 1 })).toMatchObject({
        ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause,
      });
      expect(parse(vector, { [field]: maximum }).ok).toBe(true);
      expect(parse(vector, { [field]: maximum + 1 }).ok).toBe(true);
    }
  });

  it('terminates a deeply nested source at the document-depth budget', () => {
    const text = `${'['.repeat(10_000)}0${']'.repeat(10_000)}`;
    expect(parse(text)).toMatchObject({
      ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'DOCUMENT_DEPTH_LIMIT',
    });
  });

  it('uses a deterministic parser-safety ceiling when configured depth exceeds parser safety', () => {
    const text = `${'['.repeat(10_000)}0${']'.repeat(10_000)}`;
    expect(parse(text, { maxDocumentDepth: 10_000 })).toMatchObject({
      ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'DOCUMENT_DEPTH_LIMIT',
    });
  });

  it('keeps the parser-safety ceiling inclusive', () => {
    const atCeiling = `${'['.repeat(512)}0${']'.repeat(512)}`;
    const aboveCeiling = `${'['.repeat(513)}0${']'.repeat(513)}`;
    expect(parse(atCeiling, { maxDocumentDepth: 10_000 }).ok).toBe(true);
    expect(parse(aboveCeiling, { maxDocumentDepth: 10_000 })).toMatchObject({
      ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'DOCUMENT_DEPTH_LIMIT',
    });
  });

  it('does not charge bracket characters inside escaped JSON strings as depth', () => {
    expect(parse('{"value":"[[[\\\"{{{"}', { maxDocumentDepth: 2 }).ok).toBe(true);
  });
});
