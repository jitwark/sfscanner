import { describe, test, expect } from 'vitest';
import { buildFacts } from './facts';
import type { Entry } from '@hub/contracts';

const mockEntry: Entry = {
  id: 'test-entry-1',
  slug: 'test-entry-1',
  title: 'My Secure Workflow with MIT Licence https://example.com secret: 12345',
  summary: '',
  description: '',
  descriptionSource: 'fallback',
  source: {
    kind: 'github',
    permalink: 'https://github.com/example/repo',
    fetchedAt: '2026-01-01T00:00:00Z',
  },
  rights: {
    status: 'redistributable',
    licence: 'MIT',
    licenceUrl: null,
    reason: 'Open source',
  },
  structure: {
    nodeCount: 5,
    rawNodeCount: 5,
    annotationNodeCount: 0,
    connectionCount: 4,
    nodeTypes: ['n8n-nodes-base.slack', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.code'],
    integrations: ['Slack', 'HTTP Request'],
    trigger: 'webhookTrigger',
    isSubWorkflow: false,
    complexity: 'medium',
    hasCode: true,
    hasAI: false,
    hasWebhook: true,
  },
  security: {
    grade: 'LOW',
    score: 10,
    counts: { critical: 0, high: 0, medium: 0, low: 1, info: 0 },
    findings: [],
    hardenedExtra: 0,
    scannerVersion: '1.0.0',
    profile: 'beta-default',
  },
  tags: ['slack', 'http'],
  dedup: {
    fingerprint: 'abc',
    structuralHash: 'def',
    canonical: true,
    alsoFoundIn: [],
  },
};

describe('facts', () => {
  test('buildFacts sanitizes title and extracts fields', () => {
    const facts = buildFacts(mockEntry);
    expect(facts.id).toBe('test-entry-1');
    expect(facts.title).not.toContain('https://');
    expect(facts.title).not.toContain('MIT');
    expect(facts.title).not.toContain('Secure');
    expect(facts.title).not.toContain('secret');
    expect(facts.trigger).toBe('webhookTrigger');
    expect(facts.nodeCount).toBe(5);
    expect(facts.integrations).toEqual(['http request', 'slack']);
    expect(facts.capabilities).toEqual({
      hasCode: true,
      hasAI: false,
      hasWebhook: true,
    });
    expect(facts.complexity).toBe('medium');
    expect(facts.nodeNames).toEqual(['slack', 'httpRequest', 'code']);
  });

  test('buildFacts accepts custom node display names capped at 8', () => {
    const names = ['Node 1', 'Node 2', 'Node 3', 'Node 4', 'Node 5', 'Node 6', 'Node 7', 'Node 8', 'Node 9'];
    const facts = buildFacts(mockEntry, names);
    expect(facts.nodeNames.length).toBe(8);
    expect(facts.nodeNames[0]).toBe('Node 1');
  });
});
