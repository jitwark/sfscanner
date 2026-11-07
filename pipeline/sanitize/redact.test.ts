import { describe, expect, it } from 'vitest';
import { sanitizeWorkflow } from './redact.js';

type NodeObj = {
  id: string;
  name: string;
  type: string;
  credentials?: unknown;
  pinData?: unknown;
  executionId?: unknown;
  parameters?: Record<string, unknown>;
};

type WorkflowObj = {
  pinData?: unknown;
  executionId?: unknown;
  instanceId?: unknown;
  versionId?: unknown;
  binary?: unknown;
  nodes?: NodeObj[];
};

describe('sanitizeWorkflow', () => {
  it('strips root and node residue fields and credentials', () => {
    const input: WorkflowObj = {
      pinData: { Node1: [{ json: { foo: 'bar' } }] },
      executionId: 'exec-123',
      instanceId: 'inst-456',
      versionId: 'ver-789',
      binary: { data: 'base64...' },
      nodes: [
        {
          id: '1',
          name: 'Node 1',
          type: 'n8n-nodes-base.httpRequest',
          credentials: { httpHeaderAuth: { id: 'cred-1', name: 'Auth' } },
          pinData: { test: true },
          executionId: 'node-exec-1',
        },
      ],
    };

    const res = sanitizeWorkflow(input);
    expect(res.ok).toBe(true);

    const wf = res.workflow as WorkflowObj;
    expect(wf.pinData).toBeUndefined();
    expect(wf.executionId).toBeUndefined();
    expect(wf.instanceId).toBeUndefined();
    expect(wf.versionId).toBeUndefined();
    expect(wf.binary).toBeUndefined();

    const node = wf.nodes?.[0];
    expect(node?.credentials).toBe('<redacted:credentials>');
    expect(node?.pinData).toBeUndefined();
    expect(node?.executionId).toBeUndefined();

    expect(res.manifest.length).toBeGreaterThan(0);
    const pinEntry = res.manifest.find((m) => m.path === 'pinData');
    expect(pinEntry).toBeDefined();
    expect(pinEntry?.rule).toBe('pin_data');
    expect(pinEntry?.beforeSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('redacts parameter secret patterns and hardcoded Authorization headers', () => {
    const input: WorkflowObj = {
      nodes: [
        {
          id: '1',
          name: 'HTTP Node',
          type: 'n8n-nodes-base.httpRequest',
          parameters: {
            url: 'https://user:secretpass123@example.com/webhook',
            headerParameters: {
              parameters: [
                { name: 'Authorization', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl' },
                { name: 'apiKey', value: 'sk-proj-12345678901234567890' },
              ],
            },
          },
        },
      ],
    };

    const res = sanitizeWorkflow(input);
    expect(res.ok).toBe(true);

    const wf = res.workflow as WorkflowObj;
    const node = wf.nodes?.[0];
    const params = node?.parameters as Record<string, unknown>;
    expect(params.url).toBe('<redacted:basic-auth-url>');

    const headerParams = params.headerParameters as { parameters: Array<{ name: string; value: string }> };
    const headers = headerParams.parameters;
    expect(headers[0].value).toBe('<redacted:authorization-header>');
    expect(headers[1].value).toBe('<redacted:api-key>');
  });

  it('removes code node bodies from the public sanitized workflow', () => {
    const code = 'const apiKey = "sk-proj-12345678901234567890"; return [{ json: { apiKey } }];';
    const input: WorkflowObj = {
      nodes: [
        {
          id: '1',
          name: 'Code',
          type: 'n8n-nodes-base.code',
          parameters: {
            jsCode: code,
            otherParam: 'sk-proj-12345678901234567890',
          },
        },
      ],
    };

    const res = sanitizeWorkflow(input);
    expect(res.ok).toBe(true);

    const wf = res.workflow as WorkflowObj;
    const node = wf.nodes?.[0];
    const params = node?.parameters as Record<string, unknown>;
    expect(params.jsCode).toBeUndefined();
    expect(params.otherParam).toBe('<redacted:api-key>');
  });
});
