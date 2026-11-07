import { describe, expect, it } from 'vitest';
import { MAX_CHART_EDGES, MAX_CHART_NODES, parseWorkflowChart } from './workflow-chart';

const valid = {
  nodes: [{ id: 'a', name: 'Start', type: 'manual', x: 0, y: 1 }],
  edges: [{ from: 'a', to: 'b', kind: 'main' }],
  unresolvedEdgeCount: 0,
};

describe('parseWorkflowChart', () => {
  it('accepts the bounded chart shape used by the renderer', () => {
    expect(parseWorkflowChart(valid)).toEqual(valid);
  });

  it('rejects missing collections, oversized collections, and malformed nodes', () => {
    expect(parseWorkflowChart({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] });
    expect(parseWorkflowChart({ nodes: [], edges: null })).toBeNull();
    expect(parseWorkflowChart({ nodes: Array.from({ length: MAX_CHART_NODES + 1 }, () => valid.nodes[0]), edges: [] })).toBeNull();
    expect(parseWorkflowChart({ nodes: [{ ...valid.nodes[0], x: Number.NaN }], edges: [] })).toBeNull();
    expect(parseWorkflowChart({ nodes: [{ id: 'a', name: 'Start', type: 'manual', x: 0 }], edges: [] })).toBeNull();
  });

  it('rejects malformed edges and edge-count overflow', () => {
    expect(parseWorkflowChart({ nodes: [], edges: Array.from({ length: MAX_CHART_EDGES + 1 }, () => valid.edges[0]) })).toBeNull();
    expect(parseWorkflowChart({ nodes: [], edges: [{ from: 'a', to: 'b' }] })).toBeNull();
    expect(parseWorkflowChart({ ...valid, unresolvedEdgeCount: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
  });

  it('preserves unresolved references without requiring endpoint nodes', () => {
    expect(parseWorkflowChart(valid)?.edges).toEqual([{ from: 'a', to: 'b', kind: 'main' }]);
  });
});
