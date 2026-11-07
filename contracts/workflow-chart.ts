import type { ChartEdge, ChartNode, WorkflowChart } from './index';

export const MAX_CHART_NODES = 5_000;
export const MAX_CHART_EDGES = 10_000;
const MAX_CHART_TEXT_CHARS = 2_048;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_CHART_TEXT_CHARS;
}

/** Validates and narrows one bounded workflow chart payload for the browser renderer. */
export function parseWorkflowChart(value: unknown): WorkflowChart | null {
  const candidate = record(value);
  if (!candidate || !Array.isArray(candidate.nodes) || candidate.nodes.length > MAX_CHART_NODES ||
    !Array.isArray(candidate.edges) || candidate.edges.length > MAX_CHART_EDGES) return null;

  const nodes: ChartNode[] = [];
  for (const raw of candidate.nodes) {
    const node = record(raw);
    if (!node || !text(node.id) || node.id.length === 0 || !text(node.name) || !text(node.type) ||
      typeof node.x !== 'number' || !Number.isFinite(node.x) ||
      typeof node.y !== 'number' || !Number.isFinite(node.y) ||
      (node.isAnnotation !== undefined && typeof node.isAnnotation !== 'boolean')) return null;
    nodes.push({
      id: node.id,
      name: node.name,
      type: node.type,
      x: node.x,
      y: node.y,
      ...(node.isAnnotation === undefined ? {} : { isAnnotation: node.isAnnotation }),
    });
  }

  const edges: ChartEdge[] = [];
  for (const raw of candidate.edges) {
    const edge = record(raw);
    if (!edge || !text(edge.from) || !text(edge.to) || !text(edge.kind)) return null;
    edges.push({ from: edge.from, to: edge.to, kind: edge.kind });
  }

  const unresolvedEdgeCount = candidate.unresolvedEdgeCount;
  if (unresolvedEdgeCount !== undefined &&
    (typeof unresolvedEdgeCount !== 'number' || !Number.isSafeInteger(unresolvedEdgeCount) || unresolvedEdgeCount < 0)) return null;
  return {
    nodes,
    edges,
    ...(unresolvedEdgeCount === undefined ? {} : { unresolvedEdgeCount }),
  };
}
