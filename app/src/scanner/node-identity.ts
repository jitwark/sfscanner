import type { NormalizedWorkflowNode } from '@hub/scanner-core/workflow';

/** Returns ids shared by more than one normalized node. */
export function collectAmbiguousNodeIds(
  nodes: ReadonlyArray<Pick<NormalizedWorkflowNode, 'id'>>,
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}
