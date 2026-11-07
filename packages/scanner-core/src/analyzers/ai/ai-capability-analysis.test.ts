import { describe, expect, it, vi } from 'vitest';
import { parseWorkflowJson } from '../../workflow';
import { analyzeAiCapabilities } from './ai-capability-analysis';
import { propagateTaint } from '../taint/taint-propagation';
import { amplifyTaint, seedTaintStates } from '../taint/taint-sources';

const webhook = { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} };
const manual = { id: 'm', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} };
const agent = { id: 'a', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', parameters: {} };
const tool = { id: 't', name: 'Tool', type: 'n8n-nodes-base.httpRequestTool', parameters: {} };
const main = (...names: string[]) => ({ main: [names.map((node) => ({ node, type: 'main', index: 0 }))] });
const toolEdge = { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] };

function analyze(nodes: unknown[], connections: Record<string, unknown>) {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  const propagation = propagateTaint(parsed.workflow, seedTaintStates(parsed.workflow), {
    transfer: (nodeIndex, state) => amplifyTaint(parsed.workflow.nodes[nodeIndex].type, state),
  });
  return analyzeAiCapabilities(parsed.workflow, propagation);
}

function largeAiWorkflow(size: number, includeGate: boolean) {
  const nodes = Array.from({ length: size }, (_value, index) => ({
    id: `n${index}`,
    name: index === 0 ? 'Agent' : index === 1 ? 'Tool' : index === size - 1 ? 'Webhook' : index === Math.floor(size / 2) && includeGate ? 'Approval' : `N${index}`,
    type: index === 0 ? agent.type : index === 1 ? tool.type : index === size - 1 ? webhook.type : index === Math.floor(size / 2) && includeGate ? 'n8n-nodes-base.wait' : 'n8n-nodes-base.noOp',
    parameters: index === Math.floor(size / 2) && includeGate ? { resume: 'form' } : {},
  }));
  const connections: Record<string, unknown> = {};
  const nodeName = (index: number) => index === 0 ? 'Agent' : index === 1 ? 'Tool' : index === size - 1 ? 'Webhook' : index === Math.floor(size / 2) && includeGate ? 'Approval' : `N${index}`;
  for (let index = size - 1; index > 0; index -= 1) {
    connections[nodeName(index)] = main(nodeName(index - 1));
  }
  connections.Tool = { ...main('Agent'), ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] };
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  const propagation = propagateTaint(parsed.workflow, seedTaintStates(parsed.workflow), {
    transfer: (nodeIndex, state) => amplifyTaint(parsed.workflow.nodes[nodeIndex].type, state),
  });
  return { workflow: parsed.workflow, propagation };
}

describe('scanner-core AI capability analysis', () => {
  it('isolates an unusable taint coupling as a registered diagnostic instead of raising', () => {
    const parsed = parseWorkflowJson(JSON.stringify({ nodes: [webhook, agent, tool], connections: { Webhook: main('Agent'), Tool: toolEdge } }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);
    // A coupling that does not cover the workflow is a stage failure, never "no taint".
    const result = analyzeAiCapabilities(parsed.workflow, { outputStates: [], updates: 0, maxUpdates: 0, reachedFixedPoint: true, limitExceeded: false });
    expect(result).toEqual({ findings: [], diagnostics: [{ code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY' }] });
  });

  it('completes with no findings when the taint stage published no coupling', () => {
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes: [manual, agent, tool],
      connections: { Start: main('Agent'), Tool: toolEdge },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(analyzeAiCapabilities(parsed.workflow, undefined)).toEqual({ findings: [], diagnostics: [] });
  });

  it('reports an ungated tool-capable agent receiving taint', () => {
    const result = analyze([webhook, agent, tool], { Webhook: main('Agent'), Tool: toolEdge });
    expect(result.findings).toEqual([expect.objectContaining({
      policyId: 'AI_AGENT_UNGATED_TOOL', confidence: 'LOW',
      location: expect.objectContaining({ nodeId: 'a', nodeName: 'Agent' }),
      evidence: expect.objectContaining({
        toolCount: 1, humanGatePresent: false, humanGateDominates: false,
        taintLabels: ['WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER'],
      }),
    })]);
  });

  it('suppresses only when a catalogued human gate dominates every path', () => {
    const gated = analyze([
      webhook, agent, tool,
      { id: 'g', name: 'Approval', type: 'n8n-nodes-base.wait', parameters: { resume: 'form' } },
    ], { Webhook: main('Approval'), Approval: main('Agent'), Tool: toolEdge });
    expect(gated.findings).toEqual([]);
    expect(gated.diagnostics).toEqual([]);

    const bypassed = analyze([
      webhook, agent, tool,
      { id: 'g', name: 'Approval', type: 'n8n-nodes-base.wait', parameters: { resume: 'form' } },
      { id: 's', name: 'Side', type: 'n8n-nodes-base.noOp', parameters: {} },
    ], { Webhook: main('Agent', 'Approval'), Approval: main('Side'), Tool: toolEdge });
    expect(bypassed.findings).toHaveLength(1);
    expect(bypassed.findings[0].evidence).toMatchObject({ humanGatePresent: true, humanGateDominates: false });
  });

  it('does not trust an uncatalogued send-and-wait claim', () => {
    const result = analyze([
      webhook, agent, tool,
      { id: 'g', name: 'Not approval', type: 'n8n-nodes-base.noOp', parameters: { operation: 'sendAndWait' } },
    ], { Webhook: main('Not approval'), 'Not approval': main('Agent'), Tool: toolEdge });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence).toMatchObject({ humanGatePresent: false });
  });

  it('does not construct dominators for an ungated legal 5,000-node workflow', async () => {
    const { workflow, propagation } = largeAiWorkflow(5_000, false);
    const computeDominators = vi.fn();
    vi.resetModules();
    vi.doMock('../../graph-dominators', async (importOriginal) => ({
      ...(await importOriginal()),
      computeExecutionDominators: computeDominators,
    }));
    try {
      const analysisModule = await import('./ai-capability-analysis');
      const result = analysisModule.analyzeAiCapabilities(workflow, propagation);
      expect(computeDominators).not.toHaveBeenCalled();
      expect(result.diagnostics).toEqual([]);
      expect(result.findings).toHaveLength(1);
    } finally {
      vi.doUnmock('../../graph-dominators');
      vi.resetModules();
    }
  });

  it('pins the complete-to-degraded delta when a legal gated 5,000-node graph exhausts dominator work', () => {
    const baseline = analyze([
      webhook, agent, tool,
      { id: 'g', name: 'Approval', type: 'n8n-nodes-base.wait', parameters: { resume: 'form' } },
    ], { Webhook: main('Approval'), Approval: main('Agent'), Tool: toolEdge });
    const { workflow, propagation } = largeAiWorkflow(5_000, true);
    const OriginalSet = globalThis.Set;
    class GuardedSet<T> extends OriginalSet<T> {
      constructor(values?: readonly T[] | Iterable<T>) {
        if (Array.isArray(values) && values.length > 64) throw new Error('quadratic dominator Set allocation');
        super(values);
      }
    }
    vi.stubGlobal('Set', GuardedSet);
    let result;
    try {
      result = analyzeAiCapabilities(workflow, propagation);
    } finally {
      vi.unstubAllGlobals();
    }
    expect({
      complete: { findings: baseline.findings, diagnostics: baseline.diagnostics },
      guarded: { findings: result.findings, diagnostics: result.diagnostics },
    }).toEqual({
      complete: { findings: [], diagnostics: [] },
      guarded: { findings: [], diagnostics: [{ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' }] },
    });
  });
});
