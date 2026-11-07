import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { parseSourceDocument } from '../../source/source-parser';
import { normalizeSecurityWorkflow } from '../../workflow-v2/normalize-security-workflow';
import type { ResolvedNodeSemanticsV2 } from '../../semantics/catalogue-schema';
import type { SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';
import { inventoryDestinations, type DestinationInventoryResult } from './inventory';

const encoder = new TextEncoder();

function fixture(text: string, destinationPaths: readonly string[] = ['/url']): { workflow: SecurityWorkflowV2; semantics: ReadonlyMap<string, ResolvedNodeSemanticsV2> } {
  const parsed = parseSourceDocument(encoder.encode(text), DEFAULT_SCANNER_LIMITS_V2);
  if (!parsed.ok) throw new Error('fixture must parse');
  const normalized = normalizeSecurityWorkflow(parsed.document, DEFAULT_SCANNER_LIMITS_V2);
  if (!normalized.ok) throw new Error('fixture must normalize');
  if (normalized.workflow.nodes.length === 0) throw new Error('fixture must have a node');
  const semantics = new Map<string, ResolvedNodeSemanticsV2>();
  for (const node of normalized.workflow.nodes) {
    semantics.set(node.ref.identityDigest, Object.freeze({
      semanticId: 'test.destination', nodeType: node.type, versionRange: Object.freeze({ clauses: Object.freeze([]) }), operation: null,
      entry: 'NONE' as const, parameterPaths: Object.freeze([]), authentication: null, credentialPaths: Object.freeze([]),
      destinationPaths: Object.freeze([...destinationPaths]), effects: Object.freeze([]), endpoints: Object.freeze([]),
      ports: Object.freeze([]), overwritePaths: Object.freeze([]), errorMode: 'UNKNOWN' as const, retryMode: 'UNKNOWN' as const,
      disabledMode: 'SKIP' as const, provenance: Object.freeze({ sourceUrl: 'fixture', sourceDigest: 'a'.repeat(64), reviewedAt: '2026-09-08', reviewer: 'test' }),
    }));
  }
  return { workflow: normalized.workflow, semantics };
}

function run(text: string, paths: readonly string[] = ['/url'], limit = DEFAULT_SCANNER_LIMITS_V2.maxMembersAndElements): DestinationInventoryResult {
  const input = fixture(text, paths);
  return inventoryDestinations(input.workflow, input.semantics, { maxMembersAndElements: limit });
}

describe('inventoryDestinations', () => {
  it('records a literal HTTP authority without exposing its value', () => {
    const result = run('{"nodes":[{"type":"n8n-nodes-base.httpRequest","parameters":{"url":"https://Example.com/path"}}],"connections":{}}');
    expect(result.status).toBe('COMPLETE');
    expect(result.records).toMatchObject([{ nodeIdentity: expect.any(String), parameterPath: '/url', scheme: 'HTTPS', hostname: 'example.com', authorityState: 'KNOWN', valueMode: 'LITERAL', evidence: 'OBSERVED', reason: 'NONE', omitted: 0, inventoryStatus: 'COMPLETE' }]);
    expect(JSON.stringify(result)).not.toContain('Example.com/path');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.records[0])).toBe(true);
  });

  it('keeps a static authority known when only the path is dynamic', () => {
    const result = run('{"nodes":[{"type":"n8n-nodes-base.httpRequest","parameters":{"url":"https://api.example.com/{{$json.path}}"}}],"connections":{}}');
    expect(result.records[0]).toMatchObject({ scheme: 'HTTPS', hostname: 'api.example.com', authorityState: 'KNOWN', valueMode: 'DYNAMIC', reason: 'DYNAMIC', omitted: 1 });
  });
  it('keeps a dynamic host-like value fully unknown', () => {
    const result = run('{"nodes":[{"type":"n8n-nodes-base.httpRequest","parameters":{"url":"{{$json.host}}"}}],"connections":{}}');
    expect(result.records[0]).toMatchObject({ scheme: 'UNKNOWN', hostname: null, authorityState: 'UNKNOWN', valueMode: 'DYNAMIC', reason: 'DYNAMIC', omitted: 1 });
  });

  it('omits non-string and non-http static destinations as UNSUPPORTED', () => {
    const numeric = run('{"nodes":[{"type":"n8n-nodes-base.httpRequest","parameters":{"url":42}}],"connections":{}}');
    expect(numeric.records[0]).toMatchObject({ reason: 'UNSUPPORTED', omitted: 1, valueMode: 'UNKNOWN', evidence: 'OBSERVED' });
    const nonHttp = run('{"nodes":[{"type":"n8n-nodes-base.httpRequest","parameters":{"url":"ftp://files.example.com/v1"}}],"connections":{}}');
    expect(nonHttp.records[0]).toMatchObject({ reason: 'UNSUPPORTED', omitted: 1, scheme: 'UNKNOWN', authorityState: 'KNOWN' });
  });

  it('does not infer destinations from URL-looking keys', () => {
    const result = run('{"nodes":[{"type":"n8n-nodes-base.httpRequest","parameters":{"url":"https://ignored.example"},"url":"https://not-a-parameter.example"}],"connections":{}}', ['/configured']);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ parameterPath: '/configured', valueMode: 'UNKNOWN', evidence: 'MISSING_PATH' });
  });

  it('preserves duplicate configured paths and duplicate parameter occurrences', () => {
    const result = run('{"nodes":[{"type":"n8n-nodes-base.httpRequest","parameters":{"url":"https://one.example","url":"https://two.example"}}],"connections":{}}', ['/url', '/url']);
    expect(result.records).toHaveLength(4);
    expect(result.records.every((record) => record.parameterPath === '/url')).toBe(true);
  });

  it('matches escaped RFC6901 segments exactly', () => {
    const result = run('{"nodes":[{"type":"n8n-nodes-base.httpRequest","parameters":{"a/b":"https://escaped.example"}}],"connections":{}}', ['/a~1b']);
    expect(result.records[0]).toMatchObject({ parameterPath: '/a~1b', hostname: 'escaped.example', authorityState: 'KNOWN' });
  });

  it('emits unknown evidence for malformed and missing configured paths', () => {
    const result = run('{"nodes":[{"type":"n8n-nodes-base.httpRequest","parameters":{}}],"connections":{}}', ['/bad~2path', '/missing']);
    expect(result.status).toBe('UNKNOWN');
    expect(result.records).toMatchObject([
      { parameterPath: '/bad~2path', valueMode: 'UNKNOWN', authorityState: 'UNKNOWN', evidence: 'MALFORMED_PATH', reason: 'MALFORMED_PATH', omitted: 1, inventoryStatus: 'UNKNOWN' },
      { parameterPath: '/missing', valueMode: 'UNKNOWN', authorityState: 'UNKNOWN', evidence: 'MISSING_PATH', reason: 'MISSING_PATH', omitted: 1, inventoryStatus: 'UNKNOWN' },
    ]);
    expect(result.errors).toHaveLength(2);
    expect(result.omitted).toBe(2);
  });

  it('keeps URL userinfo, query strings, and secrets out of every record', () => {
    const result = run('{"nodes":[{"type":"n8n-nodes-base.httpRequest","parameters":{"url":"https://user:pass@example.com/v1?token=abc123"}}],"connections":{}}');
    expect(result.records[0]).toMatchObject({ hostname: 'example.com', authorityState: 'KNOWN', reason: 'NONE', omitted: 0 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('user:pass');
    expect(serialized).not.toContain('abc123');
    expect(serialized).not.toContain('/v1?token');
  });

  it('fails closed before nested scans when the member budget is exhausted', () => {
    const result = run('{"nodes":[{"type":"n8n-nodes-base.httpRequest","parameters":{"url":"https://example.com"}}],"connections":{}}', ['/url'], 0);
    expect(result.status).toBe('LIMIT_EXCEEDED');
    expect(result.records).toEqual([]);
    expect(result.errors).toMatchObject([{ code: 'LIMIT_EXCEEDED' }]);
    expect(result.omitted).toBe(1);
  });

  it('keeps record omissions discarded by a later node limit abort', () => {
    const input = fixture('{"nodes":[{"type":"n8n-nodes-base.httpRequest","parameters":{}},{"type":"n8n-nodes-base.httpRequest","parameters":{"url":"https://example.com"}}],"connections":{}}', ['/missing']);
    const result = inventoryDestinations(input.workflow, input.semantics, { maxMembersAndElements: 1 });
    expect(result.status).toBe('LIMIT_EXCEEDED');
    expect(result.records).toEqual([]);
    expect(result.errors).toMatchObject([{ code: 'MISSING_PATH' }, { code: 'LIMIT_EXCEEDED' }]);
    expect(result.omitted).toBe(2);
  });

  it('counts one omission for a node with no semantic record', () => {
    const input = fixture('{"nodes":[{"type":"n8n-nodes-base.httpRequest","parameters":{"url":"https://example.com"}}],"connections":{}}');
    const result = inventoryDestinations(input.workflow, new Map(), DEFAULT_SCANNER_LIMITS_V2);
    expect(result.status).toBe('UNKNOWN');
    expect(result.records).toEqual([]);
    expect(result.errors).toEqual([{ code: 'MISSING_SEMANTICS', nodeIdentity: input.workflow.nodes[0]!.ref.identityDigest, parameterPath: null }]);
    expect(result.omitted).toBe(1);
  });

  it('rejects a destination value above the admission cap as explicit unsafe input', () => {
    const text = JSON.stringify({ nodes: [{ type: 'n8n-nodes-base.httpRequest', parameters: { url: `https://example.com/${'a'.repeat(16_384)}` } }], connections: {} });
    const result = run(text);
    expect(result.status).toBe('UNSAFE_INPUT');
    expect(result.records).toEqual([]);
    expect(result.errors).toEqual([{ code: 'UNSAFE_INPUT', nodeIdentity: null, parameterPath: null }]);
    expect(result.omitted).toBe(1);
  });

  it('rejects a forged mutable workflow input', () => {
    const input = fixture('{"nodes":[{"type":"n8n-nodes-base.httpRequest","parameters":{"url":"https://example.com"}}],"connections":{}}');
    const forged = { ...input.workflow, nodes: [...input.workflow.nodes] };
    const result = inventoryDestinations(forged as never, input.semantics);
    expect(result.status).toBe('UNSAFE_INPUT');
    expect(result.records).toEqual([]);
    expect(result.errors).toEqual([{ code: 'UNSAFE_INPUT', nodeIdentity: null, parameterPath: null }]);
    expect(result.omitted).toBe(1);
  });
});
