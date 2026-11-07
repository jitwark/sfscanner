import type { NormalizedWorkflow } from '../../workflow';
import type { RawWorkflowEdge } from '../../workflow-graph';

export type AgentAttachments = {
  nodeIndex: number;
  toolNodeIndexes: number[];
  contextNodeIndexes: number[];
};
export type AiCapabilityGraph = { agents: AgentAttachments[] };

export function buildAiCapabilityGraph(workflow: NormalizedWorkflow): AiCapabilityGraph {
  const tools = attachmentsByAgent(workflow.graph.views.capability);
  const contexts = attachmentsByAgent(workflow.graph.views.context);
  const agentIndexes = [...new Set([...tools.keys(), ...contexts.keys()])].sort(ascending);
  return {
    agents: agentIndexes.map((nodeIndex) => ({
      nodeIndex,
      toolNodeIndexes: sortedUnique(tools.get(nodeIndex)),
      contextNodeIndexes: sortedUnique(contexts.get(nodeIndex)),
    })),
  };
}

function attachmentsByAgent(edges: readonly RawWorkflowEdge[]): Map<number, number[]> {
  const grouped = new Map<number, number[]>();
  for (const edge of edges) {
    const bucket = grouped.get(edge.toNodeIndex);
    if (bucket) bucket.push(edge.fromNodeIndex);
    else grouped.set(edge.toNodeIndex, [edge.fromNodeIndex]);
  }
  return grouped;
}

function sortedUnique(indexes: number[] | undefined): number[] {
  return [...new Set(indexes ?? [])].sort(ascending);
}

function ascending(left: number, right: number): number {
  return left - right;
}
