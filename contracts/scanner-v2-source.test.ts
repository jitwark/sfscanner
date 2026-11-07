import { describe, expect, it } from 'vitest';
import type {
  EdgeRefV2,
  NodeRefV2,
  ReadonlySourceDocumentV2,
  SourceMemberRefV2,
  SubjectV2,
} from './scanner-v2-source';

describe('scanner v2 source contract', () => {
  it('exposes closed source and subject shapes', () => {
    const source: SourceMemberRefV2 = {
      pointer: '', occurrencePath: [], astNodeId: 'a'.repeat(64), span: null,
    };
    const node: NodeRefV2 = { ordinal: 0, source, identityDigest: 'b'.repeat(64) };
    const edge: EdgeRefV2 = {
      ordinal: 0, sourceLabel: 'A', connectionType: 'main', sourcePort: 0,
      targetPort: 0, source, resolution: 'UNRESOLVED',
    };
    const subjects: SubjectV2[] = [
      { kind: 'WORKFLOW' }, { kind: 'NODE', node }, { kind: 'EDGE', edge }, { kind: 'SOURCE', source },
    ];
    expect(subjects).toHaveLength(4);
  });

  it('keeps source document values lossless and ordered', () => {
    const source: SourceMemberRefV2 = {
      pointer: '', occurrencePath: [], astNodeId: 'a'.repeat(64), span: null,
    };
    const document: ReadonlySourceDocumentV2 = {
      rawSha256: 'c'.repeat(64), utf8Bytes: 2, bom: 'NONE',
      root: { kind: 'OBJECT', ref: source, members: [] }, duplicateCount: 0, syntaxNodeCount: 1,
    };
    expect(document.root.kind).toBe('OBJECT');
    expect(document.root.members).toEqual([]);
  });
});
