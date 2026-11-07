import { describe, expect, test } from 'vitest';
import { auditGeminiWorkflowInput, projectWorkflowForGemini, projectWorkflowForGeminiRestricted } from './model-safe-workflow';

describe('projectWorkflowForGemini', () => {
  test('keeps workflow behavior while removing source prose, identity metadata, credentials, and code', () => {
    const workflow = {
      id: 'website-id',
      name: 'A title supplied by the website',
      description: 'A long upstream description that must never reach Gemini.',
      meta: { templateCredsSetup: true, description: 'metadata prose' },
      pinData: { Webhook: [{ json: { email: 'person@example.com' } }] },
      nodes: [
        {
          id: 'node-1',
          name: 'Receive request',
          type: 'n8n-nodes-base.webhook',
          typeVersion: 2,
          position: [100, 200],
          credentials: { httpBasicAuth: { id: 'cred-1', name: 'Website credential' } },
          parameters: {
            path: 'orders',
            jsCode: 'const secret = "sk-proj-12345678901234567890"; return items;',
          },
        },
      ],
      connections: { 'Receive request': { main: [[{ node: 'Send response', type: 'main', index: 0 }]] } },
    };

    const projected = projectWorkflowForGemini(workflow) as Record<string, unknown>;
    const node = (projected.nodes as Array<Record<string, unknown>>)[0];

    expect(projected).not.toHaveProperty('id');
    expect(projected).not.toHaveProperty('name');
    expect(projected).not.toHaveProperty('description');
    expect(projected).not.toHaveProperty('meta');
    expect(projected).not.toHaveProperty('pinData');
      expect(node).toMatchObject({ name: 'Receive request', type: 'n8n-nodes-base.webhook' });
    expect(node).not.toHaveProperty('id');
    expect(node).not.toHaveProperty('webhookId');
    expect(node).not.toHaveProperty('credentials');
    expect((node.parameters as Record<string, unknown>)).not.toHaveProperty('jsCode');
    expect(projected.connections).toEqual(workflow.connections);
  });

  test('redacts provider tokens, auth headers, and embedded basic-auth URLs everywhere', () => {
    const projected = projectWorkflowForGemini({
      nodes: [
        {
          name: 'Call API',
          type: 'n8n-nodes-base.httpRequest',
          parameters: {
            url: 'https://user:password123@example.com/api',
            headers: { Authorization: 'Bearer mySecretToken12345' },
            apiKey: 'sk-proj-12345678901234567890',
          },
        },
      ],
      connections: {},
    });
    const serialized = JSON.stringify(projected);

    expect(serialized).not.toContain('password123');
    expect(serialized).not.toContain('mySecretToken12345');
    expect(serialized).not.toContain('sk-proj-12345678901234567890');
    expect(serialized).toContain('<redacted>');
  });
});

describe('auditGeminiWorkflowInput', () => {
  test('accepts a projected workflow and rejects website prose or secrets', () => {
    const safe = projectWorkflowForGemini({
      nodes: [{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} }],
      connections: {},
    });

    expect(auditGeminiWorkflowInput([safe])).toEqual({ ok: true, errors: [] });
    const syntheticTwilioAccountSid = `AC${'1234567890'.repeat(3)}12`;
    const realisticIds = projectWorkflowForGemini({
      nodes: [
        { id: syntheticTwilioAccountSid, webhookId: 'eyJnode-id-looking-value', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
      ],
      connections: {},
    });
    expect(auditGeminiWorkflowInput([realisticIds])).toEqual({ ok: true, errors: [] });
    const longWorkflowValues = {
      nodes: [{
        name: 'A long but ordinary node name',
        type: `n8n-nodes-base.${'ordinary'.repeat(8)}`,
        parameters: {
          path: 'a'.repeat(48),
          documentId: { value: 'b'.repeat(48) },
        },
      }],
      connections: {},
    };
    expect(auditGeminiWorkflowInput([longWorkflowValues])).toEqual({ ok: true, errors: [] });
    const projectedSecret = projectWorkflowForGemini({ nodes: [{ name: 'API', type: 'n8n-nodes-base.httpRequest', parameters: { apiKey: 'short-secret' } }], connections: {} });
    expect(auditGeminiWorkflowInput([projectedSecret])).toEqual({ ok: true, errors: [] });
    const projectedNestedSecret = projectWorkflowForGemini({ nodes: [{ name: 'API', type: 'n8n-nodes-base.httpRequest', parameters: { token: ['short-secret'] } }], connections: {} });
    expect(JSON.stringify(projectedNestedSecret)).not.toContain('short-secret');
    expect(auditGeminiWorkflowInput([{ nodes: [], connections: {}, description: 'website copy' }])).toMatchObject({
      ok: false,
    });
    const workflowLabel = projectWorkflowForGemini({
      nodes: [{ name: 'ResumeBot', type: 'n8n-nodes-base.telegram', parameters: {} }],
      connections: {},
    });
    expect(auditGeminiWorkflowInput([workflowLabel], ['ResumeBot'])).toEqual({ ok: true, errors: [] });
    const workflowWithProse = projectWorkflowForGemini({
      nodes: [{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: { note: 'A long website description that must never enter the model packet.' } }],
      connections: {},
    });
    expect(auditGeminiWorkflowInput([workflowWithProse], ['A long website description that must never enter the model packet.']))
      .toMatchObject({ ok: false });
    expect(auditGeminiWorkflowInput([{ nodes: [], connections: {}, apiKey: 'sk-proj-12345678901234567890' }])).toMatchObject({
      ok: false,
    });
    expect(auditGeminiWorkflowInput([undefined])).toMatchObject({ ok: false });
  });
});

describe('projectWorkflowForGeminiRestricted', () => {
  test('keeps node names and types while removing free-form parameter and note text', () => {
    const restricted = projectWorkflowForGeminiRestricted({
      nodes: [
        { name: 'Analyze Video', type: 'n8n-nodes-base.httpRequest', parameters: { jsonBody: 'a long prompt', url: 'https://example.test', method: 'POST' } },
        { name: 'Sticky Note', type: 'n8n-nodes-base.stickyNote', parameters: { content: 'setup instructions' } },
      ],
      connections: { 'Analyze Video': { main: [[{ node: 'Sticky Note', type: 'main', index: 0 }]] } },
    }) as Record<string, any>;

    expect(restricted.nodes).toEqual([
      { name: 'Analyze Video', type: 'n8n-nodes-base.httpRequest', parameters: {} },
      { name: 'Sticky Note', type: 'n8n-nodes-base.stickyNote', parameters: {} },
    ]);
    expect(restricted.connections['Analyze Video'].main[0][0]).toMatchObject({ node: 'Sticky Note', type: 'main', index: 0 });
    expect(auditGeminiWorkflowInput([restricted])).toEqual({ ok: true, errors: [] });
  });
});
