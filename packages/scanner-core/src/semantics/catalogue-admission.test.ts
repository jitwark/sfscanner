import { describe, expect, it } from 'vitest';
import { admitSemanticCatalogue, createSemanticCatalogueDigest, SemanticCatalogueAdmissionError } from './catalogue-admission';
import { resolveNodeSemantics } from './catalogue-resolver';
import type { SemanticCatalogueV2 } from './catalogue-schema';

const range = (clauses: unknown): unknown => ({ clauses });
const cmp = (op: string, version: string): unknown => ({ op, version });
const provenance = { sourceUrl: 'https://example.com/source', sourceDigest: 'a'.repeat(64), reviewedAt: '2026-09-08', reviewer: 'reviewer' };
const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  semanticId: 'http-default', nodeType: 'n8n-nodes-base.httpRequest', versionRange: range([]), operation: null,
  entry: 'NONE', parameterPaths: [{ pointer: '/url', valueType: 'STRING', required: true }], authentication: null,
  credentialPaths: ['/credentials'], destinationPaths: ['/url'], effects: ['READ_EXTERNAL'], endpoints: [{ path: '/url', channel: 'DATA', direction: 'SINK', taint: 'CONFIDENTIALITY' }],
  ports: [{ type: 'main', index: 0, itemMode: 'EACH' }], overwritePaths: [], errorMode: 'STOP', retryMode: 'NONE', disabledMode: 'SKIP', provenance, ...overrides,
});
const catalogue = (records: readonly unknown[] = [record()], overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ schemaVersion: 'scanner-semantics-v2', id: 'test-catalogue', version: '2.0.0', records, configurationKeys: ['allowNetwork'], digest: '', ...overrides });

function admitted(input = catalogue()): SemanticCatalogueV2 { const value = input as Record<string, unknown>; delete value.digest; const body = value as Omit<SemanticCatalogueV2, 'digest'>; return admitSemanticCatalogue({ ...value, digest: createSemanticCatalogueDigest(body) }); }

