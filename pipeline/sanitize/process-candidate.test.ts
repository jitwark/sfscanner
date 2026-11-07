import { describe, expect, it } from 'vitest';
import { processCandidateWorkflow } from './process-candidate.js';

describe('processCandidateWorkflow', () => {
  it('always returns a sanitized workflow suitable for a resumed build', () => {
    const result = processCandidateWorkflow({
      name: 'resume fixture',
      nodes: [{
        id: '1',
        name: 'HTTP',
        type: 'n8n-nodes-base.httpRequest',
        parameters: { url: 'https://example.test', authorization: 'Bearer sk-test-value' },
        credentials: { httpBasicAuth: { id: 'secret-id', name: 'secret-name' } },
      }],
      connections: {},
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.workflow)).not.toContain('sk-test-value');
    expect((result.workflow as { nodes: Array<{ credentials?: unknown }> }).nodes[0]?.credentials).toBe('<redacted:credentials>');
  });
});
