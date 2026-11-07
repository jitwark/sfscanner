import { describe, expect, it } from 'vitest';
import { collectSecretIndicators } from './secret-indicators';

describe('secret indicator expression islands', () => {
  it('scores a provider token hidden behind the n8n expression marker', () => {
    expect(collectSecretIndicators({ apiKey: '=sk_live_1234567890abcdef' })).toEqual([
      {
        path: 'parameters.apiKey',
        kind: 'Stripe API key',
        indicator: 'sensitive_value',
        hasLiteralValue: true,
      },
    ]);
  });

  it('scores a literal island that sits beside an evaluated expression', () => {
    expect(collectSecretIndicators({ token: '=sk_live_1234567890abcdef{{ $json.suffix }}' })).toEqual([
      {
        path: 'parameters.token',
        kind: 'Stripe API key',
        indicator: 'sensitive_value',
        hasLiteralValue: true,
      },
    ]);
  });

  it('stays silent for pure-dynamic parameter values', () => {
    expect(collectSecretIndicators({ apiKey: '={{ $json.key }}' })).toEqual([]);
    expect(collectSecretIndicators({ apiKey: "='https://' + $json.x" })).toEqual([]);
  });
});

describe('credential plumbing is not secret material', () => {
  it('treats a credential reference block as plumbing rather than a secret', () => {
    expect(collectSecretIndicators({ credentials: { slackApi: { id: '12', name: 'Slack' } } })).toEqual([]);
    expect(collectSecretIndicators({
      credentials: { openAiApi: { id: 'credential-id', name: 'openAiApi Credential' } },
    })).toEqual([]);
  });

  it('treats the credential type selector as plumbing rather than a secret', () => {
    expect(collectSecretIndicators({ nodeCredentialType: 'todoistApi' })).toEqual([]);
    expect(collectSecretIndicators({ nodeCredentialType: 'openAiApi' })).toEqual([]);
  });

  it('stays silent for a reference block nested inside a parameter object', () => {
    expect(collectSecretIndicators({
      options: { credentials: { openAiApi: { id: 'credential-id', name: 'openAiApi Credential' } } },
    })).toEqual([]);
  });

  it('keeps reporting a literal secret nested inside credential plumbing', () => {
    expect(collectSecretIndicators({ credentials: { apiKey: 'sk-proj-abcdefghijklmnop' } })).toEqual([
      {
        path: 'parameters.credentials.apiKey',
        kind: 'OpenAI API key',
        indicator: 'sensitive_value',
        hasLiteralValue: true,
      },
    ]);
    expect(collectSecretIndicators({ credentials: 'sk-proj-abcdefghijklmnop' })).toEqual([
      {
        path: 'parameters.credentials',
        kind: 'OpenAI API key',
        indicator: 'sensitive_value',
        hasLiteralValue: true,
      },
    ]);
  });

  it('keeps key classification for names outside the credential plumbing vocabulary', () => {
    expect(collectSecretIndicators({ credentialName: 'todoistApi' })).toEqual([
      {
        path: 'parameters.credentialName',
        kind: 'credential',
        indicator: 'sensitive_key',
        hasLiteralValue: true,
      },
    ]);
  });
});

describe('secret key names and placeholders outside credential plumbing are unchanged', () => {
  it('keeps scoring a provider token value under a secret-named key', () => {
    expect(collectSecretIndicators({ apiKey: 'sk-proj-abcdefghijklmnop' })).toEqual([
      {
        path: 'parameters.apiKey',
        kind: 'OpenAI API key',
        indicator: 'sensitive_value',
        hasLiteralValue: true,
      },
    ]);
  });

  it('keeps flagging the low-entropy-looking secret SC-05 anchored the vocabulary against', () => {
    expect(collectSecretIndicators({ api_key: 'my-api-key-lowentropy' })).toEqual([
      {
        path: 'parameters.api_key',
        kind: 'opaque secret',
        indicator: 'sensitive_value',
        hasLiteralValue: true,
      },
    ]);
  });

  it('keeps suppressing conventional placeholder values', () => {
    expect(collectSecretIndicators({ someToken: 'YOUR_TOKEN' })).toEqual([]);
    expect(collectSecretIndicators({ someToken: 'example-token' })).toEqual([]);
    expect(collectSecretIndicators({ someToken: '<todo>' })).toEqual([]);
  });

  it.each([
    ['authorization', 'authorization'],
    ['cookie', 'cookie'],
    ['password', 'password'],
    ['token', 'token'],
    ['secret', 'secret'],
    ['apikey', 'api key'],
    ['api_key', 'api key'],
    ['api-key', 'api key'],
  ])('keeps classifying key name %j as kind %j', (key, kind) => {
    expect(collectSecretIndicators({ [key]: 'abc123' })).toEqual([
      { path: `parameters.${key}`, kind, indicator: 'sensitive_key', hasLiteralValue: true },
    ]);
  });
});
