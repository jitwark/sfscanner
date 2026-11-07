import { describe, expect, it } from 'vitest';
import { admitSemanticCatalogue, createSemanticCatalogueDigest, SemanticCatalogueAdmissionError } from './catalogue-admission';
import { canonicalizeJson } from '../canonical-json';
import { resolveNodeSemantics } from './catalogue-resolver';
import type { SemanticCatalogueV2 } from './catalogue-schema';

const range = (clauses: unknown): unknown => ({ clauses });
const cmp = (op: string, version: string): unknown => ({ op, version });
const provenance = { sourceUrl: 'https://example.com/source', sourceDigest: 'a'.repeat(64), reviewedAt: '2026-09-08', reviewer: 'reviewer' };
const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  semanticId: 'semantic', nodeType: 'n8n-nodes-base.httpRequest', versionRange: range([]), operation: null,
  entry: 'NONE', parameterPaths: [], authentication: null, credentialPaths: [], destinationPaths: [], effects: [], endpoints: [], ports: [], overwritePaths: [],
  errorMode: 'STOP', retryMode: 'NONE', disabledMode: 'SKIP', provenance, ...overrides,
});
const catalogue = (records: readonly unknown[]): SemanticCatalogueV2 => {
  const sortedRecords = [...records].sort((left, right) => canonicalizeJson(left).localeCompare(canonicalizeJson(right)));
  const body = { schemaVersion: 'scanner-semantics-v2' as const, id: 'test-catalogue', version: '2.0.0', records: sortedRecords, configurationKeys: [] };
  return admitSemanticCatalogue({ ...body, digest: createSemanticCatalogueDigest(body as Omit<SemanticCatalogueV2, 'digest'>) });
};

