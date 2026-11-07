import type { NormalizedWorkflow } from '../../workflow';
import { predecessorsByNode, successorsByNode } from '../../workflow-graph-adjacency';
import { bottomTaintState, isTainted, type TaintState } from './taint-lattice';

export const MAX_TRACE_DEPTH = 64;
export type TaintTrace = { sourceNodeIndex: number; path: number[] };

export function buildTaintTraces(workflow: NormalizedWorkflow, seeds: readonly TaintState[]): Map<number, TaintTrace> {
  const successors = successorsByNode(workflow.graph.views.execution);
  const traces = new Map<number, TaintTrace>();
  const sourceIndexes = workflow.nodes.map((_node, index) => index)
    .filter((index) => isTainted(seeds[index] ?? bottomTaintState));
  for (const sourceNodeIndex of sourceIndexes) {
    if (traces.has(sourceNodeIndex)) continue;
    traces.set(sourceNodeIndex, { sourceNodeIndex, path: [sourceNodeIndex] });
    const queue: number[] = [sourceNodeIndex];
    while (queue.length > 0) {
      const current = queue.shift() as number;
      const path = traces.get(current)?.path ?? [];
      if (path.length >= MAX_TRACE_DEPTH) continue;
      for (const edge of successors.get(current) ?? []) {
        if (traces.has(edge.toNodeIndex)) continue;
        traces.set(edge.toNodeIndex, { sourceNodeIndex, path: [...path, edge.toNodeIndex] });
        queue.push(edge.toNodeIndex);
      }
    }
  }
  return traces;
}

export function upstreamNodeIndexes(workflow: NormalizedWorkflow, nodeIndex: number): Set<number> {
  const predecessors = predecessorsByNode(workflow.graph.views.execution);
  const reached = new Set<number>();
  const queue = [nodeIndex];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const edge of predecessors.get(current) ?? []) {
      if (reached.has(edge.fromNodeIndex)) continue;
      reached.add(edge.fromNodeIndex);
      queue.push(edge.fromNodeIndex);
    }
  }
  reached.delete(nodeIndex);
  return reached;
}
