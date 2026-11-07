import { describe, expect, it } from 'vitest';
import { parseWorkflowJson, type NormalizedWorkflow } from '@hub/scanner-core/workflow';
import { analyzeAiCapabilities } from '@hub/scanner-core/analyzers/ai/ai-capability-analysis';
import { analyzeWorkflowTaint } from '@hub/scanner-core/analyzers/taint/taint-analysis';

const webhook = { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} };
const agent = { id: 'a', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', parameters: {} };
const tool = { id: 't', name: 'Tool', type: 'n8n-nodes-base.httpRequestTool', parameters: {} };
const wait = {
  id: 'g',
  name: 'Approval',
  type: 'n8n-nodes-base.wait',
  parameters: { resume: 'form' },
};
const main = (...names: string[]) => ({ main: [names.map((node) => ({ node, type: 'main', index: 0 }))] });
const toolEdge = { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] };

function analyze(nodes: unknown[], connections: Record<string, unknown>) {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  const workflow: NormalizedWorkflow = parsed.workflow;
  const propagation = analyzeWorkflowTaint(workflow).propagation;
  // The production adapter intentionally skips the AI stage when no source
  // seeds taint, so the core analyzer never receives an absent propagation.
  if (propagation === undefined) return { findings: [], diagnostics: [] };
  return analyzeAiCapabilities(workflow, propagation);
}

describe('analyzeAiCapabilities', () => {
  it('reports an agent that holds tools and receives untrusted input with no gate', () => {
    const result = analyze([webhook, agent, tool], { Webhook: main('Agent'), Tool: toolEdge });

    expect(result.findings).toEqual([expect.objectContaining({
      policyId: 'AI_AGENT_UNGATED_TOOL',
      confidence: 'LOW',
      location: expect.objectContaining({ nodeName: 'Agent' }),
      evidence: expect.objectContaining({
        toolCount: 1,
        humanGatePresent: false,
        humanGateDominates: false,
        taintLabels: ['WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER'],
      }),
    })]);
  });

  it('reports nothing when a gate stands on every path into the agent', () => {
    const result = analyze([webhook, agent, tool, wait], {
      Webhook: main('Approval'), Approval: main('Agent'), Tool: toolEdge,
    });

    expect(result.findings).toEqual([]);
  });

  it('still reports when the gate only stands on a parallel branch', () => {
    const result = analyze(
      [webhook, agent, tool, wait, { id: 's', name: 'Side', type: 'n8n-nodes-base.noOp', parameters: {} }],
      { Webhook: main('Agent', 'Approval'), Approval: main('Side'), Tool: toolEdge },
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence).toMatchObject({ humanGatePresent: true, humanGateDominates: false });
  });

  it('treats a send-and-wait operation as a gate', () => {
    const result = analyze(
      [webhook, agent, tool, { id: 'g', name: 'Ask', type: 'n8n-nodes-base.slack', parameters: { operation: 'sendAndWait' } }],
      { Webhook: main('Ask'), Ask: main('Agent'), Tool: toolEdge },
    );

    expect(result.findings).toEqual([]);
  });

  // A suppression must be positively justified. Before the reviewed catalog,
  // any node of any type could claim `operation: 'sendAndWait'` and silence the
  // finding, so a submitted workflow could switch off the control by asserting
  // it was already satisfied.
  it('does not treat an uncatalogued node type claiming send-and-wait as a gate', () => {
    const result = analyze(
      [webhook, agent, tool, {
        id: 'g',
        name: 'Not really an approval',
        type: 'n8n-nodes-base.noOp',
        parameters: { operation: 'sendAndWait' },
      }],
      { Webhook: main('Not really an approval'), 'Not really an approval': main('Agent'), Tool: toolEdge },
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence).toMatchObject({ humanGatePresent: false });
  });

  // Verified against n8n's Wait node at 1aa604d2: `resume` is one of
  // timeInterval, specificTime, webhook, form. A timed wait pauses execution and
  // proves nothing about human review.
  it.each(['timeInterval', 'specificTime', undefined])(
    'does not treat a wait resuming on %s as a gate',
    (resume) => {
      const result = analyze(
        [webhook, agent, tool, {
          id: 'g',
          name: 'Approval',
          type: 'n8n-nodes-base.wait',
          parameters: resume === undefined ? {} : { resume },
        }],
        { Webhook: main('Approval'), Approval: main('Agent'), Tool: toolEdge },
      );

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].evidence).toMatchObject({ humanGatePresent: false });
    },
  );

  it('reports nothing for an agent that holds no tool', () => {
    const result = analyze([webhook, agent, { id: 'm', name: 'Model', type: 'x', parameters: {} }], {
      Webhook: main('Agent'),
      Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
    });

    expect(result.findings).toEqual([]);
  });

  it('does not report a tool finding for a Code-to-Code ai_chain edge', () => {
    const result = analyze(
      [webhook,
        { id: 's', name: 'Code source', type: 'n8n-nodes-base.code', parameters: {} },
        { id: 't', name: 'Code target', type: 'n8n-nodes-base.code', parameters: {} }],
      {
        Webhook: main('Code source'),
        'Code source': {
          main: [[{ node: 'Code target', type: 'main', index: 0 }]],
          ai_chain: [[{ node: 'Code target', type: 'ai_chain', index: 0 }]],
        },
      },
    );

    expect(result.findings).toEqual([]);
  });

  it('reports nothing for an agent chain fed only by a trusted trigger', () => {
    // Model output is only attacker-influenced when the model's input was, so
    // an agent feeding another agent is not by itself an untrusted source.
    const result = analyze(
      [{ id: 'm', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
        { id: 'a', name: 'AgentA', type: '@n8n/n8n-nodes-langchain.agent', parameters: {} },
        { id: 'b', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', parameters: {} }, tool],
      {
        Manual: main('AgentA'),
        AgentA: main('Agent'),
        Tool: toolEdge,
      },
    );

    expect(result.findings).toEqual([]);
  });

  it('still reports an agent chain that starts from untrusted input', () => {
    const result = analyze(
      [webhook,
        { id: 'a', name: 'AgentA', type: '@n8n/n8n-nodes-langchain.agent', parameters: {} },
        { id: 'b', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', parameters: {} }, tool],
      { Webhook: main('AgentA'), AgentA: main('Agent'), Tool: toolEdge },
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence).toMatchObject({
      taintLabels: expect.arrayContaining(['AI_MODEL_OUTPUT']),
    });
  });

  it('reports nothing when no untrusted data reaches the agent', () => {
    const result = analyze(
      [{ id: 'm', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', parameters: {} }, agent, tool],
      { Manual: main('Agent'), Tool: toolEdge },
    );

    expect(result.findings).toEqual([]);
  });
});
