import { describe, expect, it } from 'vitest';
import type { WorkflowChart } from '@hub/contracts';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { repairEntry, resolvableEdges } from './repair-connections.js';

const chartOf = (edges: Array<[string, string]>, nodeIds = ['a', 'b']): WorkflowChart => ({
  nodes: nodeIds.map((id) => ({ id, name: id, type: 'n8n-nodes-base.set', x: 0, y: 0 })),
  edges: edges.map(([from, to]) => ({ from, to, kind: 'main' })),
});

describe('resolvableEdges', () => {
  it('keeps an edge whose endpoints are both nodes in the chart', () => {
    expect(resolvableEdges(chartOf([['a', 'b']]))).toHaveLength(1);
  });

  it('drops an edge naming a node the chart does not contain', () => {
    expect(resolvableEdges(chartOf([['a', 'b'], ['a', 'ghost'], ['nowhere', 'b']]))).toHaveLength(1);
  });

  it('resolves a legacy edge that names a node by its display name', () => {
    // Before `buildChart` was fixed it emitted the raw connection name where an
    // id belonged. When that name is a real node's name the edge is genuine and
    // must survive the repair.
    const chart: WorkflowChart = {
      nodes: [
        { id: 'node-1', name: 'Start', type: 'n8n-nodes-base.set', x: 0, y: 0 },
        { id: 'node-2', name: 'Finish', type: 'n8n-nodes-base.set', x: 0, y: 0 },
      ],
      edges: [{ from: 'Start', to: 'Finish', kind: 'main' }],
    };

    expect(resolvableEdges(chart)).toHaveLength(1);
  });
});

describe('repairEntry', () => {
  it('recomputes the count from the chart and records what was dropped', () => {
    const entry = makeEntry({
      structure: { nodeCount: 2, connectionCount: 2, complexity: 'medium', integrations: ['slack'] },
    });

    const result = repairEntry(entry, chartOf([['a', 'b'], ['a', 'ghost']]));

    expect(result.entry.structure.connectionCount).toBe(1);
    expect(result.chart.edges).toHaveLength(1);
    expect(result.chart.unresolvedEdgeCount).toBe(1);
    expect(result.changed).toBe(true);
  });

  it('re-bands complexity when the phantom connections were what inflated it', () => {
    const edges: Array<[string, string]> = Array.from({ length: 30 }, (_, i) => ['a', `ghost-${i}`]);
    const entry = makeEntry({
      structure: { nodeCount: 2, connectionCount: 30, complexity: 'complex', integrations: ['slack'] },
    });

    const result = repairEntry(entry, chartOf(edges));

    expect(result.entry.structure.connectionCount).toBe(0);
    expect(result.entry.structure.complexity).toBe('simple');
  });

  it('leaves a coherent entry untouched', () => {
    const entry = makeEntry({
      structure: { nodeCount: 2, connectionCount: 1, complexity: 'simple', integrations: ['slack'] },
    });

    const result = repairEntry(entry, chartOf([['a', 'b']]));

    expect(result.changed).toBe(false);
    expect(result.chart.unresolvedEdgeCount).toBeUndefined();
  });

  it('does not invent an unresolvedEdgeCount of zero on a healthy chart', () => {
    // 13,221 charts are serialised; a field that is always present costs bytes
    // on every one of them, and `buildChart` omits it for the same reason.
    const result = repairEntry(makeEntry(), chartOf([['a', 'b']]));

    expect(Object.hasOwn(result.chart, 'unresolvedEdgeCount')).toBe(false);
  });

  it('trusts the chart over the recorded count, in either direction', () => {
    const entry = makeEntry({ structure: { nodeCount: 2, connectionCount: 0, integrations: ['slack'] } });

    expect(repairEntry(entry, chartOf([['a', 'b']])).entry.structure.connectionCount).toBe(1);
  });
});

describe('resolvableEdges and annotations', () => {
  it('does not count an edge to a sticky note as data flow', () => {
    // `structure.nodeCount` excludes annotations. Counting an edge to one would
    // leave the two halves of a single claim disagreeing, and is the definition
    // `check-graph-coherence.mjs` uses.
    const chart: WorkflowChart = {
      nodes: [
        { id: 'a', name: 'Start', type: 'n8n-nodes-base.set', x: 0, y: 0 },
        { id: 'note', name: 'Note', type: 'n8n-nodes-base.stickyNote', x: 0, y: 0, isAnnotation: true },
      ],
      edges: [{ from: 'a', to: 'note', kind: 'main' }],
    };

    expect(resolvableEdges(chart)).toHaveLength(0);
  });
});

describe('resolvableEdges on packaged charts that predate isAnnotation', () => {
  it('reads the node type when the flag is absent', () => {
    // Real corpus shape: entry 63c354b757bbca28 carries a node named "Start"
    // typed `n8n-nodes-base.stickyNote` with no `isAnnotation` key at all. It
    // is a comment box, and the edge out of it is not data flow.
    const chart: WorkflowChart = {
      nodes: [
        { id: 'start-node', name: 'Start', type: 'n8n-nodes-base.stickyNote', x: 0, y: 0 },
        { id: 'search', name: 'Search Papers', type: 'n8n-nodes-pdfvector.pdfVector', x: 0, y: 0 },
      ],
      edges: [{ from: 'Start', to: 'Search Papers', kind: 'main' }],
    };

    expect(resolvableEdges(chart)).toHaveLength(0);
  });
});
