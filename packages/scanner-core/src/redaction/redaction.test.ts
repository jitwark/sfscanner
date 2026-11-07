import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_TOKEN_PATTERNS, redactionPattern } from '../provider-token-patterns';
import {
  redactEvidence,
  redactFinding,
  redactText,
  redactWorkflowJson,
} from './redaction';
import { REDACTED } from './structured-redaction';

describe('scanner-core redaction', () => {
  it('redacts sensitive keys and named header values without mutating input', () => {
    const input = {
      authorization: 'Bearer live-token-123',
      nested: {
        apiKey: 'private-api-key',
        headers: [
          { name: 'X-API-Key', value: 'header-secret' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
    };

    expect(redactEvidence(input)).toEqual({
      authorization: '[REDACTED]',
      nested: {
        apiKey: '[REDACTED]',
        headers: [
          { name: 'X-API-Key', value: '[REDACTED]' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
    });
    expect(input.nested.apiKey).toBe('private-api-key');
  });

  it('redacts every provider canary declared for redaction and preserves near misses', () => {
    for (const entry of PROVIDER_TOKEN_PATTERNS) {
      const redacted = redactEvidence({ value: `prefix ${entry.canary.positive} suffix` });
      const nearMiss = redactEvidence({ value: `prefix ${entry.canary.nearMiss} suffix` });

      expect(redacted).toEqual({
        value: entry.surfaces.includes('redact')
          ? 'prefix [REDACTED] suffix'
          : `prefix ${entry.canary.positive} suffix`,
      });
      expect(nearMiss).toEqual({ value: `prefix ${entry.canary.nearMiss} suffix` });
    }
  });

  it('redacts the reviewed AWS STS and GitHub token forms without redacting near misses', () => {
    // Synthetic compact-token shape only; the redactor treats ghs_ values as opaque.
    const githubJwt = `eyJ${'A'.repeat(80)}.eyJ${'B'.repeat(80)}.${'C'.repeat(342)}`;
    const examples = [
      [`ASIA${'A'.repeat(16)}`, `ASIA${'A'.repeat(15)}`],
      [`ghp_${'A'.repeat(36)}`, `ghp_${'A'.repeat(12)}`],
      [`github_pat_${'A'.repeat(22)}_${'A'.repeat(59)}`, `github_pat_${'A'.repeat(12)}`],
      [`gho_${'A'.repeat(36)}`, `gho_${'A'.repeat(12)}`],
      [`ghu_${'A'.repeat(36)}`, `ghu_${'A'.repeat(12)}`],
      [`ghs_${'A'.repeat(36)}`, `ghs_${'A'.repeat(12)}`],
      [`ghs_123456789_${githubJwt}`, 'ghs_123456789_eyJ.eyJ.A'],
      [`ghr_${'A'.repeat(76)}`, `ghr_${'A'.repeat(12)}`],
    ];

    for (const [positive, nearMiss] of examples) {
      expect(redactText(`prefix ${positive} suffix`)).toBe('prefix [REDACTED] suffix');
      expect(redactText(`prefix ${nearMiss} suffix`)).toBe(`prefix ${nearMiss} suffix`);
    }

    for (const unrecognized of [`ghp${'A'.repeat(12)}`, `glpat-${'A'.repeat(12)}`]) {
      expect(redactText(`prefix ${unrecognized} suffix`)).toBe(`prefix ${unrecognized} suffix`);
    }
  });

  it('redacts URL credentials, sensitive query values, and fragments while preserving structure', () => {
    expect(redactEvidence({
      url: 'https://alice:secret@api.example.com/v1/leads?page=2&api_key=private-key#token=fragment-secret',
    })).toEqual({
      url: 'https://%5BREDACTED%5D@api.example.com/v1/leads?page=2&api_key=[REDACTED]#[REDACTED]',
    });

    expect(redactEvidence({
      note: 'broken://[host]?access_token=private-value&mode=test',
    })).toEqual({
      note: 'broken://[host]?access_token=[REDACTED]&mode=test',
    });
  });

  it('redacts contextual PII only inside pinned data and sticky notes', () => {
    expect(redactEvidence({
      pinData: { customer: { email: 'ada@example.com', phone: '+1 415 555 0123' } },
      nodes: [{
        type: 'n8n-nodes-base.stickyNote',
        parameters: { content: 'Call ada@example.com at +1 415 555 0123' },
      }],
      ordinaryText: 'Contact ada@example.com for the public demo.',
    })).toEqual({
      pinData: { customer: { email: '[REDACTED]', phone: '[REDACTED]' } },
      nodes: [{
        type: 'n8n-nodes-base.stickyNote',
        parameters: { content: 'Call [REDACTED] at [REDACTED]' },
      }],
      ordinaryText: 'Contact ada@example.com for the public demo.',
    });
  });

  it('keeps expressions and placeholders unless their containing key is sensitive', () => {
    expect(redactEvidence({
      expression: '={{ $json.customer.email }}',
      placeholder: '{{ $env.API_KEY }}',
      apiKey: '={{ $env.API_KEY }}',
    })).toEqual({
      expression: '={{ $json.customer.email }}',
      placeholder: '{{ $env.API_KEY }}',
      apiKey: '[REDACTED]',
    });
  });

  it('redacts finding prose and evidence while retaining finding shape', () => {
    const finding = {
      policyId: 'credentials-in-http-node',
      title: 'Authorization uses Bearer live-token-123',
      severity: 'HIGH' as const,
      location: { nodeId: 'node-1', nodeName: 'Call API', path: '/nodes/0' },
      evidence: { authorization: 'Bearer live-token-123' },
      message: 'Contact ada@example.com with token sk_live_12345678.',
      explanation: 'A secret is embedded in the workflow.',
      whyItMatters: 'The credential may be exposed.',
      possibleImpact: 'An attacker can access the account.',
      remediation: 'Rotate the credential.',
      remediationSteps: ['Remove the token.', 'Use a credential reference.'],
      confidence: 'HIGH' as const,
    };

    expect(redactFinding(finding)).toEqual({
      ...finding,
      title: 'Authorization uses [REDACTED]',
      evidence: { authorization: '[REDACTED]' },
      message: 'Contact ada@example.com with token [REDACTED].',
    });
  });

  it('redacts workflow JSON deterministically and preserves non-sensitive shape', () => {
    const workflow = JSON.stringify({
      name: 'Redaction fixture',
      nodes: [{
        id: 'http-1',
        type: 'n8n-nodes-base.httpRequest',
        parameters: {
          headers: [{ name: 'Authorization', value: 'Bearer live-token-123' }],
          expression: '={{ $json.customer.email }}',
        },
      }],
      connections: {},
    });
    const first = redactWorkflowJson(workflow);
    const second = redactWorkflowJson(workflow);

    expect(first).toBe(second);
    expect(JSON.parse(first)).toMatchObject({
      name: 'Redaction fixture',
      nodes: [{
        id: 'http-1',
        parameters: {
          headers: [{ name: 'Authorization', value: '[REDACTED]' }],
          expression: '={{ $json.customer.email }}',
        },
      }],
    });
    expect(redactText('safe text')).toBe('safe text');
  });
});

describe('compiled redaction matchers', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reuses module-scope matchers instead of rebuilding a RegExp per call', () => {
    const NativeRegExp = RegExp;
    let constructions = 0;
    class CountingRegExp extends NativeRegExp {
      constructor(...args: ConstructorParameters<typeof RegExp>) {
        super(...args);
        constructions += 1;
      }
    }
    vi.stubGlobal('RegExp', CountingRegExp);

    expect(redactText('plain text with no token')).toBe('plain text with no token');
    expect(redactText('Authorization Bearer live-token-123')).toBe('Authorization [REDACTED]');

    expect(constructions).toBe(0);
  });

  it('redacts a token at offset zero on every repeated call', () => {
    // A hoisted `/g` matcher whose lastIndex leaked would skip the leading match on a later call.
    const value = `sfk_22222222-2222-4222-8222-222222222222_AbCdEf12345.${'s'.repeat(43)} suffix`;
    const expected = redactText(value);

    expect(expected).toBe('[REDACTED] suffix');
    for (let call = 0; call < 5; call += 1) expect(redactText(value)).toBe(expected);
  });

  it('matches a per-call rebuilt matcher byte for byte over a table of cases', () => {
    // Reference: the pre-refactor behaviour rebuilds the matcher on every call. Inputs avoid URLs so
    // the structured-url pre-pass is the identity, isolating the provider-token stage under test.
    const referenceMatchers = PROVIDER_TOKEN_PATTERNS
      .filter((entry) => entry.surfaces.some((surface) => surface === 'redact'))
      .map(redactionPattern);
    const cases = [
      '',
      'safe text with no token',
      `sfk_22222222-2222-4222-8222-222222222222_AbCdEf12345.${'s'.repeat(43)}`,
      `before ${`ghp_${'A'.repeat(36)}`} middle ${'xoxb-1234567890'} after`,
      `repeated ${`hf_${'A'.repeat(20)}`} and again ${`hf_${'B'.repeat(20)}`}`,
      `near miss ${`ghp_${'A'.repeat(12)}`}`,
    ];

    for (const value of cases) {
      const expected = referenceMatchers.reduce(
        (redacted, pattern) => redacted.replace(new RegExp(pattern.source, pattern.ignoreCase ? 'gi' : 'g'), REDACTED),
        value,
      );
      expect(redactText(value)).toBe(expected);
    }
  });
});
