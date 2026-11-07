import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '../canonical-json';
import { admitScopedCatalogue } from './scoped-catalogue-admission';
import { resolveScopedNodeSemantics, type ScopedKnown, type ScopedRequirementV1 } from './scoped-catalogue-resolver';
import type { ScopedCatalogueBundleV1 } from './scoped-catalogue-schema';

const HTTP = 'n8n-nodes-base.httpRequest';
const GMAIL = 'n8n-nodes-base.gmail';
const allVersions = { clauses: [] };
const bounded = { clauses: [[{ op: 'GTE', version: '1.0.0' }, { op: 'LT', version: '2.0.0' }]] };
const provenance = { sourceUrl: 'https://example.com/source', sourceDigest: 'a'.repeat(64), reviewedAt: '2026-10-21', reviewer: 'controller' };

function record(semanticId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    semanticId, nodeType: HTTP, versionRange: allVersions, operation: null, entry: 'NONE',
    parameterPaths: [{ pointer: '/url', valueType: 'STRING', required: true }], authentication: null,
    credentialPaths: [], destinationPaths: ['/url'], effects: ['READ_EXTERNAL'],
    endpoints: [{ path: '/url', channel: 'DATA', direction: 'SINK', taint: 'CONFIDENTIALITY' }],
    ports: [{ type: 'main', index: 0, itemMode: 'EACH' }], overwritePaths: [],
    errorMode: 'STOP', retryMode: 'NONE', disabledMode: 'SKIP', provenance, ...overrides,
  };
}

const absent = { kind: 'ABSENT' };
const anyReviewed = { kind: 'ANY_REVIEWED' };
const exact = (value: string): Record<string, unknown> => ({ kind: 'EXACT', value });
const scoped = (raw: Record<string, unknown>, resourceScope: unknown, operationScope: unknown): Record<string, unknown> => ({ record: raw, resourceScope, operationScope });
const receipt = (semanticId: string, dimension: 'RESOURCE' | 'OPERATION'): Record<string, unknown> => ({ semanticId, dimension, evidenceDigest: 'b'.repeat(64) });
const ascii = (left: unknown, right: unknown): number => { const first = String(left); const second = String(right); return first === second ? 0 : first < second ? -1 : 1; };
const bodyOf = (records: readonly Record<string, unknown>[], scopeReceipts: readonly Record<string, unknown>[]) => ({
  schemaVersion: '1',
  records: [...records].sort((left, right) => ascii(canonicalizeJson(left), canonicalizeJson(right))),
  scopeReceipts: [...scopeReceipts].sort((left, right) => ascii(left.semanticId, right.semanticId) || ascii(left.dimension, right.dimension)),
});
const digestOf = (records: readonly Record<string, unknown>[], scopeReceipts: readonly Record<string, unknown>[]): string =>
  createHash('sha256').update(canonicalizeJson(bodyOf(records, scopeReceipts)), 'utf8').digest('hex');
const admit = (records: readonly Record<string, unknown>[], scopeReceipts: readonly Record<string, unknown>[] = []): ScopedCatalogueBundleV1 =>
  admitScopedCatalogue({ schemaVersion: '1', records, scopeReceipts, digest: digestOf(records, scopeReceipts) });

const known = <T>(value: T): ScopedKnown<T> => ({ state: 'KNOWN', value });
const unknown = (reason: string): ScopedKnown<never> => ({ state: 'UNKNOWN', reason });
const base: ScopedRequirementV1 = {
  nodeType: HTTP, version: known('1.0.0'), resource: known('https://api.example.com'),
  operation: known('send'), capability: 'http.request',
};
const requirement = (overrides: Partial<ScopedRequirementV1> = {}): ScopedRequirementV1 => ({ ...base, ...overrides });

