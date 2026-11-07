import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '../../workflow';
import { buildAiCapabilityGraph } from './ai-capability-graph';

function graphOf(nodes: unknown[], connections: Record<string, unknown>) {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return buildAiCapabilityGraph(parsed.workflow);
}

const node = (name: string, type = 'n8n-nodes-base.noOp') => ({ id: name, name, type, parameters: {} });
const attach = (to: string, type: string) => ({ [type]: [[{ node: to, type, index: 0 }]] });

describe('scanner-core AI capability graph', () => {
  it('keeps tool and context attachments directed toward the agent', () => {
    const graph = graphOf([
      node('Agent', '@n8n/n8n-nodes-langchain.agent'), node('Tool'), node('Model'),
    ], { Tool: attach('Agent', 'ai_tool'), Model: attach('Agent', 'ai_languageModel') });
    expect(graph.agents).toEqual([{ nodeIndex: 0, toolNodeIndexes: [1], contextNodeIndexes: [2] }]);
  });

  it('does not fabricate agents from execution or unknown AI edges', () => {
    expect(graphOf([node('A'), node('B')], { A: { main: [[{ node: 'B' }]], ai_chain: [[{ node: 'B' }]] } }).agents)
      .toEqual([]);
  });
});
