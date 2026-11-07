import { describe, expect, it } from 'vitest';
import {
  classifyComplexity,
  complexityWeight,
  summarizeIntegrations,
} from '@hub/scanner-core/workflow-insights';
import type { NormalizedWorkflowNode } from './workflow';

function node(type: string, id = type): NormalizedWorkflowNode {
  return { id, name: id, type, parameters: {}, sourcePath: '' };
}

describe('workflow insight helpers', () => {
  it.each([
    ['LOW', 5, 7, 3, 0],
    ['MEDIUM', 6, 7, 3, 10],
    ['MEDIUM', 5, 8, 3, 10],
    ['MEDIUM', 5, 7, 4, 10],
    ['HIGH', 15, 7, 3, 20],
    ['HIGH', 5, 20, 3, 20],
    ['HIGH', 5, 7, 8, 20],
  ] as const)('uses the documented %s threshold boundary', (expected, nodes, edges, integrations, weight) => {
    const complexity = classifyComplexity(nodes, edges, integrations);

    expect(complexity).toBe(expected);
    expect(complexityWeight(complexity)).toBe(weight);
  });

  it('summarizes representative integrations in stable service order', () => {
    expect(
      summarizeIntegrations([
        node('n8n-nodes-base.slack', 'slack-1'),
        node('n8n-nodes-base.httpRequest', 'http-1'),
        node('n8n-nodes-base.slack', 'slack-2'),
        node('n8n-nodes-base.webhook', 'webhook-1'),
      ]),
    ).toEqual([
      {
        service: 'HTTP Request',
        nodeTypes: ['n8n-nodes-base.httpRequest'],
        nodeCount: 1,
        usage: 'Calls external HTTP APIs or internal web services.',
        riskNotes: ['Can send workflow data to external URLs configured in node parameters.'],
      },
      {
        service: 'Slack',
        nodeTypes: ['n8n-nodes-base.slack'],
        nodeCount: 2,
        usage: 'Sends or manages Slack workspace messages and notifications.',
        riskNotes: [],
      },
      {
        service: 'Webhook',
        nodeTypes: ['n8n-nodes-base.webhook'],
        nodeCount: 1,
        usage: 'Receives external HTTP requests into the workflow.',
        riskNotes: ['Can expose an inbound endpoint that may need authentication and rate limits.'],
      },
    ]);
  });

  it('orders integrations by stable code-unit order, not the host locale', () => {
    const integrations = summarizeIntegrations([
      node('n8n-nodes-base.zebra'),
      node('n8n-nodes-base.Äpple'),
      node('n8n-nodes-base.apple'),
    ]);

    expect(integrations.map((integration) => integration.service)).toEqual([
      'Apple',
      'Zebra',
      'Äpple',
    ]);
  });
});
