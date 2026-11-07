import type { RawWorkflowEdge, WorkflowGraphViews } from './workflow-graph';

const EXECUTION_TYPES = new Set(['main']);
const CAPABILITY_TYPES = new Set(['ai_tool']);
const CONTEXT_TYPES = new Set([
  'ai_document',
  'ai_embedding',
  'ai_languageModel',
  'ai_memory',
  'ai_outputParser',
  'ai_retriever',
  'ai_reranker',
  'ai_textSplitter',
  'ai_vectorStore',
]);

/** Classify edges only when their connection type has been reviewed. */
export function deriveGraphViews(edges: readonly RawWorkflowEdge[]): WorkflowGraphViews {
  return {
    execution: edges.filter((edge) => EXECUTION_TYPES.has(edge.connectionType)),
    capability: edges.filter((edge) => CAPABILITY_TYPES.has(edge.connectionType)),
    context: edges.filter((edge) => CONTEXT_TYPES.has(edge.connectionType)),
    unknown: edges.filter((edge) => !EXECUTION_TYPES.has(edge.connectionType)
      && !CAPABILITY_TYPES.has(edge.connectionType)
      && !CONTEXT_TYPES.has(edge.connectionType)),
  };
}