describe('semantic catalogue admission', () => {
  it('admits a closed catalogue, canonicalizes lists, recomputes the digest, and freezes output', () => {
    const result = admitted(catalogue([record({ semanticId: 'z', nodeType: 'n8n-nodes-base.z' }), record({ semanticId: 'a', nodeType: 'n8n-nodes-base.a' })], { configurationKeys: ['z', 'a'] }));
    expect(result.records.map(({ semanticId }) => semanticId)).toEqual(['a', 'z']);
    expect(result.configurationKeys).toEqual(['a', 'z']);
    const { digest: _digest, ...body } = result;
    expect(result.digest).toBe(createSemanticCatalogueDigest(body));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.records[0].provenance)).toBe(true);
  });
  it('rejects tampered digests before returning a catalogue', () => {
    const input = catalogue();
    delete input.digest;
    const digest = createSemanticCatalogueDigest(input as Omit<SemanticCatalogueV2, 'digest'>);
    const tampered = `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`;
    expect(() => admitSemanticCatalogue({ ...input, digest: tampered })).toThrow(/DIGEST_MISMATCH/);
  });

  it('rejects duplicate semantic IDs', () => {
    expect(() => admitSemanticCatalogue(catalogue([
      record({ semanticId: 'duplicate' }),
      record({ semanticId: 'duplicate', nodeType: 'n8n-nodes-base.other' }),
    ]))).toThrow(/DUPLICATE_ID/);
  });

  it('rejects partially overlapping non-subset ranges at admission', () => {
    expect(() => admitSemanticCatalogue(catalogue([
      record({ semanticId: 'first', versionRange: range([[cmp('GTE', '1.0.0'), cmp('LT', '3.0.0')]]) }),
      record({ semanticId: 'second', versionRange: range([[cmp('GTE', '2.0.0'), cmp('LT', '4.0.0')]]) }),
    ]))).toThrow(/SEMANTIC_CATALOGUE_AMBIGUOUS/);
  });

  it('rejects malformed provenance review dates', () => {
    expect(() => admitSemanticCatalogue(catalogue([
      record({ provenance: { ...provenance, reviewedAt: '2026-02-30' } }),
    ]))).toThrow(/INVALID_PROVENANCE/);
  });
  it('rejects malformed provenance digests', () => {
    expect(() => admitSemanticCatalogue(catalogue([
      record({ provenance: { ...provenance, sourceDigest: 'g'.repeat(64) } }),
    ]))).toThrow(/INVALID_PROVENANCE/);
  });


  it('rejects unknown enums, fields, duplicate keys, and rule severity/scoring fields', () => {
    expect(() => admitted(catalogue([record({ effects: ['UNKNOWN'] })]))).toThrow(SemanticCatalogueAdmissionError);
    expect(() => admitted(catalogue([record({ unexpected: true })]))).toThrow(SemanticCatalogueAdmissionError);
    expect(() => admitted(catalogue([], { configurationKeys: ['x', 'x'] }))).toThrow(/DUPLICATE_CONFIGURATION_KEY/);
    expect(() => admitted(catalogue([record({ severity: 'HIGH' })]))).toThrow(/UNKNOWN_KEY/);
  });

  it('rejects remote provenance and unsafe descriptors, proxies, and sparse arrays', () => {
    expect(() => admitted(catalogue([record({ provenance: { ...provenance, sourceUrl: 'http://example.com/source' } })]))).toThrow(/INVALID_PROVENANCE/);
    const accessor = record(); Object.defineProperty(accessor, 'operation', { get: () => null });
    expect(() => admitted(catalogue([accessor]))).toThrow(/UNSAFE_INPUT/);
    const sparse = [record()] as unknown[]; delete sparse[0];
    expect(() => admitSemanticCatalogue(catalogue(sparse))).toThrow(/UNSAFE_INPUT/);
    const proxy = new Proxy(record(), { ownKeys: () => { throw new Error('trap'); } });
    expect(() => admitSemanticCatalogue(catalogue([proxy]))).toThrow(/UNSAFE_INPUT/);
    const cyclic = record(); cyclic.provenance = cyclic;
    expect(() => admitSemanticCatalogue(catalogue([cyclic]))).toThrow(/UNSAFE_INPUT/);
  });
  it('resolves exact operation over a node default', () => {
    const admittedCatalogue = admitted(catalogue([
      record({ semanticId: 'node-default', operation: null }),
      record({ semanticId: 'operation', operation: 'request' }),
    ]));
    const result = resolveNodeSemantics(admittedCatalogue, {
      nodeType: 'n8n-nodes-base.httpRequest',
      version: '1.0.0',
      operation: 'request',
    });
    expect(result?.semanticId).toBe('operation');
  });

  it('returns no nearest-version fallback for an unmatched version', () => {
    const result = resolveNodeSemantics(admitted(catalogue([
      record({ versionRange: range([[cmp('EQ', '1.0.0')]]) }),
    ])), {
      nodeType: 'n8n-nodes-base.httpRequest',
      version: '2.0.0',
    });
    expect(result).toBeNull();
  });

  it('accepts prerelease strict subsets hidden between comparator boundaries', () => {
    const admittedCatalogue = admitted(catalogue([
      record({ semanticId: 'broad', versionRange: range([[cmp('LT', '1.0.0-alpha.2')]]) }),
      record({ semanticId: 'narrow', versionRange: range([[cmp('LTE', '1.0.0-alpha')]]) }),
    ]));
    expect(resolveNodeSemantics(admittedCatalogue, {
      nodeType: 'n8n-nodes-base.httpRequest',
      version: '1.0.0-alpha',
    })?.semanticId).toBe('narrow');
  });
  it('rejects authentication values present in both states', () => {
    expect(() => admitted(catalogue([record({
      authentication: {
        path: '/authentication',
        noneValues: ['basic'],
        authenticatedValues: ['basic'],
        unknownValueEffect: 'EXPOSED',
      },
    })]))).toThrow(/INVALID_AUTHENTICATION/);
  });
  it('produces identical admitted bytes and digests for source permutations', () => {
    const first = admitted(catalogue([
      record({ semanticId: 'z', nodeType: 'n8n-nodes-base.z', effects: ['WRITE_EXTERNAL', 'READ_EXTERNAL'], destinationPaths: ['/z', '/a'] }),
      record({ semanticId: 'a' }),
    ], { configurationKeys: ['z', 'a'] }));
    const second = admitted(catalogue([
      record({ semanticId: 'a' }),
      record({ semanticId: 'z', nodeType: 'n8n-nodes-base.z', effects: ['READ_EXTERNAL', 'WRITE_EXTERNAL'], destinationPaths: ['/a', '/z'] }),
    ], { configurationKeys: ['a', 'z'] }));
    expect(first).toEqual(second);
    expect(first.digest).toBe(second.digest);
  });

  it('rejects a trailing lone high surrogate at the end of provenance reviewer', () => {
    const attempt = () => admitted(catalogue([record({ provenance: { ...provenance, reviewer: 'reviewer\ud800' } })]));
    expect(attempt).toThrow(SemanticCatalogueAdmissionError);
    expect(attempt).toThrow(/INVALID_TEXT/);
  });

  it('keeps lone low surrogates rejected and astral, ASCII, private-use, and noncharacter text accepted', () => {
    const reviewer = (value: string): string => admitted(catalogue([record({ provenance: { ...provenance, reviewer: value } })])).records[0].provenance.reviewer;
    expect(() => reviewer('reviewer\udc00')).toThrow(SemanticCatalogueAdmissionError);
    expect(() => reviewer('reviewer\udc00')).toThrow(/INVALID_TEXT/);
    for (const value of ['reviewer\u{1F600}', 'reviewer ascii', 'reviewer\ue000', 'reviewer\uffff']) expect(reviewer(value)).toBe(value);
  });

  it('copies nested inputs and deeply freezes every admitted collection', () => {
    const source = record({ effects: ['READ_EXTERNAL'] });
    const result = admitted(catalogue([source]));
    (source.effects as string[]).push('WRITE_EXTERNAL');
    (source.provenance as Record<string, unknown>).reviewer = 'changed';
    expect(result.records[0].effects).toEqual(['READ_EXTERNAL']);
    expect(result.records[0].provenance.reviewer).toBe('reviewer');
    expect(Object.isFrozen(result.records[0].effects)).toBe(true);
    expect(Object.isFrozen(result.records[0].parameterPaths)).toBe(true);
    expect(Object.isFrozen(result.records[0].provenance)).toBe(true);
  });
});

