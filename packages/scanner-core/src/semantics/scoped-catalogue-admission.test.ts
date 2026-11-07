import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '../canonical-json';
import { assertPlainData, SemanticCatalogueAdmissionError, versionRangesOverlap } from './catalogue-admission';
import type { VersionRangeV2 } from './version-range';
import { admitScopedCatalogue } from './scoped-catalogue-admission';

const range = (clauses: unknown): unknown => ({ clauses });
const cmp = (op: string, version: string): unknown => ({ op, version });
const overlapping = range([[cmp('GTE', '1.0.0'), cmp('LT', '2.0.0')]]);
const intersecting = range([[cmp('GTE', '1.5.0'), cmp('LT', '3.0.0')]]);
const disjoint = range([[cmp('EQ', '4.0.0')]]);
const provenance = { sourceUrl: 'https://example.com/source', sourceDigest: 'a'.repeat(64), reviewedAt: '2026-09-08', reviewer: 'reviewer' };
const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  semanticId: 'http-default', nodeType: 'n8n-nodes-base.httpRequest', versionRange: range([]), operation: null,
  entry: 'NONE', parameterPaths: [{ pointer: '/url', valueType: 'STRING', required: true }], authentication: null,
  credentialPaths: ['/credentials'], destinationPaths: ['/url'], effects: ['READ_EXTERNAL'],
  endpoints: [{ path: '/url', channel: 'DATA', direction: 'SINK', taint: 'CONFIDENTIALITY' }],
  ports: [{ type: 'main', index: 0, itemMode: 'EACH' }], overwritePaths: [],
  errorMode: 'STOP', retryMode: 'NONE', disabledMode: 'SKIP', provenance, ...overrides,
});
const absent = { kind: 'ABSENT' };
const anyReviewed = { kind: 'ANY_REVIEWED' };
const exact = (value: string): Record<string, unknown> => ({ kind: 'EXACT', value });
const scoped = (raw: Record<string, unknown> = record(), resourceScope: unknown = absent, operationScope: unknown = absent): Record<string, unknown> => ({ record: raw, resourceScope, operationScope });
const receipt = (semanticId: string, dimension: 'RESOURCE' | 'OPERATION' = 'OPERATION', evidenceDigest = 'b'.repeat(64)): Record<string, unknown> => ({ semanticId, dimension, evidenceDigest });
const ascii = (left: unknown, right: unknown): number => { const first = String(left); const second = String(right); return first === second ? 0 : first < second ? -1 : 1; };
const bodyOf = (records: readonly Record<string, unknown>[], scopeReceipts: readonly Record<string, unknown>[]) => ({
  schemaVersion: '1',
  records: [...records].sort((left, right) => ascii(canonicalizeJson(left), canonicalizeJson(right))),
  scopeReceipts: [...scopeReceipts].sort((left, right) => ascii(left.semanticId, right.semanticId) || ascii(left.dimension, right.dimension)),
});
const digestOf = (records: readonly Record<string, unknown>[], scopeReceipts: readonly Record<string, unknown>[] = []): string =>
  createHash('sha256').update(canonicalizeJson(bodyOf(records, scopeReceipts)), 'utf8').digest('hex');
const bundle = (records: readonly Record<string, unknown>[], scopeReceipts: readonly Record<string, unknown>[] = [], overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ schemaVersion: '1', records, scopeReceipts, digest: digestOf(records, scopeReceipts), ...overrides });

function rejection(run: () => unknown): SemanticCatalogueAdmissionError {
  try { run(); } catch (error) { if (error instanceof SemanticCatalogueAdmissionError) return error; throw error; }
  throw new Error('expected SemanticCatalogueAdmissionError, nothing was thrown');
}

