import { describe, expect, it } from 'vitest';
import { authorizationHeaderEvidence, hasWebhookAuthentication, isNonSecretLiteral } from './policy-helpers';
import { rawAuthorizationHeaderPolicy, rawSecretIndicatorPolicy } from '../policies/credential-policies';
import { parseWorkflowJson } from '../workflow';

function workflowWithParameters(parameters: Record<string, unknown>) {
  const parsed = parseWorkflowJson(JSON.stringify({
    nodes: [{
      id: 'n1', name: 'N1', type: 'n8n-nodes-base.httpRequest', typeVersion: 1, parameters,
    }],
    connections: {},
  }));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.workflow;
}

describe('expression and auth hardening', () => {
  it('does not treat interpolation markers as non-secret proof', () => {
    expect(isNonSecretLiteral('mySecret12345${1}')).toBe(false);
    expect(isNonSecretLiteral('mySecret12345 {{ 1 }}')).toBe(false);
    expect(isNonSecretLiteral('{{ $json.apiKey }}')).toBe(true);
  });

  it('reports a low-entropy password adjacent to an expression end-to-end', () => {
    // Runtime verification 12: the high-entropy synthetic password is caught by the nested
    // classifySecretValue path even before the fix, so it is not the discriminating case.
    // 'hunter2 {{ 1 }}' is the confirmed zero-finding path.
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes: [{ id: 'n1', name: 'N1', type: 'n8n-nodes-base.httpRequest', typeVersion: 1, parameters: { password: '=hunter2 {{ 1 }}' } }],
      connections: {},
    }));
    if (!parsed.ok) throw new Error(parsed.message);
    expect(rawSecretIndicatorPolicy.evaluate(parsed.workflow)).toHaveLength(1);
  });

  it('trims header names and recognizes value/headerValue/content shapes', () => {
    expect(authorizationHeaderEvidence({ 'Authorization ': 'Bearer abcdefgh' }))
      .toEqual({ present: true, literal: true });
    for (const key of ['value', 'val', 'headerValue', 'content']) {
      expect(authorizationHeaderEvidence({ name: 'Authorization', [key]: 'Bearer ${token}' }))
        .toEqual({ present: true, literal: true });
    }
  });

  it('keeps a managed credential behind a public scheme out of raw-secret findings', () => {
    const workflow = workflowWithParameters({
      headers: { Authorization: '=Bearer {{ $credentials.token }}' },
    });

    expect(rawAuthorizationHeaderPolicy.evaluate(workflow)).toEqual([
      expect.objectContaining({
        title: 'Authorization header is set from an expression',
        severity: 'INFO',
        evidence: { header: 'Authorization', literalValue: false },
      }),
    ]);
    expect(rawSecretIndicatorPolicy.evaluate(workflow)).toEqual([]);
  });

  it('keeps literal material adjacent to a managed credential as a raw-secret finding', () => {
    const workflow = workflowWithParameters({
      headers: { Authorization: '=Bearer abc123{{ $credentials.token }}' },
    });

    expect(rawAuthorizationHeaderPolicy.evaluate(workflow)).toEqual([
      expect.objectContaining({
        severity: 'HIGH',
        evidence: { header: 'Authorization', literalValue: true },
      }),
    ]);
    expect(rawSecretIndicatorPolicy.evaluate(workflow)).toEqual([
      expect.objectContaining({
        severity: 'MEDIUM',
        evidence: expect.objectContaining({
          parameterPath: 'parameters.headers.Authorization',
          indicator: 'sensitive_key',
          hasLiteralValue: true,
        }),
      }),
    ]);
  });

  it('reports a provider token quoted inside an expression as a sensitive value', () => {
    const workflow = workflowWithParameters({ apiKey: '={{"sk_live_1234567890abcdef"}}' });

    const findings = rawSecretIndicatorPolicy.evaluate(workflow);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      policyId: 'RAW_SECRET_INDICATOR',
      severity: 'HIGH',
      evidence: {
        parameterPath: 'parameters.apiKey',
        secretKind: 'Stripe API key',
        indicator: 'sensitive_value',
        hasLiteralValue: true,
      },
    });
    expect(JSON.stringify(findings)).not.toContain('sk_live_1234567890abcdef');
  });

  it('leaves managed references, provider near misses, and quoted property names unreported', () => {
    const cases = [
      '={{ $credentials.token }}',
      '={{ "sk_live_1234567" }}',
      '={{ "sk_live_" + $json.suffix }}',
      '={{ $json["sk_live_1234567890abcdef"] }}',
      '={{"sk_live_1234\\n5678"}}',
    ];

    for (const value of cases) {
      const workflow = workflowWithParameters({ apiKey: value });
      expect(rawSecretIndicatorPolicy.evaluate(workflow)).toEqual([]);
      expect(JSON.stringify(rawSecretIndicatorPolicy.evaluate(workflow))).not.toContain('sk_live_');
    }
  });

  it('admits only the exact webhook values the pinned runtime admits', () => {
    // Pinned n8n-nodes-base@2.15.1 Webhook/utils.js:205-289 compares the stored parameter with
    // strict equality and has no final else, so the runtime fails open on any other spelling.
    for (const value of ['basicAuth', 'headerAuth', 'jwtAuth']) {
      expect(hasWebhookAuthentication({ authentication: value })).toBe(true);
    }
    for (const value of [
      'BASICAUTH', 'BasicAuth', ' basicAuth ', 'headerAuth ', 'JwtAuth',
      '', ' ', 'none', 'NONE', 'false', 'disabled', 'off', 'oauth2', '={{ "none" }}', undefined,
    ]) {
      expect(hasWebhookAuthentication({ authentication: value })).toBe(false);
    }
  });
});
