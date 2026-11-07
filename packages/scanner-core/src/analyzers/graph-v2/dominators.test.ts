import { describe, expect, it } from 'vitest';
import { createGraphOperationBudget } from './budget';
import { computeDominatorsV2, dominatesV2, VIRTUAL_ENTRY_V2 } from './dominators';
import type { SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';

const workflow = (count: number, edges: readonly (readonly [number, number])[]): SecurityWorkflowV2 => ({
  workflowFields: [],
  nodes: Array.from({ length: count }, (_, ordinal) => ({
    ref: { ordinal }, type: 'test', disabled: false, scoringEligibility: 'ELIGIBLE', parameters: [], credentials: [], settings: [],
  })),
  edges: edges.map(([from, to], ordinal) => ({
    ordinal, sourceNode: { ordinal: from }, targetNode: { ordinal: to }, sourceLabel: 'out', targetLabel: 'in',
    connectionType: 'main', sourcePort: 0, targetPort: 0, source: { pointer: `/connections/${ordinal}`, occurrencePath: [ordinal], astNodeId: 'a'.repeat(64), span: null }, resolution: 'RESOLVED',
  })),
  ambiguities: [],
} as unknown as SecurityWorkflowV2);
describe('bounded graph dominators v2', () => {
  it('proves only gates common to every reachable branch', () => {
    const result = computeDominatorsV2(workflow(4, [[0, 1], [0, 2], [1, 3], [2, 3]]), new Set([0]), createGraphOperationBudget(500));

    expect(result.status).toBe('COMPLETE');
    expect(result.dominatorsByNode[3]).toEqual([VIRTUAL_ENTRY_V2, 0, 3]);
    expect(dominatesV2(result, 0, 3)).toBe(true);
    expect(dominatesV2(result, 1, 3)).toBe(false);
    expect(dominatesV2(result, 3, 3)).toBe(false);
  });
  it('converges on a back-edge without retaining a partial proof', () => {
    const result = computeDominatorsV2(workflow(4, [[0, 1], [1, 2], [2, 1], [2, 3], [0, 3]]), new Set([0]), createGraphOperationBudget(1000));
    expect(result.status).toBe('COMPLETE');
    expect(result.dominatorsByNode[3]).toEqual([VIRTUAL_ENTRY_V2, 0, 3]);
  });

  it('does not expose a proof map when entries are unresolved', () => {
    const result = computeDominatorsV2(workflow(2, [[0, 1]]), new Set([99]), createGraphOperationBudget(100));
    expect(result.status).toBe('GRAPH_ENTRY_UNRESOLVED');
    expect(result.dominatorsByNode).toEqual([]);
    expect(dominatesV2(result, 0, 1)).toBe(false);
  });

  it('enforces max-1, max, and max+1 at the exact measured charge count', () => {
    const graph = workflow(3, [[0, 1], [1, 2], [0, 2]]);
    const complete = computeDominatorsV2(graph, new Set([0]), createGraphOperationBudget(2000));
    const used = complete.usage.used;
    expect(computeDominatorsV2(graph, new Set([0]), createGraphOperationBudget(used - 1)).status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(computeDominatorsV2(graph, new Set([0]), createGraphOperationBudget(used)).status).toBe('COMPLETE');
    expect(computeDominatorsV2(graph, new Set([0]), createGraphOperationBudget(used + 1)).status).toBe('COMPLETE');
  });
  it('discards partial dominator convergence on exhaustion', () => {
    const result = computeDominatorsV2(workflow(3, [[0, 1], [1, 2], [0, 2]]), new Set([0]), createGraphOperationBudget(1));
    expect(result.status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(result.dominatorsByNode).toEqual([]);
    expect(result.usage).toMatchObject({ maximum: 1, used: 2, exhausted: true });
  });
});
