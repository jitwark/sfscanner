import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import {
  createSourceAstNodeId,
  createSourceMemberRef,
  encodeSourceSlot,
  encodeSourceTuple,
} from './source-identities';
import { parseSourceDocument } from './source-parser';
import type { ReadonlySourceDocumentV2, SourceValueV2 } from './source-types';

function sourceTreeEvidence(document: ReadonlySourceDocumentV2) {
  const refs: unknown[][] = [];
  const visit = (
    value: SourceValueV2,
    member?: { nameLexeme: string; name: string; occurrence: number },
  ): void => {
    const span = value.ref.span && [
      [value.ref.span.start.line, value.ref.span.start.column,
        value.ref.span.start.utf16Offset, value.ref.span.start.utf8ByteOffset],
      [value.ref.span.end.line, value.ref.span.end.column,
        value.ref.span.end.utf16Offset, value.ref.span.end.utf8ByteOffset],
    ];
    const scalar = 'lexeme' in value;
    refs.push([
      value.kind, value.ref.astNodeId, value.ref.pointer, [...value.ref.occurrencePath], span,
      member ? [member.nameLexeme, member.name, member.occurrence] : null,
      scalar ? value.lexeme : null, scalar ? value.value : null,
    ]);
    if (value.kind === 'ARRAY') value.items.forEach((item) => visit(item));
    if (value.kind === 'OBJECT') {
      value.members.forEach(({ nameLexeme, name, occurrence, value: child }) => {
        visit(child, { nameLexeme, name, occurrence });
      });
    }
  };
  visit(document.root);
  return [
    document.bom, document.rawSha256, document.utf8Bytes,
    document.duplicateCount, document.syntaxNodeCount, refs,
  ];
}

describe('source identities', () => {
  it('can freeze an owned occurrence path without copying or re-deriving its id', () => {
    const occurrencePath = [0, 1];
    const ref = createSourceMemberRef({
      pointer: '/a/0', occurrencePath, slot: { kind: 'ARRAY', index: 0 },
      kind: 'NUMBER', payload: '1', astNodeId: 'cached-id', reuseOccurrencePath: true, span: null,
    });
    expect(ref.occurrencePath).toBe(occurrencePath);
    expect(Object.isFrozen(occurrencePath)).toBe(true);
    expect(ref.astNodeId).toBe('cached-id');
  });

  it('preserves every parsed source identity, digest, and span', () => {
    const json = '{"a":[1,"x"],"\\u0061":{"b":true},"rocket":"🚀"}';
    const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, ...new TextEncoder().encode(json));
    const parsed = parseSourceDocument(bytes, DEFAULT_SCANNER_LIMITS_V2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(sourceTreeEvidence(parsed.document)).toEqual([
      'UTF8', '17b3ec0c90b7a8f56aeabc6b030c0faf2796c136a3a0248906e38f8b2173f545',
      52, 1, 18,
      [
        ['OBJECT', 'b3f1e5d301ce8aeb730ab5bcfe9b039a8197248a735ed9b7006f6aebbbf8f4fd', '', [],
          [[1, 1, 0, 0], [1, 48, 47, 49]], null, null, null],
        ['ARRAY', '9a05c5d98f01a2163aca315f5025b26d890975df2f0f9eb4cc4b83d8b7f45eda', '/a', [0],
          [[1, 6, 5, 5], [1, 13, 12, 12]], ['"a"', 'a', 0], null, null],
        ['NUMBER', '6b81993f6a8fbd1d3456cf85141546b5b51f1e499d503458b5860c5d2a726294', '/a/0', [0, 0],
          [[1, 7, 6, 6], [1, 8, 7, 7]], null, '1', 1],
        ['STRING', '199cc10c06fed31261e4a00a3259c2e2663d173d896720c65e9e88bd2aec71c7', '/a/1', [0, 1],
          [[1, 9, 8, 8], [1, 12, 11, 11]], null, '"x"', 'x'],
        ['OBJECT', 'b586f3379326f0c1698acb844435b60bf73ff350a20134b5c6f7fe79748c5106', '/a', [1],
          [[1, 23, 22, 22], [1, 33, 32, 32]], ['"\\u0061"', 'a', 1], null, null],
        ['BOOLEAN', '51ccfd03272366a0cf877a2c126622ff038cfe1d1ffca447690e43a5e16d02e1', '/a/b', [1, 0],
          [[1, 28, 27, 27], [1, 32, 31, 31]], ['"b"', 'b', 0], 'true', true],
        ['STRING', '078f22a37a6fa5c84388f14386fde9953100d2a5cdea4de2e6396389250e7364', '/rocket', [2],
          [[1, 43, 42, 42], [1, 47, 46, 48]], ['"rocket"', 'rocket', 0], '"🚀"', '🚀'],
      ],
    ]);
  });

  it('uses total, unambiguous slot encodings', () => {
    expect(encodeSourceSlot({ kind: 'ROOT' })).toBe('ROOT');
    expect(encodeSourceSlot({ kind: 'ARRAY', index: 0 })).not.toBe(encodeSourceSlot({ kind: 'ARRAY', index: 1 }));
    expect(encodeSourceSlot({ kind: 'MEMBER', nameLexeme: '"a"', occurrence: 0 }))
      .not.toBe(encodeSourceSlot({ kind: 'MEMBER', nameLexeme: '"a"', occurrence: 1 }));
    expect(encodeSourceSlot({ kind: 'MEMBER', nameLexeme: '"a"', occurrence: 0 }))
      .not.toBe(encodeSourceSlot({ kind: 'MEMBER', nameLexeme: '"b"', occurrence: 0 }));
  });

  it('length-prefixes tuple members and excludes coordinates', () => {
    expect(encodeSourceTuple(['a', 'bc'])).not.toBe(encodeSourceTuple(['ab', 'c']));
    const common = { occurrencePath: [0, 1], slot: 'MEMBER:2', kind: 'STRING' as const, payload: '"x"' };
    expect(createSourceAstNodeId(common)).toBe(createSourceAstNodeId({ ...common }));
    expect(createSourceAstNodeId(common)).not.toBe(createSourceAstNodeId({ ...common, occurrencePath: [0, 2] }));
  });

  it('freezes the source identity byte encoding with golden digests', () => {
    expect(createSourceAstNodeId({
      occurrencePath: [], slot: 'ROOT', kind: 'OBJECT', payload: '',
    })).toBe('df56e2f08cac00832e0801da31d1f604721b1e6d55ede08687fcdb51df78321d');
    expect(createSourceAstNodeId({
      occurrencePath: [0, 1],
      slot: encodeSourceSlot({ kind: 'MEMBER', nameLexeme: '"a"', occurrence: 1 }),
      kind: 'NUMBER',
      payload: '1.0',
    })).toBe('e08bf97aa1540193aae17b199e8325bc31a7b9055f050aa4ab5a96f5601184f6');
  });
});
