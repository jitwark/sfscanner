import { describe, expect, it } from 'vitest';
import type { ResolvedNodeSemanticsV2, SemanticEffectV2 } from '../../semantics/catalogue-schema';
import type { SecurityNodeV2, SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';
import { EIGHT_EFFECT_ORDER, summarizeConfiguredEffects } from './configured-effects';

const node = (ordinal: number, type = 'n8n-nodes-base.set', disabled = false): SecurityNodeV2 => ({
  ref: { ordinal, identityDigest: `n${ordinal}`, source: { pointer: `/nodes/${ordinal}` } as SecurityNodeV2['ref']['source'] },
  type, disabled, scoringEligibility: 'ELIGIBLE', parameters: [], credentials: [], settings: [],
});
const semantics = (id: string, effects: readonly SemanticEffectV2[] = [], semanticId = id): ResolvedNodeSemanticsV2 => ({
  semanticId, nodeType: id, versionRange: { clauses: [] }, operation: null, entry: 'NONE', parameterPaths: [], authentication: null,
  credentialPaths: [], destinationPaths: [], effects, endpoints: [], ports: [], overwritePaths: [], errorMode: 'STOP', retryMode: 'NONE', disabledMode: 'SKIP',
  provenance: { sourceUrl: 'fixture', sourceDigest: 'a'.repeat(64), reviewedAt: '2026-10-17', reviewer: 'test' },
});
const workflow = (nodes: SecurityNodeV2[]): SecurityWorkflowV2 => ({ workflowFields: [], nodes, edges: [], ambiguities: [] });

describe('Q06.3 configured-effect summary', () => {
  it('counts effects in fixed order and separated coverage', () => {
    const result = summarizeConfiguredEffects({
      workflow: workflow([node(0, 'n8n-nodes-base.code'), node(1, 'n8n-nodes-base.httpRequest', true), node(2)]),
      semantics: new Map([
        ['n0', semantics('n8n-nodes-base.code', ['EXECUTE_CODE'])],
        ['n1', semantics('n8n-nodes-base.httpRequest', ['READ_EXTERNAL', 'WRITE_EXTERNAL'])],
      ]),
    });
    const counts = Object.fromEntries(EIGHT_EFFECT_ORDER.map((effect, index) => [effect, result.effectCounts[index]]));
    expect(result).toMatchObject({ totalNodes: 3, reviewedNodes: 2, assumedNodes: 0, unknownNodes: 1, disabledEffectNodes: 1 });
    expect(counts).toMatchObject({ READ_EXTERNAL: 1, WRITE_EXTERNAL: 1, EXECUTE_CODE: 1 });
  });

  it('treats generic fallback effects as assumptions and keeps disabled effects counted', () => {
    const result = summarizeConfiguredEffects({
      workflow: workflow([node(0, 'n8n-nodes-base.code', true)]),
      semantics: new Map([['n0', semantics('n8n-nodes-base.code', ['EXECUTE_CODE'], 'generic.fallback')]]),
    });
    expect(result).toMatchObject({ assumedNodes: 1, reviewedNodes: 0, disabledEffectNodes: 1 });
    expect(result.effectCounts[2]).toBe(1);
  });

  it('is deterministic under node permutation', () => {
    const first = summarizeConfiguredEffects({
      workflow: workflow([node(0, 'a'), node(1, 'b')]),
      semantics: new Map([['n0', semantics('a', ['READ_EXTERNAL'])], ['n1', semantics('b', ['WRITE_EXTERNAL'])]]),
    });
    const second = summarizeConfiguredEffects({
      workflow: workflow([node(1, 'b'), node(0, 'a')]),
      semantics: new Map([['n0', semantics('a', ['READ_EXTERNAL'])], ['n1', semantics('b', ['WRITE_EXTERNAL'])]]),
    });
    expect(second.effectCounts).toEqual(first.effectCounts);
  });
});
