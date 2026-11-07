import { describe, expect, it } from 'vitest';
import { createEdgeIdentityDigest, createNodeRef } from './node-edge-identity';

const source = {
  pointer: '/nodes/0',
  occurrencePath: [0],
  astNodeId: 'a'.repeat(64),
  span: null,
} as const;

describe('workflow-v2 identities', () => {
  it('uses source ordinal and ast identity, not labels, for node refs', () => {
    const first = createNodeRef({ ordinal: 0, source, explicitId: 'same', name: 'same' });
    const second = createNodeRef({ ordinal: 1, source, explicitId: 'same', name: 'same' });
    expect(first.identityDigest).not.toBe(second.identityDigest);
    expect(first.explicitId).toBe('same');
    expect(first.name).toBe('same');
  });

  it('changes edge identity for ports and resolution while excluding coordinates', () => {
    const node = createNodeRef({ ordinal: 0, source });
    const target = createNodeRef({ ordinal: 1, source: { ...source, pointer: '/nodes/1', occurrencePath: [1] } });
    const base = { ordinal: 0, sourceNode: node, targetNode: target, sourceLabel: 'A', targetLabel: 'B', connectionType: 'main', sourcePort: 0, targetPort: 0, source, resolution: 'RESOLVED' as const };
    const changed = { ...base, targetPort: 1 };
    const relocated = { ...base, source: { ...source, span: { start: { line: 99, column: 99, utf16Offset: 99, utf8ByteOffset: 99 }, end: { line: 99, column: 100, utf16Offset: 100, utf8ByteOffset: 100 } } } };
    expect(createEdgeIdentityDigest(base)).not.toBe(createEdgeIdentityDigest(changed));
    expect(createEdgeIdentityDigest(base)).toBe(createEdgeIdentityDigest(relocated));
  });

  it('includes source and target labels when resolving edge identity', () => {
    const node = createNodeRef({ ordinal: 0, source });
    const target = createNodeRef({ ordinal: 1, source: { ...source, pointer: '/nodes/1', occurrencePath: [1] } });
    const edge = { ordinal: 0, sourceNode: node, targetNode: target, sourceLabel: 'A', targetLabel: 'B', connectionType: 'main', sourcePort: 0, targetPort: 0, source, resolution: 'RESOLVED' as const };
    expect(createEdgeIdentityDigest(edge)).not.toBe(createEdgeIdentityDigest({ ...edge, sourceLabel: 'Other' }));
    expect(createEdgeIdentityDigest({ ...edge, sourceNode: undefined, resolution: 'UNRESOLVED' })).not.toBe(createEdgeIdentityDigest(edge));
  });

  it('distinguishes lone UTF-16 surrogates in length-prefixed identity tuples', () => {
    const first = createNodeRef({ ordinal: 0, source: { ...source, astNodeId: '\ud800' } });
    const second = createNodeRef({ ordinal: 0, source: { ...source, astNodeId: '\ud801' } });
    expect(first.identityDigest).not.toBe(second.identityDigest);
  });
});
