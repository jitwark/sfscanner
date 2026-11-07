import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WorkflowChart } from '@hub/contracts';
import { renderStaticSvgPreview, SVG_PREVIEW_SCHEMA_VERSION } from './svg-preview.js';

const FORBIDDEN = [/<script/i, /foreignObject/i, /\son\w+\s*=/i, /javascript:/i, /<image/i, /xlink:href/i, /\shref\s*=/i];

function makeChart(nodeCount: number, extra?: Partial<WorkflowChart>): WorkflowChart {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `id-${i}`,
    name: `Node ${i}`,
    type: i % 2 === 0 ? 'n8n-nodes-base.httpRequest' : 'n8n-nodes-base.code',
    x: i * 220,
    y: 0,
  }));
  const edges = nodes.slice(1).map((n, i) => ({ from: `id-${i}`, to: n.id, kind: 'main' }));
  return { nodes, edges, ...extra };
}

describe('renderStaticSvgPreview', () => {
  it('is stable across repeated builds given the same input', () => {
    const chart = makeChart(3);
    const first = renderStaticSvgPreview(chart);
    const second = renderStaticSvgPreview(chart);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.svg).toBe(second.svg);
  });

  it('produces a different hash for different content', () => {
    const a = renderStaticSvgPreview(makeChart(3));
    const b = renderStaticSvgPreview(makeChart(4));
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('stamps the schema version and tier', () => {
    const result = renderStaticSvgPreview(makeChart(3));
    expect(result.schemaVersion).toBe(SVG_PREVIEW_SCHEMA_VERSION);
    expect(result.tier).toBe('A');
  });

  it('carries a stable viewBox on the root element, with no fixed pixel size forcing overflow', () => {
    const result = renderStaticSvgPreview(makeChart(5));
    const rootTag = result.svg.match(/^<svg[^>]*>/)?.[0] ?? '';
    expect(rootTag).toMatch(/viewBox="0 0 \d+ \d+"/);
    expect(rootTag).not.toMatch(/\swidth=/);
    expect(rootTag).not.toMatch(/\sheight=/);
  });

  it('escapes hostile node names instead of emitting them raw', () => {
    const chart = makeChart(1, {
      nodes: [{ id: 'id-0', name: '</text><script>alert(1)</script>&"\'', type: 'n8n-nodes-base.code', x: 0, y: 0 }],
      edges: [],
    });
    const result = renderStaticSvgPreview(chart);
    for (const pattern of FORBIDDEN) expect(result.svg).not.toMatch(pattern);
    expect(result.svg).toContain('&lt;/text&gt;&lt;script&gt;');
  });

  it('never emits a script, foreignObject, event handler, or remote reference at any tier', () => {
    for (const count of [1, 40, 100]) {
      const result = renderStaticSvgPreview(makeChart(count));
      for (const pattern of FORBIDDEN) expect(result.svg).not.toMatch(pattern);
    }
  });

  it('truncates long labels and counts the truncations', () => {
    const chart = makeChart(1, {
      nodes: [{ id: 'id-0', name: 'A'.repeat(200), type: 'n8n-nodes-base.code', x: 0, y: 0 }],
      edges: [],
    });
    const result = renderStaticSvgPreview(chart);
    expect(result.truncatedLabelCount).toBe(1);
    expect(result.svg).toContain('…');
    expect(result.svg).not.toContain('A'.repeat(200));
  });

  it('renders every node as a distinct element at tier A/B', () => {
    const result = renderStaticSvgPreview(makeChart(10));
    expect(result.tier).toBe('A');
    expect(result.nodeList).toHaveLength(10);
    expect(result.elementCount).toBeGreaterThanOrEqual(10);
  });

  it('falls back to a bounded category map once the graph exceeds the tier ceiling, without dropping any node from the list', () => {
    const result = renderStaticSvgPreview(makeChart(120));
    expect(result.tier).toBe('C');
    expect(result.nodeList).toHaveLength(120);
    // Bounded: a map of category summaries, not one shape per node.
    expect(result.elementCount).toBeLessThan(120);
  });

  it('surfaces unresolved connections rather than silently dropping them', () => {
    const chart = makeChart(2, { unresolvedEdgeCount: 3 });
    const result = renderStaticSvgPreview(chart);
    expect(result.unresolvedEdgeCount).toBe(3);
  });

  it('returns a finite invalid-tier result for an empty or malformed chart, never a crash', () => {
    const empty = renderStaticSvgPreview({ nodes: [], edges: [] });
    expect(empty.tier).toBe('invalid');
    expect(empty.nodeList).toHaveLength(0);
    expect(Number.isFinite(empty.width)).toBe(true);
    expect(Number.isFinite(empty.height)).toBe(true);
    expect(() => renderStaticSvgPreview(null as unknown as WorkflowChart)).not.toThrow();
  });

  it('keeps dimensions finite and positive for malformed coordinates', () => {
    const chart = makeChart(2, {
      nodes: [
        { id: 'id-0', name: 'A', type: 'n8n-nodes-base.code', x: Number.NaN, y: Number.NaN },
        { id: 'id-1', name: 'B', type: 'n8n-nodes-base.code', x: 0, y: 0 },
      ],
    });
    const result = renderStaticSvgPreview(chart);
    expect(Number.isFinite(result.width)).toBe(true);
    expect(Number.isFinite(result.height)).toBe(true);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  it('hashes the invalid fallback SVG and bounds skewed category bars', () => {
    const invalid = renderStaticSvgPreview(null as unknown as WorkflowChart);
    expect(invalid.contentHash).toBe(createHash('sha256').update(invalid.svg, 'utf8').digest('hex'));

    const extreme = makeChart(120, {
      nodes: [
        ...Array.from({ length: 119 }, (_, index) => ({ id: `id-${index}`, name: `HTTP ${index}`, type: 'n8n-nodes-base.httpRequest', x: 0, y: 0 })),
        { id: 'id-119', name: 'Code', type: 'n8n-nodes-base.code', x: 0, y: 0 },
      ],
      edges: [],
    });
    const preview = renderStaticSvgPreview(extreme);
    expect(preview.svg).not.toMatch(/y="-/);
  });
});
