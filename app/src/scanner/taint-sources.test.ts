import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { bottomTaintState, createTaintState, orderedTaintLabels } from '@hub/scanner-core/analyzers/taint/taint-lattice';
import { amplifyTaint, seedTaintStates } from '@hub/scanner-core/analyzers/taint/taint-sources';

function seedLabels(nodes: unknown[]): string[][] {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections: {} }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return seedTaintStates(parsed.workflow).map(orderedTaintLabels);
}

const node = (type: string, id = 'n1') => ({ id, name: id, type, parameters: {} });

describe('amplifyTaint', () => {
  const tainted = createTaintState(['WEBHOOK_BODY'], []);

  it('adds model output to an AI node that received untrusted input', () => {
    expect(orderedTaintLabels(amplifyTaint('@n8n/n8n-nodes-langchain.agent', tainted)))
      .toEqual(['WEBHOOK_BODY', 'AI_MODEL_OUTPUT']);
  });

  it('adds nothing to an AI node whose input is clean', () => {
    expect(orderedTaintLabels(amplifyTaint('@n8n/n8n-nodes-langchain.agent', bottomTaintState))).toEqual([]);
  });

  it('adds nothing to a node that is not an AI node', () => {
    expect(orderedTaintLabels(amplifyTaint('n8n-nodes-base.set', tainted))).toEqual(['WEBHOOK_BODY']);
  });
});

describe('seedTaintStates', () => {
  it('seeds a webhook trigger with its three untrusted surfaces', () => {
    expect(seedLabels([node('n8n-nodes-base.webhook')])).toEqual([
      ['WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER'],
    ]);
  });

  it('seeds nothing for a node type the source table does not list', () => {
    expect(seedLabels([node('n8n-nodes-base.set'), node('n8n-nodes-base.manualTrigger', 'n2')]))
      .toEqual([[], []]);
  });

  it('treats an HTTP response and a read file as untrusted input', () => {
    expect(seedLabels([node('n8n-nodes-base.httpRequest'), node('n8n-nodes-base.extractFromFile', 'n2')]))
      .toEqual([['EXTERNAL_HTTP_RESPONSE'], ['EXTERNAL_FILE']]);
  });

  it('does not seed an agent, because model output is only tainted when its input was', () => {
    expect(seedLabels([node('@n8n/n8n-nodes-langchain.agent')])).toEqual([[]]);
  });

  it('seeds an inbound message trigger', () => {
    expect(seedLabels([node('n8n-nodes-base.emailReadImap')])).toEqual([['INBOUND_MESSAGE']]);
  });

  it('leaves a seeded state sanitized for nothing', () => {
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes: [node('n8n-nodes-base.webhook')], connections: {},
    }));
    if (!parsed.ok) throw new Error(parsed.message);

    expect([...seedTaintStates(parsed.workflow)[0].sanitizedFor]).toEqual([]);
  });

  it('leaves an unseeded node at the join identity so it contributes nothing', () => {
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes: [node('n8n-nodes-base.set')], connections: {},
    }));
    if (!parsed.ok) throw new Error(parsed.message);
    const state = seedTaintStates(parsed.workflow)[0];

    expect(state.labels.size).toBe(0);
    expect(state.sanitizedFor.size).toBeGreaterThan(0);
  });
});
