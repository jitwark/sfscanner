import { describe, expect, it } from 'vitest';
import { parseWorkflowJson, type NormalizedWorkflow } from '@hub/scanner-core/workflow';
import { orderedTaintLabels } from '@hub/scanner-core/analyzers/taint/taint-lattice';
import { incomingTaint, propagateTaint } from '@hub/scanner-core/analyzers/taint/taint-propagation';
import { amplifyTaint, seedTaintStates } from '@hub/scanner-core/analyzers/taint/taint-sources';

function workflowOf(nodes: unknown[], connections: Record<string, unknown>): NormalizedWorkflow {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.workflow;
}

const webhook = { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} };
const set = (name: string) => ({ id: name, name, type: 'n8n-nodes-base.set', parameters: {} });
const main = (to: string, index = 0) => ({ main: [[{ node: to, type: 'main', index }]] });

function propagate(workflow: NormalizedWorkflow, maxUpdates?: number) {
  return propagateTaint(workflow, seedTaintStates(workflow), {
    maxUpdates,
    transfer: (nodeIndex, state) => amplifyTaint(workflow.nodes[nodeIndex].type, state),
  });
}

const agent = (name: string) => ({ id: name, name, type: '@n8n/n8n-nodes-langchain.agent', parameters: {} });

describe('propagateTaint', () => {
  it('carries taint forward along a linear execution chain', () => {
    const workflow = workflowOf([webhook, set('A'), set('B')], {
      Webhook: main('A'), A: main('B'),
    });

    const result = propagate(workflow);

    expect(result.outputStates.map(orderedTaintLabels)).toEqual([
      ['WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER'],
      ['WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER'],
      ['WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER'],
    ]);
    expect(result.reachedFixedPoint).toBe(true);
    expect(result.limitExceeded).toBe(false);
  });

  it('converges on a cycle instead of exhausting its budget', () => {
    const workflow = workflowOf([webhook, set('A'), set('B'), set('C')], {
      Webhook: main('A'), A: main('B'), B: main('C'), C: main('A'),
    });

    const result = propagate(workflow);

    expect(result.reachedFixedPoint).toBe(true);
    expect(result.limitExceeded).toBe(false);
    expect(result.updates).toBeLessThan(result.maxUpdates);
    for (const state of result.outputStates) expect(orderedTaintLabels(state)).toContain('WEBHOOK_BODY');
  });

  it('does not carry taint over capability or context edges', () => {
    const workflow = workflowOf([webhook, set('Agent')], {
      Webhook: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
    });

    expect(orderedTaintLabels(propagate(workflow).outputStates[1])).toEqual([]);
  });

  it('reports budget exhaustion instead of a silent partial result', () => {
    const workflow = workflowOf([webhook, set('A'), set('B')], { Webhook: main('A'), A: main('B') });

    const result = propagate(workflow, 1);

    expect(result.limitExceeded).toBe(true);
    expect(result.reachedFixedPoint).toBe(false);
  });
});

describe('transfer', () => {
  it('adds model output at an agent that received untrusted input', () => {
    const workflow = workflowOf([webhook, agent('Agent')], { Webhook: main('Agent') });

    expect(orderedTaintLabels(propagate(workflow).outputStates[1])).toContain('AI_MODEL_OUTPUT');
  });

  it('adds nothing at an agent chain fed only by a trusted trigger', () => {
    const workflow = workflowOf(
      [{ id: 'm', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', parameters: {} }, agent('A'), agent('B')],
      { Manual: main('A'), A: main('B') },
    );
    const result = propagate(workflow);

    expect(result.outputStates.map(orderedTaintLabels)).toEqual([[], [], []]);
    expect(result.reachedFixedPoint).toBe(true);
  });
});

describe('incomingTaint', () => {
  it('reads only the branch wired to the requested input index', () => {
    const workflow = workflowOf([webhook, set('Clean'), set('Merge')], {
      Webhook: { main: [[{ node: 'Merge', type: 'main', index: 1 }]] },
      Clean: { main: [[{ node: 'Merge', type: 'main', index: 0 }]] },
    });
    const result = propagate(workflow);

    expect(orderedTaintLabels(incomingTaint(result, workflow, 2, 0))).toEqual([]);
    expect(orderedTaintLabels(incomingTaint(result, workflow, 2, 1))).toContain('WEBHOOK_BODY');
  });

  it('is untainted for a node with no execution predecessor', () => {
    const workflow = workflowOf([webhook, set('Orphan')], {});
    const result = propagate(workflow);

    expect(orderedTaintLabels(incomingTaint(result, workflow, 1, 0))).toEqual([]);
  });

  it('joins several predecessors wired to the same input index', () => {
    const workflow = workflowOf([webhook, set('Http'), set('Target')], {
      Webhook: main('Target'), Http: main('Target'),
    });
    const result = propagate(workflow);

    expect(orderedTaintLabels(incomingTaint(result, workflow, 2, 0))).toContain('WEBHOOK_BODY');
  });
});
