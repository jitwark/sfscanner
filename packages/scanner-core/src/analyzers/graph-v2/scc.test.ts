import { describe, expect, it } from 'vitest';
import { createGraphOperationBudget } from './budget';
import { computeSccsV2 } from './scc';
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
describe('bounded graph SCCs v2', () => {
  it('computes deterministic components and condensation order, including unreachable cycles', () => {
    const result = computeSccsV2(workflow(5, [[0, 1], [1, 0], [1, 2], [3, 4], [4, 3]]), createGraphOperationBudget(500));

    expect(result.status).toBe('COMPLETE');
    expect(result.components).toEqual([[0, 1], [2], [3, 4]]);
    expect(result.componentByNode).toEqual([0, 0, 1, 2, 2]);
    expect(result.condensationEdges).toEqual([[0, 1]]);
  });

  it('rejects duplicate and out-of-range edges before nested reads', () => {
    const duplicate = workflow(2, [[0, 1], [0, 1]]);
    expect(() => computeSccsV2(duplicate, createGraphOperationBudget(100))).toThrow(TypeError);
    const outOfRange = workflow(2, [[0, 2]]);
    expect(() => computeSccsV2(outOfRange, createGraphOperationBudget(100))).toThrow(TypeError);
  });

  it('returns no partial components when SCC work exhausts', () => {
    const result = computeSccsV2(workflow(2, [[0, 1], [1, 0]]), createGraphOperationBudget(1));
    expect(result.status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(result.components).toEqual([]);
    expect(result.componentByNode).toEqual([]);
    expect(result.usage.exhausted).toBe(true);
  });
});
