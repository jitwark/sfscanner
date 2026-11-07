import { describe, expect, it } from 'vitest';
import { sanitizeWorkflow } from './redact.js';
import { verifySanitizedWorkflow } from './verify.js';

describe('verifySanitizedWorkflow', () => {
  it('passes verification on a properly sanitized workflow', () => {
    const original = {
      nodes: [
        {
          id: '1',
          name: 'HTTP Request',
          type: 'n8n-nodes-base.httpRequest',
          credentials: { httpHeaderAuth: { id: 'c1', name: 'Header' } },
          parameters: {
            url: 'https://user:password123@example.com/api',
            apiKey: 'sk-proj-12345678901234567890',
          },
        },
      ],
      connections: {},
    };

    const sanitized = sanitizeWorkflow(original);
    expect(sanitized.ok).toBe(true);

    const verified = verifySanitizedWorkflow(original, sanitized.workflow);
    expect(verified.ok).toBe(true);
    expect(verified.errors).toHaveLength(0);
  });

  it('fails verification if node topology is altered', () => {
    const original = {
      nodes: [
        { id: '1', name: 'N1', type: 'n8n-nodes-base.manualTrigger' },
        { id: '2', name: 'N2', type: 'n8n-nodes-base.noOp' },
      ],
      connections: {
        N1: { main: [[{ node: 'N2', type: 'main', index: 0 }]] },
      },
    };

    const corruptedSanitized = {
      nodes: [{ id: '1', name: 'N1', type: 'n8n-nodes-base.manualTrigger' }],
      connections: {},
    };

    const verified = verifySanitizedWorkflow(original, corruptedSanitized);
    expect(verified.ok).toBe(false);
    expect(verified.errors.some((e) => e.includes('Node count mismatch'))).toBe(true);
  });

  it('fails verification if an unredacted secret survives', () => {
    const original = {
      nodes: [
        {
          id: '1',
          name: 'HTTP',
          type: 'n8n-nodes-base.httpRequest',
          parameters: { apiKey: 'sk-proj-12345678901234567890' },
        },
      ],
      connections: {},
    };

    const dirtySanitized = JSON.parse(JSON.stringify(original));
    const verified = verifySanitizedWorkflow(original, dirtySanitized);
    expect(verified.ok).toBe(false);
    expect(verified.errors.some((e) => e.includes('Unredacted secret'))).toBe(true);
  });
});
