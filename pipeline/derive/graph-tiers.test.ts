import { describe, expect, it } from 'vitest';
import type { WorkflowChart } from '@hub/contracts';
import {
  DEFAULT_GRAPH_TIER_THRESHOLDS,
  GRAPH_TIER_THRESHOLDS_SCHEMA_VERSION,
  classifyGraphTier,
  graphComplexityInputFromChart,
} from './graph-tiers.js';

describe('DEFAULT_GRAPH_TIER_THRESHOLDS', () => {
  it('is frozen so no caller can mutate the shared thresholds', () => {
    expect(Object.isFrozen(DEFAULT_GRAPH_TIER_THRESHOLDS)).toBe(true);
  });

  it('carries its schema version', () => {
    expect(DEFAULT_GRAPH_TIER_THRESHOLDS.schemaVersion).toBe(GRAPH_TIER_THRESHOLDS_SCHEMA_VERSION);
  });
});

describe('classifyGraphTier: invalid', () => {
  it('is invalid for null/undefined input', () => {
    expect(classifyGraphTier(null)).toBe('invalid');
    expect(classifyGraphTier(undefined)).toBe('invalid');
  });

  it('is invalid for zero, negative, or non-finite node counts', () => {
    expect(classifyGraphTier({ nodeCount: 0, edgeCount: 0 })).toBe('invalid');
    expect(classifyGraphTier({ nodeCount: -1, edgeCount: 0 })).toBe('invalid');
    expect(classifyGraphTier({ nodeCount: Number.NaN, edgeCount: 0 })).toBe('invalid');
    expect(classifyGraphTier({ nodeCount: 5, edgeCount: Number.POSITIVE_INFINITY })).toBe('invalid');
  });
});

describe('classifyGraphTier: node-count axis (edgeCount fixed at 0)', () => {
  const { tierAMaxNodes, tierBMaxNodes } = DEFAULT_GRAPH_TIER_THRESHOLDS;

  it('boundary-1/boundary/boundary+1 around the A/B threshold', () => {
    expect(classifyGraphTier({ nodeCount: tierAMaxNodes - 1, edgeCount: 0 })).toBe('A');
    expect(classifyGraphTier({ nodeCount: tierAMaxNodes, edgeCount: 0 })).toBe('A');
    expect(classifyGraphTier({ nodeCount: tierAMaxNodes + 1, edgeCount: 0 })).toBe('B');
  });

  it('boundary-1/boundary/boundary+1 around the B/C threshold', () => {
    expect(classifyGraphTier({ nodeCount: tierBMaxNodes - 1, edgeCount: 0 })).toBe('B');
    expect(classifyGraphTier({ nodeCount: tierBMaxNodes, edgeCount: 0 })).toBe('B');
    expect(classifyGraphTier({ nodeCount: tierBMaxNodes + 1, edgeCount: 0 })).toBe('C');
  });

  it('is A at the smallest valid graph', () => {
    expect(classifyGraphTier({ nodeCount: 1, edgeCount: 0 })).toBe('A');
  });
});

describe('classifyGraphTier: edge-count axis (nodeCount fixed low)', () => {
  const { tierAMaxEdges, tierBMaxEdges } = DEFAULT_GRAPH_TIER_THRESHOLDS;

  it('boundary-1/boundary/boundary+1 around the A/B threshold', () => {
    expect(classifyGraphTier({ nodeCount: 1, edgeCount: tierAMaxEdges - 1 })).toBe('A');
    expect(classifyGraphTier({ nodeCount: 1, edgeCount: tierAMaxEdges })).toBe('A');
    expect(classifyGraphTier({ nodeCount: 1, edgeCount: tierAMaxEdges + 1 })).toBe('B');
  });

  it('boundary-1/boundary/boundary+1 around the B/C threshold', () => {
    expect(classifyGraphTier({ nodeCount: 1, edgeCount: tierBMaxEdges - 1 })).toBe('B');
    expect(classifyGraphTier({ nodeCount: 1, edgeCount: tierBMaxEdges })).toBe('B');
    expect(classifyGraphTier({ nodeCount: 1, edgeCount: tierBMaxEdges + 1 })).toBe('C');
  });
});

describe('classifyGraphTier: combined severity', () => {
  it('takes the more severe of the two axes', () => {
    const { tierAMaxNodes, tierBMaxEdges } = DEFAULT_GRAPH_TIER_THRESHOLDS;
    // Small node count (Tier A on its own) paired with an extreme edge count
    // (Tier C on its own) must not read as the gentler tier.
    expect(classifyGraphTier({ nodeCount: 2, edgeCount: tierBMaxEdges + 1 })).toBe('C');
    expect(classifyGraphTier({ nodeCount: tierAMaxNodes, edgeCount: tierAMaxNodes })).toBe('A');
  });

  it('uses the default thresholds object when none is passed explicitly', () => {
    expect(classifyGraphTier({ nodeCount: 1, edgeCount: 0 }, DEFAULT_GRAPH_TIER_THRESHOLDS)).toBe(
      classifyGraphTier({ nodeCount: 1, edgeCount: 0 }),
    );
  });
});

function chart(overrides: Partial<WorkflowChart>): WorkflowChart {
  return { nodes: [], edges: [], ...overrides };
}

describe('graphComplexityInputFromChart', () => {
  it('is zero/zero for a missing or empty chart', () => {
    expect(graphComplexityInputFromChart(null)).toEqual({ nodeCount: 0, edgeCount: 0 });
    expect(graphComplexityInputFromChart(chart({ nodes: [] }))).toEqual({ nodeCount: 0, edgeCount: 0 });
  });

  it('excludes annotation nodes and edges that touch them', () => {
    const input = graphComplexityInputFromChart(
      chart({
        nodes: [
          { id: 'a', name: 'Webhook', type: 'n8n-nodes-base.webhook', x: 0, y: 0 },
          { id: 'b', name: 'Set', type: 'n8n-nodes-base.set', x: 0, y: 0 },
          { id: 'note', name: 'Note', type: 'n8n-nodes-base.stickyNote', x: 0, y: 0, isAnnotation: true },
        ],
        edges: [
          { from: 'Webhook', to: 'Set', kind: 'main' },
          { from: 'Set', to: 'Note', kind: 'main' },
        ],
      }),
    );
    expect(input).toEqual({ nodeCount: 2, edgeCount: 1 });
  });

  it('classifies straight through to a tier for a real-shaped small chart', () => {
    const small = chart({
      nodes: [
        { id: 'a', name: 'Webhook', type: 'n8n-nodes-base.webhook', x: 0, y: 0 },
        { id: 'b', name: 'Set', type: 'n8n-nodes-base.set', x: 0, y: 0 },
      ],
      edges: [{ from: 'Webhook', to: 'Set', kind: 'main' }],
    });
    expect(classifyGraphTier(graphComplexityInputFromChart(small))).toBe('A');
  });
});
