import { describe, expect, it } from 'vitest';
import type { ResolvedNodeSemanticsV2, SemanticEndpointV2 } from '../../semantics/catalogue-schema';
import { createConfidentialityState, createIntegrityState } from './labels';
import { adaptSemanticEndpoints, type SemanticEndpointAdapterInput } from './catalogue-adapter';
import type { TaintFactV2 } from './transfer';

const node = (ordinal = 2) => ({ ref: { ordinal, identityDigest: `node-${ordinal}` }, type: 'fixture', disabled: false, scoringEligibility: 'ELIGIBLE', parameters: [], credentials: [], settings: [] }) as never;
const semantics = (endpoints: readonly SemanticEndpointV2[], overrides: Partial<ResolvedNodeSemanticsV2> = {}): ResolvedNodeSemanticsV2 => Object.freeze({
  semanticId: 'fixture', nodeType: 'fixture', versionRange: Object.freeze({ clauses: Object.freeze([]) }), operation: null, entry: 'NONE',
  parameterPaths: Object.freeze([]), authentication: null, credentialPaths: Object.freeze([]), destinationPaths: Object.freeze([]), effects: Object.freeze([]),
  endpoints: Object.freeze([...endpoints]), ports: Object.freeze([]), overwritePaths: Object.freeze([]), errorMode: 'STOP', retryMode: 'NONE', disabledMode: 'SKIP',
  provenance: Object.freeze({ sourceUrl: 'https://example.test/review', sourceDigest: 'a'.repeat(64), reviewedAt: '2026-09-08', reviewer: 'test' }), ...overrides,
});
const fact = (field = '/payload', port = 3, item = 7): TaintFactV2 => Object.freeze({
  key: Object.freeze({ node: 0, field, port, item }), confidentiality: createConfidentialityState(['WEBHOOK_BODY']), integrity: createIntegrityState(['MODEL_OUTPUT']), trace: Object.freeze([]),
});
const run = (endpoints: readonly SemanticEndpointV2[], incoming: readonly TaintFactV2[] = [fact()], overrides: Partial<ResolvedNodeSemanticsV2> = {}) => adaptSemanticEndpoints({ node: node(), semantics: semantics(endpoints, overrides), incoming });

describe('catalogue endpoint adapter', () => {
  it('maps source, sink, and sanitizer endpoints without collapsing taint dimensions', () => {
    const result = run([
      { path: '/payload', channel: 'MODEL', direction: 'SOURCE', taint: 'INTEGRITY' },
      { path: '/payload', channel: 'DATA', direction: 'SINK', taint: 'CONFIDENTIALITY' },
      { path: '/payload', channel: 'DATA', direction: 'SANITIZER', taint: 'CONFIDENTIALITY', scope: 'port=3,item=7' },
    ]);
    expect(result.status).toBe('COMPLETE');
    expect(result.events.map((event) => event.kind)).toEqual(['SOURCE', 'SOURCE', 'SINK', 'SANITIZER']);
    expect(result.facts.find((item) => item.key.port === 3)).toMatchObject({ key: { node: 2, port: 3, item: 7 }, confidentiality: { labels: [] }, integrity: { labels: ['MODEL_OUTPUT'] } });
  });

  it('keeps endpoint scope from sanitizing another item or port', () => {
    const result = run([{ path: '/payload', channel: 'DATA', direction: 'SANITIZER', taint: 'BOTH', scope: 'port=3,item=8' }]);
    expect(result.facts[0]).toMatchObject({ confidentiality: { labels: ['WEBHOOK_BODY'] }, integrity: { labels: ['MODEL_OUTPUT'] } });
    expect(result.events).toEqual([]);
  });
  it('preserves taint as unknown when a semantic record targets another node type', () => {
    const result = adaptSemanticEndpoints({ node: node(), semantics: semantics([], { nodeType: 'different-node' }), incoming: [fact()] });
    expect(result.status).toBe('UNKNOWN');
    expect(result.omitted).toBe(0);
    expect(result.facts[0]).toMatchObject({ confidentiality: { labels: ['WEBHOOK_BODY'], unknown: true }, integrity: { labels: ['MODEL_OUTPUT'], unknown: true } });
  });

  it('fails closed for malformed non-empty sanitizer scope', () => {
    const result = run([{ path: '/payload', channel: 'DATA', direction: 'SANITIZER', taint: 'BOTH', scope: 'not-a-port-selector' }]);
    expect(result.status).toBe('UNKNOWN');
    expect(result.events).toEqual([]);
    expect(result.facts[0]).toMatchObject({ confidentiality: { labels: ['WEBHOOK_BODY'] }, integrity: { labels: ['MODEL_OUTPUT'] } });
  });


  it('marks absent or unsupported semantics unknown and never infers from node type', () => {
    const unknown = adaptSemanticEndpoints({ node: node(), incoming: [fact()] });
    expect(unknown.status).toBe('UNKNOWN');
    expect(unknown.facts[0]).toMatchObject({ confidentiality: { unknown: true }, integrity: { unknown: true } });
    const unsupported = run([], [fact()], { errorMode: 'UNKNOWN' });
    expect(unsupported.status).toBe('UNKNOWN');
  });

  it.each([
    ['http', '/url', 'DATA', 'SINK'], ['ai', '/prompt', 'MODEL', 'SINK'], ['sql', '/query', 'DATA', 'SINK'],
    ['file', '/filePath', 'DATA', 'SINK'], ['command', '/command', 'DATA', 'SINK'], ['header', '/headers', 'DATA', 'SINK'], ['message', '/text', 'DATA', 'SINK'],
  ] as const)('emits deterministic path transfer for %s', (_name, path, channel, direction) => {
    const result = run([{ path, channel, direction, taint: 'BOTH' }], [fact(path)]);
    expect(result.status).toBe('COMPLETE');
    expect(result.events[0]).toMatchObject({ kind: 'SINK', node: 2, field: path, port: 3, item: 7 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.events)).toBe(true);
    expect(Object.isFrozen(result.facts)).toBe(true);
  });

  it('records bounded error and retry transfers', () => {
    const result = run([], [fact()], { errorMode: 'CONTINUE', retryMode: 'BOUNDED' });
    expect(result.events.map((event) => event.kind)).toEqual(['ERROR', 'RETRY']);
    expect(result.status).toBe('COMPLETE');
  });

  it('returns a stable limit result without partial output', () => {
    const result = adaptSemanticEndpoints({ node: node(), semantics: semantics([{ path: '/payload', channel: 'DATA', direction: 'SINK', taint: 'BOTH' }]), incoming: [fact()], maximum: 0 });
    expect(result.status).toBe('LIMIT_EXCEEDED');
    expect(result.facts).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.omitted).toBeGreaterThan(0);
  });
});
