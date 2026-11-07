import { describe, expect, it } from 'vitest';
import type { EdgeRefV2, SecurityNodeV2 } from '../../workflow-v2/security-workflow';
import { summarizeStructure } from './structure';

const node = (ordinal: number, overrides: Partial<SecurityNodeV2> = {}): SecurityNodeV2 => ({
  ref: { ordinal, identityDigest: `n${ordinal}`, source: { pointer: `/nodes/${ordinal}` } as SecurityNodeV2['ref']['source'] },
  type: 'n8n-nodes-base.set', disabled: false, scoringEligibility: 'ELIGIBLE', parameters: [], credentials: [], settings: [], ...overrides,
});
const edge = (ordinal: number, from: number, to: number, overrides: Partial<EdgeRefV2> = {}): EdgeRefV2 => ({
  ordinal, sourceNode: { ordinal: from } as EdgeRefV2['sourceNode'], targetNode: { ordinal: to } as EdgeRefV2['targetNode'],
  sourceLabel: 'main', targetLabel: 'main', connectionType: 'main', sourcePort: 0, targetPort: 0,
  source: { pointer: `/edges/${ordinal}` } as EdgeRefV2['source'], resolution: 'RESOLVED', ...overrides,
});
const summary = (nodes: SecurityNodeV2[], edges: EdgeRefV2[], inert: readonly number[] = []) =>
  summarizeStructure({ nodes, edges, inertOrdinals: new Set(inert) });

describe('Q06.2 structural summary', () => {
  it('handles the empty graph and isolated vertices', () => {
    expect(summary([], [])).toMatchObject({ total: 0, vertices: 0, edges: 0, weakComponents: 0, structuralCycleRank: 0 });
    expect(summary([node(0)], [])).toMatchObject({ total: 1, executable: 1, vertices: 1, edges: 0, weakComponents: 1, structuralCycleRank: 0 });
  });

  it('counts multiple components, isolated vertices and a chain', () => {
    expect(summary([node(0), node(1), node(2), node(3)], [edge(0, 0, 1), edge(1, 1, 2)]))
      .toMatchObject({ total: 4, executable: 4, vertices: 4, edges: 2, weakComponents: 2, structuralCycleRank: 0 });
  });

  it('counts a diamond, self-loop, parallel wires and a two-node cycle', () => {
    expect(summary([node(0), node(1), node(2), node(3)], [edge(0, 0, 1), edge(1, 0, 2), edge(2, 1, 3), edge(3, 2, 3)]))
      .toMatchObject({ edges: 4, weakComponents: 1, structuralCycleRank: 1, parallelEdgeCount: 0 });
    expect(summary([node(0)], [edge(0, 0, 0)])).toMatchObject({ edges: 1, selfLoopEdges: 1, weakComponents: 1, structuralCycleRank: 1 });
    expect(summary([node(0), node(1)], [edge(0, 0, 1), edge(1, 0, 1)]))
      .toMatchObject({ edges: 2, weakComponents: 1, structuralCycleRank: 1, parallelEdgeCount: 1 });
    expect(summary([node(0), node(1)], [edge(0, 0, 1), edge(1, 1, 0)]))
      .toMatchObject({ edges: 2, weakComponents: 1, structuralCycleRank: 1 });
  });

  it('separates disabled, inert, unresolved and executable nodes', () => {
    const nodes = [node(0), node(1, { disabled: true }), node(2, { scoringEligibility: 'INDETERMINATE' }), node(3), node(4)];
    const edges = [edge(0, 0, 4), edge(1, 1, 4), edge(2, 2, 4), edge(3, 3, 4), edge(4, 0, 2), edge(5, 0, 9)];
    expect(summary(nodes, edges, [3]))
      .toMatchObject({ total: 5, executable: 2, disabled: 1, inert: 1, unresolved: 1, vertices: 2, edges: 1, unresolvedEdges: 1, excludedEdges: 4, weakComponents: 1, structuralCycleRank: 0 });
  });

  it('excludes unresolved and ambiguous endpoints from edge metrics without dropping vertices', () => {
    expect(summary([node(0), node(1)], [
      edge(0, 0, 1, { resolution: 'UNRESOLVED', targetNode: undefined }),
      edge(1, 0, 1, { resolution: 'AMBIGUOUS' }),
      edge(2, 0, 1),
    ])).toMatchObject({ vertices: 2, edges: 1, unresolvedEdges: 2, weakComponents: 1, structuralCycleRank: 0 });
  });

  it('rejects negative, fractional and missing ports as unresolved edges', () => {
    expect(summary([node(0), node(1)], [
      edge(0, 0, 1, { sourcePort: -1 }),
      edge(1, 0, 1, { targetPort: 1.5 }),
      edge(2, 0, 1, { sourcePort: undefined as unknown as number }),
      edge(3, 0, 1),
    ])).toMatchObject({ vertices: 2, edges: 1, unresolvedEdges: 3, weakComponents: 1, structuralCycleRank: 0 });
  });
});
