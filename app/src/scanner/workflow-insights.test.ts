import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { analyzeWorkflowInsights } from './workflow-insights';

function parseWorkflow(workflow: unknown) {
  const parsed = parseWorkflowJson(JSON.stringify(workflow));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }

  return parsed.workflow;
}

describe('analyzeWorkflowInsights', () => {
  it('summarizes workflow shape, integrations, and likely purpose', () => {
    const workflow = parseWorkflow({
      name: 'Lead intake alerts',
      nodes: [
        {
          id: 'webhook-1',
          name: 'Lead webhook',
          type: 'n8n-nodes-base.webhook',
          parameters: { path: 'lead' },
        },
        {
          id: 'http-1',
          name: 'Enrich lead',
          type: 'n8n-nodes-base.httpRequest',
          parameters: { url: 'https://api.example.com/leads' },
        },
        {
          id: 'slack-1',
          name: 'Notify sales',
          type: 'n8n-nodes-base.slack',
          parameters: { channel: '#sales' },
        },
      ],
      connections: {
        'Lead webhook': {
          main: [[{ node: 'Enrich lead', type: 'main', index: 0 }]],
        },
        'Enrich lead': {
          main: [[{ node: 'Notify sales', type: 'main', index: 0 }]],
        },
      },
    });

    const insights = analyzeWorkflowInsights(workflow);

    expect(insights.workflow).toMatchObject({
      name: 'Lead intake alerts',
      nodeCount: 3,
      triggerCount: 1,
      actionCount: 2,
      integrationCount: 3,
      connectionCount: 2,
      complexity: 'LOW',
    });
    expect(insights.functionSummary.basicPurpose).toContain('Webhook-triggered workflow');
    expect(insights.functionSummary.dataFlowSummary).toContain('2 configured connection');
    expect(insights.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ service: 'Webhook', nodeCount: 1 }),
        expect.objectContaining({ service: 'HTTP Request', nodeCount: 1 }),
        expect.objectContaining({ service: 'Slack', nodeCount: 1 }),
      ]),
    );
  });
});