describe('scoped catalogue admission (Q02.R1)', () => {
  it('S1 admits one ABSENT/ABSENT record, recomputes the digest, and keeps the admitted record', () => {
    const source = record();
    const records = [scoped(source)];
    const result = admitScopedCatalogue(bundle(records));
    expect(result.schemaVersion).toBe('1');
    expect(result.records.map(({ record: item }) => item.semanticId)).toEqual(['http-default']);
    expect(result.digest).toBe(digestOf(records));
    expect(result.scopeReceipts).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.records)).toBe(true);
    expect(Object.isFrozen(result.records[0].resourceScope)).toBe(true);
    expect(Object.isFrozen(result.records[0].record.provenance)).toBe(true);
    (source.effects as string[]).push('WRITE_EXTERNAL');
    expect(result.records[0].record.effects).toEqual(['READ_EXTERNAL']);
  });

  it('S2 yields an identical digest and canonical body for both record orders', () => {
    const forward = admitScopedCatalogue(bundle([
      scoped(record({ semanticId: 'z', nodeType: 'n8n-nodes-base.z' })),
      scoped(record({ semanticId: 'a', nodeType: 'n8n-nodes-base.a' })),
    ]));
    const reverse = admitScopedCatalogue(bundle([
      scoped(record({ semanticId: 'a', nodeType: 'n8n-nodes-base.a' })),
      scoped(record({ semanticId: 'z', nodeType: 'n8n-nodes-base.z' })),
    ]));
    expect(forward.digest).toBe(reverse.digest);
    const { digest: forwardDigest, ...forwardBody } = forward;
    const { digest: reverseDigest, ...reverseBody } = reverse;
    expect(forwardDigest).toBe(reverseDigest);
    expect(canonicalizeJson(forwardBody)).toBe(canonicalizeJson(reverseBody));
    expect(forward.records.map(({ record: item }) => item.semanticId)).toEqual(['a', 'z']);
    expect(reverse.records.map(({ record: item }) => item.semanticId)).toEqual(['a', 'z']);
  });

  it('S3 rejects an EXACT operation scope that does not equal record.operation', () => {
    const input = bundle([scoped(record({ operation: 'request' }), absent, exact('other'))]);
    expect(rejection(() => admitScopedCatalogue(input)).code).toBe('INVALID_TEXT');
  });

  it('S4 rejects an ABSENT operation scope when the record declares an operation', () => {
    const input = bundle([scoped(record({ operation: 'request' }))]);
    expect(rejection(() => admitScopedCatalogue(input)).code).toBe('INVALID_TEXT');
  });

  it('S5 rejects ANY_REVIEWED without a receipt', () => {
    const input = bundle([scoped(record(), absent, anyReviewed)]);
    expect(rejection(() => admitScopedCatalogue(input)).code).toBe('MISSING_KEY');
  });

  it('S6 admits ANY_REVIEWED with a matching 64-hex receipt', () => {
    const result = admitScopedCatalogue(bundle([scoped(record(), absent, anyReviewed)], [receipt('http-default', 'OPERATION')]));
    expect(result.records[0].operationScope).toEqual({ kind: 'ANY_REVIEWED' });
    expect(result.scopeReceipts).toEqual([{ semanticId: 'http-default', dimension: 'OPERATION', evidenceDigest: 'b'.repeat(64) }]);
    expect(Object.isFrozen(result.scopeReceipts[0])).toBe(true);
  });

  it('S7 rejects a receipt for a non-ANY_REVIEWED dimension', () => {
    const input = bundle([scoped()], [receipt('http-default', 'RESOURCE')]);
    expect(rejection(() => admitScopedCatalogue(input)).code).toBe('UNKNOWN_KEY');
  });

  it('S8 rejects a duplicate record.semanticId', () => {
    const input = bundle([
      scoped(record({ semanticId: 'duplicate' })),
      scoped(record({ semanticId: 'duplicate', nodeType: 'n8n-nodes-base.other' })),
    ]);
    expect(rejection(() => admitScopedCatalogue(input)).code).toBe('DUPLICATE_ID');
  });

  it('S9 rejects equal-rank overlapping records with identical scopes on both dimensions', () => {
    const input = bundle([
      scoped(record({ semanticId: 'first', versionRange: range([[cmp('GT', '1.0.0')]]) })),
      scoped(record({ semanticId: 'second', versionRange: range([[cmp('LT', '2.0.0')]]) })),
    ]);
    expect(rejection(() => admitScopedCatalogue(input)).code).toBe('SEMANTIC_CATALOGUE_AMBIGUOUS');
  });

  it('S10 admits differing resource specificity over the same ranges', () => {
    const input = bundle([
      scoped(record({ semanticId: 'exact', versionRange: range([[cmp('GT', '1.0.0')]]) }), exact('https://api.example.com')),
      scoped(record({ semanticId: 'reviewed', versionRange: range([[cmp('LT', '2.0.0')]]) }), anyReviewed),
    ], [receipt('reviewed', 'RESOURCE')]);
    const result = admitScopedCatalogue(input);
    expect(result.records.map(({ record: item }) => item.semanticId)).toEqual(['exact', 'reviewed']);
  });

  it('S11 rejects a tampered digest', () => {
    const input = bundle([scoped()]);
    const digest = String(input.digest);
    input.digest = `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`;
    expect(rejection(() => admitScopedCatalogue(input)).code).toBe('DIGEST_MISMATCH');
  });

  it('S12 rejects an accessor property without invoking the getter', () => {
    let reads = 0;
    const plain = bundle([scoped()]);
    const accessorScope = { get kind(): string { reads += 1; return 'ABSENT'; } };
    const [first] = plain.records as Record<string, unknown>[];
    const input = { ...plain, records: [{ ...first, resourceScope: accessorScope }] };
    expect(rejection(() => admitScopedCatalogue(input)).code).toBe('UNSAFE_INPUT');
    expect(reads).toBe(0);
  });

  it('S13 rejects unknown top-level and scope keys', () => {
    expect(rejection(() => admitScopedCatalogue(bundle([scoped()], [], { extra: true }))).code).toBe('UNKNOWN_KEY');
    expect(rejection(() => admitScopedCatalogue(bundle([scoped(record(), { kind: 'ABSENT', value: 'x' })]))).code).toBe('UNKNOWN_KEY');
    expect(rejection(() => admitScopedCatalogue(bundle([scoped(record(), { kind: 'EXACT', value: 'x', extra: 1 })]))).code).toBe('UNKNOWN_KEY');
  });

  it('validates every raw record through catalogue admission', () => {
    const input = bundle([scoped(record({ severity: 'HIGH' }))]);
    expect(rejection(() => admitScopedCatalogue(input)).code).toBe('UNKNOWN_KEY');
  });

  it('rejects duplicate receipts, orphan receipts, malformed digests, and unbounded EXACT values', () => {
    const reviewed = [scoped(record(), absent, anyReviewed)];
    expect(rejection(() => admitScopedCatalogue(bundle(reviewed, [
      receipt('http-default', 'OPERATION'), receipt('http-default', 'OPERATION', 'c'.repeat(64)),
    ]))).code).toBe('DUPLICATE_RECORD');
    expect(rejection(() => admitScopedCatalogue(bundle([scoped()], [receipt('unknown', 'RESOURCE')]))).code).toBe('INVALID_TEXT');
    expect(rejection(() => admitScopedCatalogue(bundle(reviewed, [receipt('http-default', 'OPERATION', 'B'.repeat(64))]))).code).toBe('DIGEST_MISMATCH');
    expect(rejection(() => admitScopedCatalogue(bundle([scoped(record(), exact(''))]))).code).toBe('INVALID_TEXT');
    expect(rejection(() => admitScopedCatalogue(bundle([scoped(record(), exact('api\u0001'))]))).code).toBe('INVALID_TEXT');
    expect(rejection(() => admitScopedCatalogue(bundle([scoped(record(), exact('a'.repeat(257)))]))).code).toBe('INVALID_TEXT');
    expect(rejection(() => admitScopedCatalogue(bundle([scoped(record(), exact('e\u0301'))]))).code).toBe('INVALID_TEXT');
    expect(rejection(() => admitScopedCatalogue(bundle([scoped(record(), exact('a\uD800'))]))).code).toBe('INVALID_TEXT');
  });
});

describe('shared admission wrappers (Q02.R1)', () => {
  it('versionRangesOverlap exposes the existing witness predicate', () => {
    expect(versionRangesOverlap(overlapping as VersionRangeV2, intersecting as VersionRangeV2)).toBe(true);
    expect(versionRangesOverlap(overlapping as VersionRangeV2, disjoint as VersionRangeV2)).toBe(false);
  });

  it('assertPlainData rejects accessors without invoking them and accepts plain data', () => {
    let reads = 0;
    const accessor = { get value(): number { reads += 1; return 1; } };
    expect(rejection(() => assertPlainData(accessor)).code).toBe('UNSAFE_INPUT');
    expect(reads).toBe(0);
    expect(() => assertPlainData({ nested: [1, 'two', null, { three: true }] })).not.toThrow();
  });
});
