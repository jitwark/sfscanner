import { describe, expect, it } from 'vitest';
import {
  authorizationHeaderEvidence,
  hasWebhookAuthentication,
  isNonSecretLiteral,
  nodeFinding,
} from './policy-helpers';
import { collectUrlOutcome, collectUrls } from './url-outcome';

const node = {
  id: 'node-1',
  name: 'HTTP request',
  type: 'n8n-nodes-base.httpRequest',
  parameters: {},
  sourcePath: '/nodes/0',
};

describe('policy helpers', () => {
  it.each([
    '',
    '  ',
    '={{ $json.token }}',
    '{{ $credentials.apiKey }}',
    '$env.API_KEY',
    '<your-password>',
    '[API_KEY]',
    'changeme',
    'changeme-api-key',
    'todo-token',
    'example-token',
    'my___api---key',
    '=Bearer {{ $credentials.token }}',
    '=Basic {{ $credentials.password }}',
    '=Bearer ',
  ])('classifies %j as a non-secret literal', (value) => {
    expect(isNonSecretLiteral(value)).toBe(true);
  });

  it.each(['Bearer abc123', 'sk_live_abc123456789', 'plain-value', '${API_KEY}'])
    ('does not suppress literal %j', (value) => {
      expect(isNonSecretLiteral(value)).toBe(false);
    });

  it.each([
    'my-api-key-lowentropy',
    'test-token-lowentropy',
    'example-secret-lowentropy',
    'your-secret-lowentropy',
  ])('does not suppress prefix-collision literal %j', (value) => {
    expect(isNonSecretLiteral(value)).toBe(false);
  });

  it('does not suppress literal material behind the expression marker', () => {
    expect(isNonSecretLiteral('=Bearer abc123')).toBe(false);
    expect(isNonSecretLiteral('=sk_live_1234567890abcdef')).toBe(false);
    expect(isNonSecretLiteral('={{ $json.key }}sk_live_1234567890abcdef')).toBe(false);
  });

  it('keeps pure expressions and public scheme-only text non-secret without blanket island proof', () => {
    expect(isNonSecretLiteral('={{ $json.key }}')).toBe(true);
    expect(isNonSecretLiteral("='https://' + $json.x")).toBe(true);
    expect(isNonSecretLiteral('=Bearer {{ $credentials.token }}')).toBe(true);
    expect(isNonSecretLiteral('=Bearer {{ $credentials.token }} extra')).toBe(false);
    expect(isNonSecretLiteral('=Bearer abc123 {{ $credentials.token }}')).toBe(false);
  });

  it('does not let a runtime-reference lookalike hide adjacent literal material', () => {
    // A `$json` token outside expression braces is literal text. The previous filter dropped
    // the whole island on any runtime-reference match, so only expression-mode text may apply it.
    expect(isNonSecretLiteral('mySecret $json')).toBe(false);
    expect(isNonSecretLiteral('mySecret $json {{ 1 }}')).toBe(false);
    expect(isNonSecretLiteral('$json.foo')).toBe(true);
    expect(isNonSecretLiteral("='https://' + $json.x")).toBe(true);
  });

  it('classifies complete provider tokens in quoted expression strings but not property keys', () => {
    expect(isNonSecretLiteral('={{"sk_live_1234567890abcdef"}}')).toBe(false);
    expect(isNonSecretLiteral("={{'sk_live_12345678'}}")).toBe(false);
    expect(isNonSecretLiteral('={{ "sk_live_1234567" }}')).toBe(true);
    expect(isNonSecretLiteral('={{ "sk_live_" + $json.suffix }}')).toBe(true);
    expect(isNonSecretLiteral('={{ $json["sk_live_1234567890abcdef"] }}')).toBe(true);
    expect(isNonSecretLiteral('={{ $credentials.token }}')).toBe(true);
  });

  it('builds complete findings with deterministic defaults', () => {
    const finding = nodeFinding({
      policyId: 'TEST_POLICY',
      severity: 'HIGH',
      node,
      evidence: { source: 'fixture' },
      message: 'Review this node.',
      remediation: 'Apply the documented control.',
    });

    expect(finding).toEqual({
      policyId: 'TEST_POLICY',
      title: 'Review this node.',
      severity: 'HIGH',
      location: { nodeId: 'node-1', nodeName: 'HTTP request' },
      evidence: { source: 'fixture' },
      message: 'Review this node.',
      explanation: 'Review this node.',
      whyItMatters: 'This issue can change the trust boundary, data exposure, or operational behavior of the workflow.',
      possibleImpact: 'The workflow may be harder to review, monitor, or operate safely without additional controls.',
      remediation: 'Apply the documented control.',
      remediationSteps: ['Apply the documented control.'],
      confidence: 'MEDIUM',
    });
    expect(JSON.stringify(finding)).toBe(JSON.stringify(nodeFinding({
      policyId: 'TEST_POLICY', severity: 'HIGH', node, evidence: { source: 'fixture' },
      message: 'Review this node.', remediation: 'Apply the documented control.',
    })));
  });

  it('recognizes object and name/value Authorization header forms', () => {
    expect(authorizationHeaderEvidence({ Authorization: 'Bearer literal-token' }))
      .toEqual({ present: true, literal: true });
    expect(authorizationHeaderEvidence({ headers: [{ name: 'Authorization', value: '={{ $credentials.token }}' }] }))
      .toEqual({ present: true, literal: false });
    expect(authorizationHeaderEvidence({ headers: { authorization: '<API_TOKEN>' } }))
      .toEqual({ present: true, literal: false });
    expect(authorizationHeaderEvidence({ headers: { 'X-Other': 'value' } }))
      .toEqual({ present: false, literal: false });
  });

  it('collects only absolute HTTP(S) URLs recursively', () => {
    const urls = collectUrls({
      primary: 'https://api.example.test/v1',
      nested: ['http://localhost:5678/hook', '/relative', 'ftp://files.example.test/a'],
      ignored: 42,
    });

    expect(urls.map((url) => url.href)).toEqual([
      'https://api.example.test/v1',
      'http://localhost:5678/hook',
    ]);
  });

  it('collects literal URL islands and ignores evaluated islands', () => {
    expect(collectUrls('=https://evil.example.com/exfil').map((url) => url.hostname))
      .toEqual(['evil.example.com']);
    expect(collectUrls('https://api.example.test/v1/{{ $json.path }}').map((url) => url.hostname))
      .toEqual(['api.example.test']);
    expect(collectUrls('={{ $json.url }}')).toEqual([]);
    expect(collectUrls("='https://' + $json.x")).toEqual([]);
  });

  it('preserves FOUND, NONE and UNKNOWN at the collector seam', () => {
    expect(collectUrlOutcome('https://api.example.test/v1')).toMatchObject({
      state: 'FOUND',
      urls: [expect.objectContaining({ hostname: 'api.example.test' })],
    });
    expect(collectUrlOutcome('no destination here')).toMatchObject({ state: 'NONE', urls: [] });
    expect(collectUrlOutcome('={{ $json.url }}')).toMatchObject({
      state: 'UNKNOWN',
      reason: 'DYNAMIC',
      urls: [],
    });
    expect(collectUrlOutcome("='https://' + 1 + '.evil.example'")).toMatchObject({
      state: 'UNKNOWN',
      reason: 'UNSUPPORTED',
      urls: [],
    });
    expect(collectUrlOutcome('=https://api.example.test{{$json.suffix}}/x')).toMatchObject({
      state: 'UNKNOWN',
      reason: 'DYNAMIC',
      urls: [],
    });
  });

  it('keeps dynamic text UNKNOWN with its reason and omission count', () => {
    expect(collectUrlOutcome('={{ $json.url }}')).toEqual({
      state: 'UNKNOWN',
      reason: 'DYNAMIC',
      urls: [],
      omitted: 1,
    });
  });

  it('collects literal-only concatenated and template URLs', () => {
    expect(collectUrls("='https://api.example/' + 'v1'").map((url) => url.href)).toEqual(['https://api.example/v1']);
    expect(collectUrls("=`https://${'api.example'}${'/'}`").map((url) => url.href)).toEqual(['https://api.example/']);
    expect(collectUrls("='https://' + $json.host")).toEqual([]);
  });

  it('normalizes host/scheme/port and redacts userinfo, query and fragment', () => {
    expect(collectUrls('HTTPS://API.Example.TEST:443/x?token=sentinel#frag').map((url) => url.href))
      .toEqual(['https://api.example.test/x']);
    expect(collectUrls('https://user:pass@example.test/x').map((url) => url.href)).toEqual(['https://example.test/x']);
    expect(collectUrls('http://127.0.0.1:5678/hook').map((url) => url.hostname)).toEqual(['127.0.0.1']);
    expect(collectUrls('http://[::1]:5678/hook').map((url) => url.hostname)).toEqual(['[::1]']);
    expect(collectUrls('=https://{{ $env.HOST }}/x')).toEqual([]);
  });

  it('treats only an explicit non-none webhook authentication mode as authenticated', () => {
    expect(hasWebhookAuthentication({ authentication: 'headerAuth' })).toBe(true);
    expect(hasWebhookAuthentication({ authentication: 'NONE' })).toBe(false);
    expect(hasWebhookAuthentication({ authentication: '' })).toBe(false);
    expect(hasWebhookAuthentication({})).toBe(false);
    expect(hasWebhookAuthentication({ authentication: true })).toBe(false);
  });
});