describe('semantic catalogue resolution', () => {
  it('uses exact operation, then exact type, aliases, and generic fallback', () => {
    const result = catalogue([
      record({ semanticId: 'generic', nodeType: '*', entry: 'MANUAL' }),
      record({ semanticId: 'alias', nodeType: 'n8n-nodes-base.request', entry: 'TRIGGER' }),
      record({ semanticId: 'type-default', entry: 'NONE' }),
      record({ semanticId: 'operation', operation: 'send', entry: 'SUBWORKFLOW' }),
    ]);
    expect(resolveNodeSemantics(result, { nodeType: 'n8n-nodes-base.httpRequest', version: '1.0.0', operation: 'send', aliases: ['n8n-nodes-base.request'] })?.semanticId).toBe('operation');
    expect(resolveNodeSemantics(result, { nodeType: 'missing.node', version: '1.0.0', aliases: ['n8n-nodes-base.request'] })?.semanticId).toBe('alias');
    expect(resolveNodeSemantics(result, { nodeType: 'other.node', version: '1.0.0' })?.semanticId).toBe('generic');
  });
  it('resolves across multiple aliases using range specificity', () => {
    const result = catalogue([
      record({ semanticId: 'alias-broad', nodeType: 'n8n-nodes-base.request', versionRange: range([[cmp('GTE', '1.0.0')]]) }),
      record({ semanticId: 'alias-narrow', nodeType: 'n8n-nodes-base.webhook', versionRange: range([[cmp('GTE', '1.0.0'), cmp('LT', '2.0.0')]]) }),
    ]);
    expect(resolveNodeSemantics(result, {
      nodeType: 'missing.node',
      version: '1.5.0',
      aliases: ['n8n-nodes-base.request', 'n8n-nodes-base.webhook'],
    })?.semanticId).toBe('alias-narrow');
  });

  it('rejects invalid catalogue descriptors and query versions with typed errors', () => {
    const query = { nodeType: 'n8n-nodes-base.httpRequest', version: '1.0.0' };
    expect(() => resolveNodeSemantics(null as unknown as SemanticCatalogueV2, query)).toThrow(/UNSAFE_INPUT/);
    const invalid = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(invalid, 'records', { get: () => [] });
    expect(() => resolveNodeSemantics(invalid as SemanticCatalogueV2, query)).toThrow(/UNSAFE_INPUT/);
    expect(() => resolveNodeSemantics(catalogue([record()]), { ...query, version: 'not-semver' })).toThrow(/INVALID_VERSION/);
    expect(() => resolveNodeSemantics(catalogue([record()]), { ...query, aliases: ['n8n-nodes-base.request', 'n8n-nodes-base.request'] })).toThrow(/DUPLICATE_RECORD/);
  });


  it('chooses the strict subset range and never uses a nearest version', () => {
    const result = catalogue([
      record({ semanticId: 'broad', versionRange: range([[cmp('GTE', '1.0.0')]]) }),
      record({ semanticId: 'narrow', versionRange: range([[cmp('GTE', '1.0.0'), cmp('LT', '2.0.0')]]) }),
    ]);
    expect(resolveNodeSemantics(result, { nodeType: 'n8n-nodes-base.httpRequest', version: '1.5.0' })?.semanticId).toBe('narrow');
    expect(resolveNodeSemantics(result, { nodeType: 'n8n-nodes-base.httpRequest', version: '3.0.0' })?.semanticId).toBe('broad');
    expect(resolveNodeSemantics(catalogue([record({ versionRange: range([[cmp('EQ', '1.0.0')]]) })]), { nodeType: 'n8n-nodes-base.httpRequest', version: '1.0.1' })).toBeNull();
  });

  it('rejects equally specific matching ranges instead of using input order', () => {
    expect(() => catalogue([
      record({ semanticId: 'first', versionRange: range([[cmp('GTE', '1.0.0'), cmp('LT', '3.0.0')]]) }),
      record({ semanticId: 'second', versionRange: range([[cmp('GTE', '1.0.0'), cmp('LT', '3.0.0')]]) }),
    ])).toThrow(SemanticCatalogueAdmissionError);
    expect(() => catalogue([
      record({ semanticId: 'first', versionRange: range([[cmp('GTE', '1.0.0'), cmp('LT', '3.0.0')]]) }),
      record({ semanticId: 'second', versionRange: range([[cmp('GTE', '1.0.0'), cmp('LT', '3.0.0')]]) }),
    ])).toThrow(/SEMANTIC_CATALOGUE_AMBIGUOUS/);
  });
  it('rejects a trailing lone high surrogate at the end of query operation', () => {
    const admittedCatalogue = catalogue([record({ operation: 'send' })]);
    const query = { nodeType: 'n8n-nodes-base.httpRequest', version: '1.0.0', operation: 'send\ud800' };
    expect(() => resolveNodeSemantics(admittedCatalogue, query)).toThrow(SemanticCatalogueAdmissionError);
    expect(() => resolveNodeSemantics(admittedCatalogue, query)).toThrow(/INVALID_TEXT/);
  });

  it('keeps lone low surrogates rejected and astral, ASCII, private-use, and noncharacter operation text accepted', () => {
    const admittedCatalogue = catalogue([record()]);
    const resolve = (operation: string): string | null => resolveNodeSemantics(admittedCatalogue, {
      nodeType: 'n8n-nodes-base.httpRequest', version: '1.0.0', operation,
    })?.semanticId ?? null;
    expect(() => resolve('send\udc00')).toThrow(SemanticCatalogueAdmissionError);
    expect(() => resolve('send\udc00')).toThrow(/INVALID_TEXT/);
    for (const operation of ['send\u{1F600}', 'send ascii', 'send\ue000', 'send\uffff']) expect(resolve(operation)).toBe('semantic');
  });

  it('prefers exact type over an alias with an exact operation', () => {
    const result = catalogue([
      record({ semanticId: 'exact-default', operation: null }),
      record({ semanticId: 'alias-operation', nodeType: 'n8n-nodes-base.request', operation: 'send' }),
    ]);
    expect(resolveNodeSemantics(result, {
      nodeType: 'n8n-nodes-base.httpRequest',
      version: '1.0.0',
      operation: 'send',
      aliases: ['n8n-nodes-base.request'],
    })?.semanticId).toBe('exact-default');
  });
});
