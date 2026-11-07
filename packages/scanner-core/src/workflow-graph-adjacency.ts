import type { RawWorkflowEdge } from './workflow-graph';

/** Derive deterministic adjacency indexes without mutating raw graph edges. */
export function successorsByNode(edges: readonly RawWorkflowEdge[]): Map<number, RawWorkflowEdge[]> {
  return groupBy(edges, (edge) => edge.fromNodeIndex);
}

export function predecessorsByNode(edges: readonly RawWorkflowEdge[]): Map<number, RawWorkflowEdge[]> {
  return groupBy(edges, (edge) => edge.toNodeIndex);
}

function groupBy(
  edges: readonly RawWorkflowEdge[],
  key: (edge: RawWorkflowEdge) => number,
): Map<number, RawWorkflowEdge[]> {
  const grouped = new Map<number, RawWorkflowEdge[]>();
  for (const edge of edges) {
    const bucket = grouped.get(key(edge));
    if (bucket) bucket.push(edge);
    else grouped.set(key(edge), [edge]);
  }
  return grouped;
}
