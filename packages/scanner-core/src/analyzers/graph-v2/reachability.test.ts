import { describe, expect, it } from 'vitest';
import { createGraphOperationBudget } from './budget';
import { classifyReachabilityV2 } from './reachability';
import type { SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';

type NodeSpec = { ordinal: number; disabled?: boolean; scoringEligibility?: 'ELIGIBLE' | 'INDETERMINATE' };

type EdgeSpec = { from: number; to: number; resolution?: 'RESOLVED' | 'AMBIGUOUS' | 'UNRESOLVED'; connectionType?: string };

const workflow = (nodes: readonly NodeSpec[], edges: readonly EdgeSpec[]): SecurityWorkflowV2 => ({
  workflowFields: [],
  nodes: nodes.map(({ ordinal, disabled = false, scoringEligibility = 'ELIGIBLE' }) => ({
    ref: { ordinal }, type: 'test', disabled, scoringEligibility, parameters: [], credentials: [], settings: [],
  })),
  edges: edges.map(({ from, to, resolution = 'RESOLVED', connectionType = 'main' }, ordinal) => ({
    ordinal, sourceNode: { ordinal: from }, targetNode: { ordinal: to }, sourceLabel: 'out', targetLabel: 'in',
    connectionType, sourcePort: 0, targetPort: 0, source: { pointer: `/connections/${ordinal}`, occurrencePath: [ordinal], astNodeId: 'a'.repeat(64), span: null }, resolution,
  })),
  ambiguities: [],
} as unknown as SecurityWorkflowV2);

const budget = (maximum: number) => createGraphOperationBudget(maximum);

describe('bounded graph reachability v2', () => {
  it('reaches only enabled nodes from admitted entries and inventories unreachable cycles', () => {
    const result = classifyReachabilityV2(
      workflow(
        [{ ordinal: 0 }, { ordinal: 1 }, { ordinal: 2 }, { ordinal: 3 }],
        [{ from: 0, to: 1 }, { from: 2, to: 3 }, { from: 3, to: 2 }],
      ),
      new Set([0]),
      budget(100),
    );

    expect(result.status).toBe('COMPLETE');
    expect(result.validEntries).toEqual([0]);
    expect(result.reachable).toEqual([0, 1]);
    expect(result.unreachable).toEqual([2, 3]);
    expect(result.nodeStatuses).toEqual(['REACHABLE', 'REACHABLE', 'UNREACHABLE', 'UNREACHABLE']);
  });

  it('does not allow disabled or invalid entries to establish reachability', () => {
    const result = classifyReachabilityV2(
      workflow([{ ordinal: 0, disabled: true }, { ordinal: 1 }], [{ from: 0, to: 1 }]),
      new Set([0, 99]),
      budget(100),
    );

    expect(result.status).toBe('GRAPH_ENTRY_UNRESOLVED');
    expect(result.validEntries).toEqual([]);
    expect(result.reachable).toEqual([]);
    expect(result.unreachable).toEqual([]);
    expect(result.nodeStatuses).toEqual(['DISABLED', 'NO_ENTRY']);
  });

  it('discards partial reachability when the next charged operation exceeds the budget', () => {
    const result = classifyReachabilityV2(
      workflow([{ ordinal: 0 }, { ordinal: 1 }], [{ from: 0, to: 1 }]),
      new Set([0]),
      budget(1),
    );

    expect(result.status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(result.reachable).toEqual([]);
    expect(result.nodeStatuses).toEqual([]);
    expect(result.unreachable).toEqual([]);
    expect(result.validEntries).toEqual([]);
    expect(result.usage).toMatchObject({ maximum: 1, used: 2, exhausted: true });
  });

  it('enforces max-1, max, and max+1 at the exact measured charge count', () => {
    const graph = workflow([{ ordinal: 0 }, { ordinal: 1 }], [{ from: 0, to: 1 }]);
    const complete = classifyReachabilityV2(graph, new Set([0]), budget(1000));
    const used = complete.usage.used;
    expect(classifyReachabilityV2(graph, new Set([0]), budget(used - 1)).status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(classifyReachabilityV2(graph, new Set([0]), budget(used)).status).toBe('COMPLETE');
    expect(classifyReachabilityV2(graph, new Set([0]), budget(used + 1)).status).toBe('COMPLETE');
  });
  it('rejects accessors and malformed edges before reading nested node references', () => {
    let nestedRead = false;
    const hostile = workflow([{ ordinal: 0 }, { ordinal: 1 }], [{ from: 0, to: 1 }]);
    Object.defineProperty(hostile.edges[0], 'sourceNode', {
      get() { nestedRead = true; throw new Error('getter'); },
    });

    expect(() => classifyReachabilityV2(hostile, new Set([0]), budget(100))).toThrow(TypeError);
    expect(nestedRead).toBe(false);
  });
});
