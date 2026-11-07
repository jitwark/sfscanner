import { describe, expect, it } from 'vitest';
import type { WorkflowChart } from '@hub/contracts';
import { buildFunctionalGraph, computeGraphMetrics, estimateDomElements } from './graph-metrics.js';

function chart(overrides: Partial<WorkflowChart>): WorkflowChart {
  return { nodes: [], edges: [], ...overrides };
}

describe('buildFunctionalGraph', () => {
  it('drops annotation nodes and any edge touching one', () => {
    const graph = buildFunctionalGraph(
      chart({
        nodes: [
          { id: 'a', name: 'Webhook', type: 'n8n-nodes-base.webhook', x: 0, y: 0 },
          { id: 'b', name: 'Set', type: 'n8n-nodes-base.set', x: 0, y: 0 },
          { id: 'note', name: 'Note', type: 'n8n-nodes-base.stickyNote', x: 0, y: 0 },
        ],
        edges: [
          { from: 'Webhook', to: 'Set', kind: 'main' },
          { from: 'Set', to: 'Note', kind: 'main' },
        ],
      }),
    );
    expect(graph.nodeIds.sort()).toEqual(['a', 'b']);
    expect(graph.edgeCount).toBe(1);
  });

  it('treats a node predating the isAnnotation field as functional by type alone', () => {
    // Real packaged charts omit the field entirely rather than setting it to
    // false (see `repair-connections.ts`); this must not read as annotation.
    const graph = buildFunctionalGraph(
      chart({ nodes: [{ id: 'a', name: 'Slack', type: 'n8n-nodes-base.slack', x: 0, y: 0 }], edges: [] }),
    );
    expect(graph.nodeIds).toEqual(['a']);
  });

  it('resolves an edge naming a node by its n8n name, not just its chart id', () => {
    const graph = buildFunctionalGraph(
      chart({
        nodes: [
          { id: 'uuid-1', name: 'Code', type: 'n8n-nodes-base.code', x: 0, y: 0 },
          { id: 'uuid-2', name: 'Merge', type: 'n8n-nodes-base.merge', x: 0, y: 0 },
        ],
        edges: [{ from: 'Code', to: 'Merge', kind: 'main' }],
      }),
    );
    expect(graph.adjacency.get('uuid-1')).toEqual(['uuid-2']);
  });

  it('drops an edge naming a node the chart does not contain', () => {
    const graph = buildFunctionalGraph(
      chart({
        nodes: [{ id: 'a', name: 'Set', type: 'n8n-nodes-base.set', x: 0, y: 0 }],
        edges: [{ from: 'Set', to: 'Missing', kind: 'main' }],
      }),
    );
    expect(graph.edgeCount).toBe(0);
  });
});

describe('computeGraphMetrics', () => {
  it('reports one component, no cycle, and depth 0 for a single isolated node', () => {
    const graph = buildFunctionalGraph(
      chart({ nodes: [{ id: 'a', name: 'Set', type: 'n8n-nodes-base.set', x: 0, y: 0 }], edges: [] }),
    );
    expect(computeGraphMetrics(graph)).toEqual({ componentCount: 1, hasCycle: false, maxDepth: 0 });
  });

  it('reports two components for two disconnected nodes', () => {
    const graph = buildFunctionalGraph(
      chart({
        nodes: [
          { id: 'a', name: 'A', type: 'n8n-nodes-base.set', x: 0, y: 0 },
          { id: 'b', name: 'B', type: 'n8n-nodes-base.set', x: 0, y: 0 },
        ],
        edges: [],
      }),
    );
    expect(computeGraphMetrics(graph).componentCount).toBe(2);
  });

  it('detects a self-loop as a cycle', () => {
    const graph = buildFunctionalGraph(
      chart({
        nodes: [{ id: 'a', name: 'A', type: 'n8n-nodes-base.set', x: 0, y: 0 }],
        edges: [{ from: 'A', to: 'A', kind: 'main' }],
      }),
    );
    expect(computeGraphMetrics(graph).hasCycle).toBe(true);
  });

  it('detects a multi-node cycle', () => {
    const graph = buildFunctionalGraph(
      chart({
        nodes: [
          { id: 'a', name: 'A', type: 'n8n-nodes-base.set', x: 0, y: 0 },
          { id: 'b', name: 'B', type: 'n8n-nodes-base.set', x: 0, y: 0 },
          { id: 'c', name: 'C', type: 'n8n-nodes-base.set', x: 0, y: 0 },
        ],
        edges: [
          { from: 'A', to: 'B', kind: 'main' },
          { from: 'B', to: 'C', kind: 'main' },
          { from: 'C', to: 'A', kind: 'main' },
        ],
      }),
    );
    const metrics = computeGraphMetrics(graph);
    expect(metrics.hasCycle).toBe(true);
    expect(metrics.componentCount).toBe(1);
  });

  it('measures depth as the longest BFS layer from a root', () => {
    const graph = buildFunctionalGraph(
      chart({
        nodes: [
          { id: 'a', name: 'A', type: 'n8n-nodes-base.set', x: 0, y: 0 },
          { id: 'b', name: 'B', type: 'n8n-nodes-base.set', x: 0, y: 0 },
          { id: 'c', name: 'C', type: 'n8n-nodes-base.set', x: 0, y: 0 },
        ],
        edges: [
          { from: 'A', to: 'B', kind: 'main' },
          { from: 'B', to: 'C', kind: 'main' },
        ],
      }),
    );
    expect(computeGraphMetrics(graph).maxDepth).toBe(2);
  });

  it('still assigns a finite depth to a graph with no indegree-0 node', () => {
    const graph = buildFunctionalGraph(
      chart({
        nodes: [
          { id: 'a', name: 'A', type: 'n8n-nodes-base.set', x: 0, y: 0 },
          { id: 'b', name: 'B', type: 'n8n-nodes-base.set', x: 0, y: 0 },
        ],
        edges: [
          { from: 'A', to: 'B', kind: 'main' },
          { from: 'B', to: 'A', kind: 'main' },
        ],
      }),
    );
    expect(computeGraphMetrics(graph).maxDepth).toBe(1);
  });
});

describe('estimateDomElements', () => {
  it('is zero for an empty graph', () => {
    expect(estimateDomElements(0, 0)).toBe(0);
  });

  it('reproduces the audited 206-node/183-edge baseline within a documented margin', () => {
    // ~5,051 DOM elements measured live (docs/audit/2026-08-26); the formula
    // is a calibrated estimate, not an exact predictor — see the doc comment
    // on the exported constants for the derivation.
    expect(estimateDomElements(206, 183)).toBe(5035);
  });
});
