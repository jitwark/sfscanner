import { describe, expect, it } from 'vitest';
import { deriveChart, deriveStructure, deriveTrigger } from './structure.js';

describe('deriveTrigger', () => {
  it('identifies Webhook trigger', () => {
    const nodes = [{ name: 'Webhook', type: 'n8n-nodes-base.webhook' }];
    expect(deriveTrigger(nodes)).toBe('Webhook');
  });

  it('identifies Schedule and Cron triggers', () => {
    expect(deriveTrigger([{ name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger' }])).toBe('Schedule');
    expect(deriveTrigger([{ name: 'Cron', type: 'n8n-nodes-base.cron' }])).toBe('Schedule');
  });

  it('identifies Chat trigger', () => {
    expect(deriveTrigger([{ name: 'Chat Trigger', type: '@n8n/n8n-nodes-langchain.chatTrigger' }])).toBe('Chat');
  });

  it('identifies Email trigger', () => {
    expect(deriveTrigger([{ name: 'Email Trigger', type: 'n8n-nodes-base.emailReadImap' }])).toBe('Email');
  });

  it('identifies Form trigger', () => {
    expect(deriveTrigger([{ name: 'Form Trigger', type: 'n8n-nodes-base.formTrigger' }])).toBe('Form');
  });

  it('identifies Execute-Workflow trigger', () => {
    expect(deriveTrigger([{ name: 'Execute Workflow Trigger', type: 'n8n-nodes-base.executeWorkflowTrigger' }])).toBe('Execute-Workflow');
  });

  it('identifies Manual trigger', () => {
    expect(deriveTrigger([{ name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger' }])).toBe('Manual');
  });

  it('defaults to Manual trigger when unrecognized or empty', () => {
    expect(deriveTrigger([])).toBe('Manual');
    expect(deriveTrigger([{ name: 'Slack', type: 'n8n-nodes-base.slack' }])).toBe('Manual');
  });
});

describe('deriveStructure', () => {
  it('derives structure, integrations, complexity, and feature flags', () => {
    const workflow = {
      nodes: [
        { id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook' },
        { id: '2', name: 'Code', type: 'n8n-nodes-base.code' },
        { id: '3', name: 'OpenAI', type: '@n8n/n8n-nodes-langchain.openAi' },
      ],
      connections: {
        Webhook: { main: [[{ node: 'Code', type: 'main', index: 0 }]] },
        Code: { main: [[{ node: 'OpenAI', type: 'main', index: 0 }]] },
      },
    };

    const structure = deriveStructure(workflow);
    expect(structure.nodeCount).toBe(3);
    expect(structure.connectionCount).toBe(2);
    expect(structure.trigger).toBe('Webhook');
    expect(structure.complexity).toBe('simple');
    expect(structure.hasCode).toBe(true);
    expect(structure.hasAI).toBe(true);
    expect(structure.hasWebhook).toBe(true);
    expect(structure.nodeTypes).toEqual(['@n8n/n8n-nodes-langchain.openAi', 'n8n-nodes-base.code', 'n8n-nodes-base.webhook']);
    expect(structure.integrations).toEqual(['openai']);
  });

  it('never classifies built-in and control-flow nodes as vendor integrations', () => {
    const structure = deriveStructure({
      nodes: [
        { type: 'n8n-nodes-base.webhook' },
        { type: 'n8n-nodes-base.set' },
        { type: 'n8n-nodes-base.merge' },
        { type: 'n8n-nodes-base.code' },
        { type: 'n8n-nodes-base.if' },
        { type: 'n8n-nodes-base.slackTrigger' },
        { type: '@n8n/n8n-nodes-langchain.openAi' },
      ],
    });

    expect(structure.integrations).toEqual(['openai', 'slack']);
  });
});

describe('deriveChart', () => {
  it('generates chart nodes and edges', () => {
    const workflow = {
      nodes: [
        { id: 'n1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', position: [100, 200] },
        { id: 'n2', name: 'Slack', type: 'n8n-nodes-base.slack', position: [400, 200] },
      ],
      connections: {
        Start: { main: [[{ node: 'Slack', type: 'main', index: 0 }]] },
      },
    };

    const chart = deriveChart(workflow);
    expect(chart.nodes).toEqual([
      { id: 'n1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', x: 100, y: 200, isAnnotation: false },
      { id: 'n2', name: 'Slack', type: 'n8n-nodes-base.slack', x: 400, y: 200, isAnnotation: false },
    ]);
    expect(chart.edges).toEqual([
      { from: 'Start', to: 'Slack', kind: 'main' },
    ]);
  });
});

describe('deriveStructure and connections that resolve to nothing', () => {
  it('does not count a connection to a node the workflow does not contain', () => {
    const structure = deriveStructure({
      nodes: [
        { name: 'Start', type: 'n8n-nodes-base.manualTrigger', position: [0, 0] },
        { name: 'Post', type: 'n8n-nodes-base.slack', position: [200, 0] },
      ],
      connections: { Start: { main: [[{ node: 'Post' }, { node: 'Ghost' }]] } },
    });

    expect(structure.connectionCount).toBe(1);
  });

  it('does not count a connection whose source names no node', () => {
    const structure = deriveStructure({
      nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', position: [0, 0] }],
      connections: { Phantom: { main: [[{ node: 'Start' }]] } },
    });

    expect(structure.connectionCount).toBe(0);
  });

  it('bands complexity on connections that exist, not on ones that were declared', () => {
    // 30 declared connections would read as complex; none of them resolves, so
    // there is nothing complex going on.
    const targets = Array.from({ length: 30 }, (_, i) => ({ node: `ghost-${i}` }));
    const structure = deriveStructure({
      nodes: [
        { name: 'Start', type: 'n8n-nodes-base.manualTrigger', position: [0, 0] },
        { name: 'Post', type: 'n8n-nodes-base.slack', position: [200, 0] },
      ],
      connections: { Start: { main: [targets] } },
    });

    expect(structure.connectionCount).toBe(0);
    expect(structure.complexity).toBe('simple');
  });
});
