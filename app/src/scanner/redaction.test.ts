import { describe, expect, it } from 'vitest';
import { PROVIDER_TOKEN_PATTERNS } from '@hub/scanner-core/provider-token-patterns';
import { redactEvidence, redactWorkflowJson } from '@hub/scanner-core/redaction';

describe('redactEvidence', () => {
  it('redacts sensitive keys and auth-like string values deeply', () => {
    const input = {
      header: 'Authorization',
      authorization: 'Bearer live-token-123',
      nested: {
        apiKey: 'sk_live_abc123456789',
        password: 'correct-horse-battery-staple',
        safeDomain: 'api.example.com',
        headers: [
          { name: 'X-API-Key', value: 'abc123SECRET456' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
    };

    const redacted = redactEvidence(input);

    expect(redacted).toEqual({
      header: 'Authorization',
      authorization: '[REDACTED]',
      nested: {
        apiKey: '[REDACTED]',
        password: '[REDACTED]',
        safeDomain: 'api.example.com',
        headers: [
          { name: 'X-API-Key', value: '[REDACTED]' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
    });
    expect(input.nested.apiKey).toBe('sk_live_abc123456789');
  });

  it('redacts SecureFlow API keys in arbitrary string values', () => {
    const apiKey = 'sfk_22222222-2222-4222-8222-222222222222_AbCdEf12345.' + 's'.repeat(43);

    expect(redactEvidence({ note: apiKey })).toEqual({ note: '[REDACTED]' });
  });

  it('redacts URL credentials and sensitive query values while keeping safe URL structure', () => {
    const redacted = redactEvidence({
      url: 'https://alice:secret@api.example.com/v1/leads?page=2&api_key=private-key#token=fragment-secret',
    });

    expect(redacted).toEqual({
      url: 'https://%5BREDACTED%5D@api.example.com/v1/leads?page=2&api_key=[REDACTED]#[REDACTED]',
    });
  });

  it('redacts sensitive query values in malformed URL-like text', () => {
    expect(redactEvidence({ note: 'broken://[host]?access_token=private-value&mode=test' })).toEqual({
      note: 'broken://[host]?access_token=[REDACTED]&mode=test',
    });
  });

  it('redacts PII only from pinned data and sticky-note content', () => {
    const redacted = redactEvidence({
      pinData: { customer: { email: 'ada@example.com', phone: '+1 415 555 0123' } },
      nodes: [{ type: 'n8n-nodes-base.stickyNote', parameters: { content: 'Call ada@example.com at +1 415 555 0123' } }],
      ordinaryText: 'Contact ada@example.com for the public demo.',
    });

    expect(redacted).toEqual({
      pinData: { customer: { email: '[REDACTED]', phone: '[REDACTED]' } },
      nodes: [{ type: 'n8n-nodes-base.stickyNote', parameters: { content: 'Call [REDACTED] at [REDACTED]' } }],
      ordinaryText: 'Contact ada@example.com for the public demo.',
    });
  });

  it('is idempotent for structured URL and PII redaction', () => {
    const input = { pinData: { note: 'https://api.example.com?token=private-value email ada@example.com' } };

    expect(redactEvidence(redactEvidence(input))).toEqual(redactEvidence(input));
  });

  it('redacts every catalogued canary only on its declared surface', () => {
    for (const entry of PROVIDER_TOKEN_PATTERNS) {
      const redacted = redactEvidence({ value: `prefix ${entry.canary.positive} suffix` });
      const nearMiss = redactEvidence({ value: `prefix ${entry.canary.nearMiss} suffix` });

      if (entry.surfaces.includes('redact')) {
        expect(redacted).toEqual({ value: 'prefix [REDACTED] suffix' });
      } else {
        expect(redacted).toEqual({ value: `prefix ${entry.canary.positive} suffix` });
      }
      expect(nearMiss).toEqual({ value: `prefix ${entry.canary.nearMiss} suffix` });
    }
  });

});
describe('redactWorkflowJson', () => {
  it('redacts supported token families while preserving workflow shape', () => {
    const awsAccessKey = `AKIA${'A'.repeat(16)}`;
    const googleApiKey = `AIza${'B'.repeat(35)}`;
    const slackToken = `xoxb-${'123456789012-'.repeat(2)}${'abcdefghijklmnopqrst' + 'uvwx'}`;
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl';
    const workflowJson = JSON.stringify({
      name: 'Redaction fixture',
      nodes: [
        {
          id: 'http-1',
          name: 'Call API',
          type: 'n8n-nodes-base.httpRequest',
          parameters: {
            note: 'safe value',
            headerParameters: {
              parameters: [
                { name: 'X-AWS-Access-Key', value: awsAccessKey },
                { name: 'X-Google-Key', value: googleApiKey },
                { name: 'X-Slack-Token', value: slackToken },
                { name: 'X-JWT', value: jwt },
              ],
            },
          },
        },
      ],
      connections: {},
    });

    const redactedJson = redactWorkflowJson(workflowJson);
    const redacted = JSON.parse(redactedJson);

    expect(redacted.name).toBe('Redaction fixture');
    expect(redacted.nodes).toHaveLength(1);
    expect(redacted.nodes[0]).toMatchObject({
      id: 'http-1',
      name: 'Call API',
      type: 'n8n-nodes-base.httpRequest',
    });
    expect(redacted.nodes[0].parameters.note).toBe('safe value');
    expect(redactedJson).not.toContain(awsAccessKey);
    expect(redactedJson).not.toContain(googleApiKey);
    expect(redactedJson).not.toContain(slackToken);
    expect(redactedJson).not.toContain(jwt);
    expect(redactedJson).toContain('[REDACTED]');
  });
});
