import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '../../workflow';
import { analyzeAiCapabilities } from '../ai/ai-capability-analysis';
import { bottomTaintState, createTaintState, orderedTaintLabels, type TaintLabel, type TaintState } from './taint-lattice';
import { incomingTaint, propagateTaint } from './taint-propagation';
import { amplifyTaint, seedTaintStates } from './taint-sources';

const webhook = { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} };
const manual = { id: 'm', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} };
const agent = { id: 'a', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', parameters: {} };
const tool = { id: 't', name: 'Tool', type: 'n8n-nodes-base.httpRequestTool', parameters: {} };
const main = (...names: string[]) => ({ main: [names.map((node) => ({ node, type: 'main', index: 0 }))] });
const toolEdge = { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] };

function fixture(trigger: unknown, triggerName: string) {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes: [trigger, agent, tool], connections: { [triggerName]: main('Agent'), Tool: toolEdge } }));
  if (!parsed.ok) throw new Error(parsed.message);
  const workflow = parsed.workflow;
  const seeds = seedTaintStates(workflow);
  const propagation = propagateTaint(workflow, seeds, { transfer: (index, state) => amplifyTaint(workflow.nodes[index].type, state) });
  return { workflow, seeds, propagation };
}

const attempt = (mutate: () => void): void => { try { mutate(); } catch { /* a published value rejects the mutation */ } };
const taintLabelsOf = (state: TaintState): Set<TaintLabel> => state.labels as unknown as Set<TaintLabel>;

describe('published taint value', () => {
  it('owns its states, so a later mutation of the producer state cannot change AI findings', () => {
    const tainted = fixture(webhook, 'Webhook');
    const clean = fixture(manual, 'Start');
    const beforeTainted = analyzeAiCapabilities(tainted.workflow, tainted.propagation);
    const beforeClean = analyzeAiCapabilities(clean.workflow, clean.propagation);
    expect(beforeTainted.findings).toHaveLength(1);
    expect(beforeClean.findings).toHaveLength(0);
    const sharedBottomLabels = [...bottomTaintState.labels];
    try {
      // The vector no longer accepts a replacement, and the states it published no longer alias the
      // caller's seeds or the shared bottom identity that every unseeded node used to point at.
      attempt(() => { (tainted.propagation.outputStates as TaintState[])[0] = createTaintState([], []); });
      attempt(() => { taintLabelsOf(tainted.seeds[0]!).add('AI_MODEL_OUTPUT'); });
      attempt(() => { taintLabelsOf(bottomTaintState).add('INBOUND_MESSAGE'); });

      expect(analyzeAiCapabilities(tainted.workflow, tainted.propagation)).toEqual(beforeTainted);
      expect(analyzeAiCapabilities(clean.workflow, clean.propagation)).toEqual(beforeClean);
      expect(orderedTaintLabels(tainted.propagation.outputStates[0]!)).toEqual(['WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER']);
      expect(orderedTaintLabels(clean.propagation.outputStates[0]!)).toEqual([]);
    } finally {
      taintLabelsOf(bottomTaintState).clear();
      for (const label of sharedBottomLabels) taintLabelsOf(bottomTaintState).add(label);
    }
    expect(Object.isFrozen(tainted.propagation)).toBe(true);
    expect(Object.isFrozen(tainted.propagation.outputStates)).toBe(true);
    expect(Object.isFrozen(tainted.propagation.outputStates[0])).toBe(true);
    expect(tainted.propagation.outputStates[0]).not.toBe(tainted.seeds[0]);
  });

  it('hands a predecessor-free node an owned bottom state, never the shared identity', () => {
    const parsed = parseWorkflowJson(JSON.stringify({ nodes: [agent, tool], connections: { Tool: toolEdge } }));
    if (!parsed.ok) throw new Error(parsed.message);
    const propagation = propagateTaint(parsed.workflow, seedTaintStates(parsed.workflow), { transfer: (index, state) => amplifyTaint(parsed.workflow.nodes[index].type, state) });
    const incoming = incomingTaint(propagation, parsed.workflow, 0, 0);
    expect(incoming).not.toBe(bottomTaintState);
    expect(orderedTaintLabels(incoming)).toEqual([]);
  });
});

describe('work queue cursor', () => {
  it('drains the work queue in the same order a shifting queue would', () => {
    // Webhook -> Agent -> (Webhook, HTTP): the Agent amplifies taint, the back edge re-enqueues
    // the already-dequeued Webhook, and the duplicate Agent enqueue is suppressed. Recording the
    // transfer callback captures the exact dequeue sequence, so a cursor that reordered the queue
    // would change it.
    const nodes = [
      { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
      { id: 'a', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', parameters: {} },
      { id: 'h', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', parameters: {} },
    ];
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes,
      connections: { Webhook: main('Agent'), Agent: main('Webhook', 'HTTP') },
    }));
    if (!parsed.ok) throw new Error(parsed.message);
    const workflow = parsed.workflow;
    const order: number[] = [];
    propagateTaint(workflow, seedTaintStates(workflow), {
      transfer: (index, state) => { order.push(index); return amplifyTaint(workflow.nodes[index].type, state); },
    });

    expect(order).toEqual([0, 1, 2, 0, 1]);
  });

  it('keeps the dequeue off Array.prototype.shift', () => {
    // Narrow source-shape guard: the behavioural drain-order test above cannot observe the cost of
    // the dequeue, so also assert the O(n) `shift()` path is gone and the O(1) cursor is in place.
    const source = readFileSync(new URL('./taint-propagation.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/queue\.shift\s*\(/);
    expect(source).toMatch(/queue\[head\]/);
  });
});