describe('scoped catalogue resolver (Q02.R2)', () => {
  it('R1 returns the EXACT/EXACT record over the matching ANY_REVIEWED/ANY_REVIEWED record', () => {
    const bundle = admit([
      scoped(record('any-any'), anyReviewed, anyReviewed),
      scoped(record('exact-exact', { operation: 'send' }), exact('https://api.example.com'), exact('send')),
    ], [receipt('any-any', 'RESOURCE'), receipt('any-any', 'OPERATION')]);
    expect(resolveScopedNodeSemantics(bundle, requirement())?.semanticId).toBe('exact-exact');
  });

  it('R2 compares resource specificity before operation specificity', () => {
    const bundle = admit([
      scoped(record('any-resource-exact-operation', { operation: 'send' }), anyReviewed, exact('send')),
      scoped(record('exact-resource-any-operation'), exact('https://api.example.com'), anyReviewed),
    ], [receipt('any-resource-exact-operation', 'RESOURCE'), receipt('exact-resource-any-operation', 'OPERATION')]);
    expect(resolveScopedNodeSemantics(bundle, requirement())?.semanticId).toBe('exact-resource-any-operation');
  });

  it('R3 returns null for UNKNOWN version, resource or operation without throwing', () => {
    const bundle = admit([
      scoped(record('absent-absent'), absent, absent),
      scoped(record('exact-exact', { operation: 'send' }), exact('https://api.example.com'), exact('send')),
    ]);
    const queries = [
      requirement({ version: unknown('VERSION_DYNAMIC') }),
      requirement({ resource: unknown('RESOURCE_DYNAMIC') }),
      requirement({ operation: unknown('OPERATION_DYNAMIC') }),
    ];
    for (const query of queries) {
      expect(() => resolveScopedNodeSemantics(bundle, query)).not.toThrow();
      expect(resolveScopedNodeSemantics(bundle, query)).toBeNull();
    }
    expect(resolveScopedNodeSemantics(bundle, requirement({ resource: known(null), operation: known(null) }))?.semanticId).toBe('absent-absent');
  });

  it('R4 treats a known null as absence: ABSENT matches it, EXACT never does', () => {
    const bundle = admit([
      scoped(record('absent-absent'), absent, absent),
      scoped(record('exact-exact', { operation: 'send' }), exact('https://api.example.com'), exact('send')),
    ]);
    expect(resolveScopedNodeSemantics(bundle, requirement({ resource: known(null), operation: known(null) }))?.semanticId).toBe('absent-absent');
    expect(resolveScopedNodeSemantics(bundle, requirement({ resource: known(null), operation: known('send') }))).toBeNull();
  });

  it('R5 returns null for a known version outside every record range', () => {
    const bundle = admit([scoped(record('bounded', { versionRange: bounded }), absent, absent)]);
    expect(resolveScopedNodeSemantics(bundle, requirement({ version: known('3.0.0'), resource: known(null), operation: known(null) }))).toBeNull();
    expect(resolveScopedNodeSemantics(bundle, requirement({ version: known('1.5.0'), resource: known(null), operation: known(null) }))?.semanticId).toBe('bounded');
  });

  it('R6 matches node type identity only', () => {
    const bundle = admit([
      scoped(record('http'), absent, absent),
      scoped(record('gmail', { nodeType: GMAIL }), absent, absent),
    ]);
    expect(resolveScopedNodeSemantics(bundle, requirement({ nodeType: GMAIL, resource: known(null), operation: known(null) }))?.semanticId).toBe('gmail');
    expect(resolveScopedNodeSemantics(bundle, requirement({ nodeType: 'n8n-nodes-base.slack', resource: known(null), operation: known(null) }))).toBeNull();
  });

  it('R7 returns null when two matching records share the top rank pair, never an arbitrary record', () => {
    // Admission rejects equal-rank overlapping scopes, so this bundle is built past admission on
    // purpose: the resolver's own defense-in-depth rule must hold even for unadmitted input.
    const admitted = admit([scoped(record('tie-a'), anyReviewed, absent)], [receipt('tie-a', 'RESOURCE')]);
    const tieBundle: ScopedCatalogueBundleV1 = {
      ...admitted,
      records: [
        admitted.records[0],
        { ...admitted.records[0], record: { ...admitted.records[0].record, semanticId: 'tie-b' } },
        { record: { ...admitted.records[0].record, semanticId: 'least' }, resourceScope: { kind: 'ANY_REVIEWED' }, operationScope: { kind: 'ANY_REVIEWED' } },
      ],
    };
    expect(resolveScopedNodeSemantics(tieBundle, requirement({ resource: known(null), operation: known(null) }))).toBeNull();
  });

  it('R8 returns null for a malformed known version', () => {
    const bundle = admit([scoped(record('any'), absent, absent)]);
    for (const malformed of ['1.0', 'v1.0.0', '01.0.0', '1.0.0.0', '']) {
      const query = requirement({ version: known(malformed), resource: known(null), operation: known(null) });
      expect(resolveScopedNodeSemantics(bundle, query)).toBeNull();
    }
  });

  it('R9 ranks ABSENT above ANY_REVIEWED for a known-null resource', () => {
    const bundle = admit([
      scoped(record('any-any'), anyReviewed, anyReviewed),
      scoped(record('absent-any'), absent, anyReviewed),
    ], [receipt('any-any', 'RESOURCE'), receipt('any-any', 'OPERATION'), receipt('absent-any', 'OPERATION')]);
    expect(resolveScopedNodeSemantics(bundle, requirement({ resource: known(null), operation: known(null) }))?.semanticId).toBe('absent-any');
  });

  it('REV1a breaks an equal resource rank by operation rank: ABSENT beats ANY_REVIEWED for a known-null operation', () => {
    const bundle = admit([
      scoped(record('same-resource-absent-operation'), exact('https://api.example.com'), absent),
      scoped(record('same-resource-any-operation'), exact('https://api.example.com'), anyReviewed),
    ], [receipt('same-resource-any-operation', 'OPERATION')]);
    expect(resolveScopedNodeSemantics(bundle, requirement({ operation: known(null) }))?.semanticId).toBe('same-resource-absent-operation');
  });

  it('REV1b breaks an equal resource rank by operation rank: EXACT beats ANY_REVIEWED for a known operation', () => {
    const bundle = admit([
      scoped(record('any-resource-exact-operation', { operation: 'send' }), anyReviewed, exact('send')),
      scoped(record('any-resource-any-operation'), anyReviewed, anyReviewed),
    ], [receipt('any-resource-exact-operation', 'RESOURCE'), receipt('any-resource-any-operation', 'RESOURCE'), receipt('any-resource-any-operation', 'OPERATION')]);
    expect(resolveScopedNodeSemantics(bundle, requirement())?.semanticId).toBe('any-resource-exact-operation');
  });

  it('returns the bundle record itself, deterministically, without mutating the bundle', () => {
    const bundle = admit([scoped(record('only'), absent, absent)]);
    const query = requirement({ resource: known(null), operation: known(null) });
    const before = canonicalizeJson(bundle.records);
    const first = resolveScopedNodeSemantics(bundle, query);
    expect(first).toBe(bundle.records[0].record);
    expect(Object.isFrozen(first)).toBe(true);
    expect(resolveScopedNodeSemantics(bundle, query)).toBe(first);
    expect(canonicalizeJson(bundle.records)).toBe(before);
    expect(bundle.records).toHaveLength(1);
  });
});
