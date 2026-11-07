import { describe, expect, it } from 'vitest';
import { buildChart } from './chart.js';

describe('buildChart', () => {
  it('preserves connection kinds such as main, ai_tool, ai_languageModel', () => {
    const workflow = {
      nodes: [
        { id: '1', name: 'Agent Node', type: '@n8n/n8n-nodes-langchain.agent' },
        { id: '2', name: 'Model Node', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi' },
        { id: '3', name: 'Tool Node', type: '@n8n/n8n-nodes-langchain.toolHttpRequest' },
      ],
      connections: {
        'Model Node': {
          ai_languageModel: [[{ node: 'Agent Node', type: 'ai_languageModel', index: 0 }]],
        },
        'Tool Node': {
          ai_tool: [[{ node: 'Agent Node', type: 'ai_tool', index: 0 }]],
        },
      },
    };

    const chart = buildChart(workflow);

    expect(chart.nodes).toHaveLength(3);
    expect(chart.edges).toHaveLength(2);
    expect(chart.edges).toContainEqual({ from: '2', to: '1', kind: 'ai_languageModel' });
    expect(chart.edges).toContainEqual({ from: '3', to: '1', kind: 'ai_tool' });
  });

  it('caps at 400 nodes emitting the 400 highest-degree nodes', () => {
    // Generate 450 nodes. Center node connected to 449 peripheral nodes.
    const nodes = [{ name: 'Center Node', type: 'n8n-nodes-base.set' }];
    const connections: Record<string, unknown> = {
      'Center Node': { main: [] },
    };

    const mainArray: Array<Array<{ node: string; type: string; index: number }>> = [];

    for (let i = 1; i <= 449; i++) {
      const name = `Peripheral Node ${i}`;
      nodes.push({ name, type: 'n8n-nodes-base.noOp' });
      mainArray.push([{ node: name, type: 'main', index: 0 }]);
    }

    connections['Center Node'] = { main: mainArray };

    const workflow = { nodes, connections };
    const chart = buildChart(workflow);

    expect(chart.nodes).toHaveLength(400);
    expect(chart.nodes.map(n => n.name)).toContain('Center Node');
    expect(chart.edges.length).toBe(399);

    for (const node of chart.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(1);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(1);
    }
  });

  it('handles empty or malformed workflow gracefully', () => {
    expect(buildChart(null)).toEqual({ nodes: [], edges: [] });
    expect(buildChart('invalid json')).toEqual({ nodes: [], edges: [] });
    expect(buildChart({})).toEqual({ nodes: [], edges: [] });
  });
});

describe('buildChart and connections that resolve to nothing', () => {
  it('drops a connection naming a node the workflow does not contain, and counts it', () => {
    const chart = buildChart({
      nodes: [{ id: 'a', name: 'Start', type: 'n8n-nodes-base.manualTrigger', position: [0, 0] }],
      connections: { Start: { main: [[{ node: 'Ghost' }]] } },
    });

    expect(chart.edges).toEqual([]);
    expect(chart.unresolvedEdgeCount).toBe(1);
  });

  it('drops a connection whose source names no node either', () => {
    const chart = buildChart({
      nodes: [{ id: 'a', name: 'Start', type: 'n8n-nodes-base.manualTrigger', position: [0, 0] }],
      connections: { Phantom: { main: [[{ node: 'Start' }]] } },
    });

    expect(chart.edges).toEqual([]);
    expect(chart.unresolvedEdgeCount).toBe(1);
  });

  it('records nothing when every connection resolves', () => {
    const chart = buildChart({
      nodes: [
        { id: 'a', name: 'Start', type: 'n8n-nodes-base.manualTrigger', position: [0, 0] },
        { id: 'b', name: 'Next', type: 'n8n-nodes-base.set', position: [1, 0] },
      ],
      connections: { Start: { main: [[{ node: 'Next' }]] } },
    });

    expect(chart.edges).toHaveLength(1);
    expect(chart.unresolvedEdgeCount ?? 0).toBe(0);
  });

  it('still resolves a connection that names a node by its id rather than its name', () => {
    const chart = buildChart({
      nodes: [
        { id: 'node-1', name: '', type: 'n8n-nodes-base.manualTrigger', position: [0, 0] },
        { id: 'node-2', name: '', type: 'n8n-nodes-base.set', position: [1, 0] },
      ],
      connections: { 'node-1': { main: [[{ node: 'node-2' }]] } },
    });

    expect(chart.edges).toHaveLength(1);
  });
});
