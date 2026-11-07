import { describe, expect, it } from 'vitest';
import type { WorkflowChart } from './index';
import { classifyCategory, computeGraphLayout } from './graph-layout';

describe('graph-layout.ts', () => {
  it('classifies node categories correctly', () => {
    expect(classifyCategory('n8n-nodes-base.webhook')).toBe('trigger');
    expect(classifyCategory('@n8n/n8n-nodes-langchain.agent')).toBe('ai');
    expect(classifyCategory('n8n-nodes-base.httpRequest')).toBe('http');
    expect(classifyCategory('n8n-nodes-base.code')).toBe('code');
    expect(classifyCategory('n8n-nodes-base.postgres')).toBe('storage');
    expect(classifyCategory('n8n-nodes-base.if')).toBe('flow');
    expect(classifyCategory('n8n-nodes-base.set')).toBe('transform');
    expect(classifyCategory('n8n-nodes-base.customUnknown')).toBe('other');
  });

  it('uses embedded coordinates when >=80% of nodes have valid positions', () => {
    const chart: WorkflowChart = {
      nodes: [
        { id: '1', name: 'Start', type: 'n8n-nodes-base.webhook', x: 100, y: 100 },
        { id: '2', name: 'Code', type: 'n8n-nodes-base.code', x: 300, y: 100 },
      ],
      edges: [{ from: '1', to: '2', kind: 'main' }],
    };

    const layout = computeGraphLayout(chart);
    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(1);
    expect(layout.viewBox).toBeDefined();
  });

  it('runs BFS layered layout when coordinates are missing', () => {
    const chart: WorkflowChart = {
      nodes: [
        { id: 'a', name: 'A', type: 'n8n-nodes-base.manualTrigger', x: 0, y: 0 },
        { id: 'b', name: 'B', type: 'n8n-nodes-base.set', x: 0, y: 0 },
        { id: 'c', name: 'C', type: 'n8n-nodes-base.code', x: 0, y: 0 },
      ],
      edges: [
        { from: 'a', to: 'b', kind: 'main' },
        { from: 'b', to: 'c', kind: 'main' },
      ],
    };

    const layout = computeGraphLayout(chart);
    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges).toHaveLength(2);

    const nodeA = layout.nodes.find((n) => n.id === 'a')!;
    const nodeB = layout.nodes.find((n) => n.id === 'b')!;
    const nodeC = layout.nodes.find((n) => n.id === 'c')!;

    // Layer 0 < Layer 1 < Layer 2 in X coordinates
    expect(nodeA.x).toBeLessThan(nodeB.x);
    expect(nodeB.x).toBeLessThan(nodeC.x);
  });

  it('rejects infinite embedded coordinates before static layout', () => {
    const chart: WorkflowChart = {
      nodes: [
        { id: 'a', name: 'A', type: 'n8n-nodes-base.manualTrigger', x: Infinity, y: 0 },
        { id: 'b', name: 'B', type: 'n8n-nodes-base.set', x: 0, y: 0 },
      ],
      edges: [{ from: 'a', to: 'b', kind: 'main' }],
    };

    const layout = computeGraphLayout(chart);
    expect(layout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  it('resolves name-based n8n connections when chart node ids are opaque', () => {
    const chart: WorkflowChart = {
      nodes: [
        { id: 'uuid-trigger', name: 'Start', type: 'n8n-nodes-base.webhook', x: 100, y: 100 },
        { id: 'uuid-action', name: 'Send message', type: 'n8n-nodes-base.slack', x: 300, y: 100 },
      ],
      edges: [{ from: 'Start', to: 'Send message', kind: 'main' }],
    };

    const layout = computeGraphLayout(chart);

    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ from: 'uuid-trigger', to: 'uuid-action' });
  });

  it('handles cyclic graphs without infinite loops', () => {
    const chart: WorkflowChart = {
      nodes: [
        { id: 'n1', name: 'N1', type: 'n8n-nodes-base.code', x: 0, y: 0 },
        { id: 'n2', name: 'N2', type: 'n8n-nodes-base.code', x: 0, y: 0 },
      ],
      edges: [
        { from: 'n1', to: 'n2', kind: 'main' },
        { from: 'n2', to: 'n1', kind: 'main' },
      ],
    };

    const layout = computeGraphLayout(chart);
    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(2);
  });
});
