import { chargeGraphOperation, createGraphOperationBudget } from '../graph-v2/budget';
import { describe, expect, it } from 'vitest';
import type { ResolvedNodeSemanticsV2 } from '../../semantics/catalogue-schema';
import {
  CONFIDENTIALITY_LABELS,
  INTEGRITY_LABELS,
  bottomConfidentiality,
  bottomIntegrity,
  createConfidentialityState,
  createIntegrityState,
  joinConfidentialityStates,
  joinIntegrityStates,
} from './labels';
import { transferNodeV2, type TaintFactV2 } from './transfer';

const node = (ordinal = 0) => ({ ref: { ordinal, identityDigest: `node-${ordinal}` }, type: 'test', disabled: false, scoringEligibility: 'ELIGIBLE', parameters: [], credentials: [], settings: [] }) as never;
const semantics = (overrides: Partial<ResolvedNodeSemanticsV2> = {}): ResolvedNodeSemanticsV2 => ({
  semanticId: 'test', nodeType: 'test', versionRange: { clauses: [] }, operation: null, entry: 'NONE',
  parameterPaths: [], authentication: null, credentialPaths: [], destinationPaths: [], effects: [], endpoints: [], ports: [], overwritePaths: [],
  errorMode: 'STOP', retryMode: 'NONE', disabledMode: 'SKIP', provenance: { sourceUrl: 'fixture', sourceDigest: 'a'.repeat(64), reviewedAt: '2026-09-08', reviewer: 'test' },
  ...overrides,
});
const fact = (field = '/value', port = 0, item = 0): TaintFactV2 => ({
  key: { node: 0, field, port, item }, confidentiality: createConfidentialityState(['WEBHOOK_BODY']), integrity: createIntegrityState(['MODEL_OUTPUT']), trace: [],
});
  it('keeps frozen confidentiality and integrity lattices independent', () => {
    const confidentiality = createConfidentialityState(CONFIDENTIALITY_LABELS);
    const integrity = createIntegrityState(['MODEL_OUTPUT']);
    expect(Object.isFrozen(confidentiality)).toBe(true);
    expect(Object.isFrozen(confidentiality.labels)).toBe(true);
    expect(joinConfidentialityStates(confidentiality, bottomConfidentiality).labels).toEqual(CONFIDENTIALITY_LABELS);
    expect(joinIntegrityStates(integrity, bottomIntegrity)).toEqual(integrity);
    expect(() => createIntegrityState(['not-a-label' as never])).toThrow(TypeError);
    expect(INTEGRITY_LABELS).toContain('RETRIEVED_CONTEXT');
  });

describe('taint transfer', () => {
  it('kills overwritten fields without clearing unrelated fields', () => {
    const result = transferNodeV2({ node: node(), semantics: semantics({ overwritePaths: ['/value'] }), incoming: [fact('/value'), fact('/other')] });
    expect(result.status).toBe('COMPLETE');
    expect(result.facts).toHaveLength(2);
    expect(result.facts.find((item) => item.key.field === '/value')).toMatchObject({ confidentiality: { labels: [] }, integrity: { labels: [] } });
    expect(result.facts.find((item) => item.key.field === '/other')).toMatchObject({ confidentiality: { labels: ['WEBHOOK_BODY'] } });
  });

  it('keeps non-zero ports and item identities through transfer', () => {
    const result = transferNodeV2({ node: node(), semantics: semantics(), incoming: [fact('/value', 3, 7)] });
    expect(result.facts[0]?.key).toEqual({ node: 0, field: '/value', port: 3, item: 7 });
  });

  it('marks unsupported error and retry semantics unknown instead of clean', () => {
    const result = transferNodeV2({ node: node(), semantics: semantics({ errorMode: 'UNKNOWN', retryMode: 'UNKNOWN' }), incoming: [fact()] });
    expect(result.status).toBe('UNKNOWN');
    expect(result.facts[0]).toMatchObject({ confidentiality: { unknown: true }, integrity: { unknown: true } });
  });

  it('records sanitizer and sink trace steps without treating a sink as a sanitizer', () => {
    const result = transferNodeV2({
      node: node(),
      semantics: semantics({ endpoints: [
        { path: '/value', channel: 'DATA', direction: 'SANITIZER', taint: 'CONFIDENTIALITY' },
        { path: '/value', channel: 'DATA', direction: 'SINK', taint: 'CONFIDENTIALITY' },
      ] }),
      incoming: [fact()],
    });
    expect(result.facts[0]).toMatchObject({ confidentiality: { labels: [] }, integrity: { labels: ['MODEL_OUTPUT'] } });
    expect(result.facts[0]?.trace.map((step) => step.kind)).toEqual(['PROPAGATION', 'SANITIZER', 'SINK']);
  });
  it('reports an already exhausted graph budget', () => {
    const graphBudget = chargeGraphOperation(createGraphOperationBudget(0)).counter;
    const result = transferNodeV2({ node: node(), semantics: semantics(), incoming: [], graphBudget });
    expect(result.status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(result.graphUsage).toEqual(graphBudget);
  });
});
