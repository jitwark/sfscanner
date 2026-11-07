import { describe, expect, it } from 'vitest';
import { classifySecretValue } from '../../secret-classifier';
import {
  classifyProviderToken,
  PROVIDER_TOKEN_GRAMMARS_V2,
} from './provider-token-registry';

// Synthetic compact-token shape only; scanner matching treats ghs_ values as opaque.
const githubJwt = `eyJ${'A'.repeat(80)}.eyJ${'B'.repeat(80)}.${'C'.repeat(342)}`;
const token = {
  bearer: 'Bearer opaque-token-value-123',
  basic: 'Basic YWJjZGVmZw==',
  stripe: 'sk_live_12345678',
  google: `AIza${'A'.repeat(35)}`,
  aws: `AKIA${'A'.repeat(16)}`,
  awsTemporary: `ASIA${'A'.repeat(16)}`,
  slack: 'xoxb-1234567890',
  github: `ghp_${'A'.repeat(36)}`,
  githubLong: `ghp_${'A'.repeat(251)}`,
  githubUnderscore: `ghp_${'A'.repeat(35)}_`,
  githubPat: `github_pat_${'A'.repeat(22)}_${'A'.repeat(59)}`,
  githubPatLong: `github_pat_${'A'.repeat(22)}_${'A'.repeat(82)}`,
  githubOAuth: `gho_${'A'.repeat(36)}`,
  githubAppUser: `ghu_${'A'.repeat(36)}`,
  githubAppInstallation: `ghs_${'A'.repeat(36)}`,
  githubAppStateless: `ghs_123456789_${githubJwt}`,
  githubAppRefresh: `ghr_${'A'.repeat(76)}`,
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl',
  anthropic: `sk-ant-api03-${'A'.repeat(20)}`,
  openai: `sk-proj-${'A'.repeat(20)}`,
  huggingFace: `hf_${'A'.repeat(20)}`,
  replicate: `r8_${'A'.repeat(37)}`,
  secureFlow: `sfk_22222222-2222-4222-8222-222222222222_AbCdEf12345.${'s'.repeat(43)}`,
} as const;

describe('provider token grammar registry', () => {
  it('exposes an immutable registry', () => {
    expect(Object.isFrozen(PROVIDER_TOKEN_GRAMMARS_V2)).toBe(true);
  });

  it('classifies Stripe restricted keys by shape and rejects the short near miss', () => {
    expect(classifyProviderToken('rk_live_12345678')).toEqual({ kind: 'Stripe restricted key' });
    expect(classifyProviderToken('rk_test_12345678')).toEqual({ kind: 'Stripe restricted key' });
    expect(classifySecretValue('rk_live_12345678')).toEqual({ kind: 'Stripe restricted key' });
    expect(classifyProviderToken('rk_live_1234567')).toBeUndefined();
    expect(classifyProviderToken('rk_test_1234567')).toBeUndefined();
    expect(classifySecretValue('rk_live_1234567')).toBeUndefined();
  });

  it('labels only complete reviewed provider tokens', () => {
    const expected = [
      ['bearer', 'bearer token'],
      ['basic', 'basic auth'],
      ['stripe', 'Stripe API key'],
      ['google', 'Google API key'],
      ['aws', 'AWS access key'],
      ['awsTemporary', 'AWS access key'],
      ['slack', 'Slack token'],
      ['github', 'GitHub token'],
      ['githubLong', 'GitHub token'],
      ['githubUnderscore', 'GitHub token'],
      ['githubPat', 'GitHub token'],
      ['githubPatLong', 'GitHub token'],
      ['githubOAuth', 'GitHub token'],
      ['githubAppUser', 'GitHub token'],
      ['githubAppInstallation', 'GitHub token'],
      ['githubAppStateless', 'GitHub token'],
      ['githubAppRefresh', 'GitHub token'],
      ['jwt', 'JWT'],
      ['anthropic', 'Anthropic API key'],
      ['openai', 'OpenAI API key'],
      ['huggingFace', 'Hugging Face token'],
      ['replicate', 'Replicate API token'],
    ] as const;

    for (const [name, kind] of expected) {
      expect(classifyProviderToken(token[name])).toEqual({ kind });
    }
  });

  it('rejects near misses for every reviewed grammar', () => {
    const nearMisses = [
      'Bearer short',
      'Bearer\nopaque-token-value-123',
      'Basic\nYWJjZGVmZw==',
      'Basic short',
      'sk_live_1234567',
      `AIza${'A'.repeat(34)}`,
      `AKIA${'A'.repeat(15)}`,
      `ASIA${'A'.repeat(15)}`,
      'xoxb-123456789',
      `ghp_${'A'.repeat(12)}`,
      `github_pat_${'A'.repeat(12)}`,
      `gho_${'A'.repeat(12)}`,
      `ghu_${'A'.repeat(12)}`,
      `ghs_${'A'.repeat(12)}`,
      `ghr_${'A'.repeat(12)}`,
      `ghp_${'A'.repeat(35)}`,
      `github_pat_${'A'.repeat(35)}`,
      `gho_${'A'.repeat(35)}`,
      `ghu_${'A'.repeat(35)}`,
      `ghs_${'A'.repeat(35)}`,
      `ghr_${'A'.repeat(35)}`,
      `ghr_${'A'.repeat(75)}`,
      `github_pat_${'A'.repeat(21)}_${'A'.repeat(59)}`,
      `github_pat_${'A'.repeat(22)}_${'A'.repeat(58)}`,
      'ghs_123456789_eyJ.eyJ.A',
      `ghp${'A'.repeat(12)}`,
      `glpat-${'A'.repeat(12)}`,
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.',
      `sk-ant-${'A'.repeat(19)}`,
      `sk-${'A'.repeat(19)}`,
      `hf_${'A'.repeat(19)}`,
      `r8_${'A'.repeat(36)}`,
    ];

    for (const value of nearMisses) expect(classifyProviderToken(value)).toBeUndefined();
  });
  it('keeps SecureFlow keys redaction-only', () => {
    const grammar = PROVIDER_TOKEN_GRAMMARS_V2.find(({ kind }) => kind === 'SecureFlow API key');
    expect(grammar?.surfaces).toEqual(['redact']);
    expect(classifyProviderToken(token.secureFlow)).toBeUndefined();
    expect(classifyProviderToken(
      `sfk_22222222-2222-4222-8222-222222222222_AbCdEf12345.${'s'.repeat(31)}`,
    )).toBeUndefined();
  });

  it('allows only the reviewed wrappers and preserves provider precedence', () => {
    expect(classifyProviderToken(`[${token.stripe}]`)).toEqual({ kind: 'Stripe API key' });
    expect(classifyProviderToken(`<${token.google}>`)).toEqual({ kind: 'Google API key' });
    expect(classifyProviderToken(`<${token.anthropic}>`)).toEqual({ kind: 'Anthropic API key' });
    expect(classifyProviderToken(token.anthropic)).toEqual({ kind: 'Anthropic API key' });
    expect(classifyProviderToken(token.openai)).toEqual({ kind: 'OpenAI API key' });
    expect(classifyProviderToken(`<${token.openai}>`)).toEqual({ kind: 'OpenAI API key' });
    expect(classifyProviderToken(`Bearer ${token.stripe}`)).toEqual({ kind: 'bearer token' });
  });

  it('does not label embedded tokens or locale lookalikes', () => {
    expect(classifyProviderToken(`prefix-${token.stripe}`)).toBeUndefined();
    expect(classifyProviderToken(`${token.google}-suffix`)).toBeUndefined();
    expect(classifyProviderToken(`\u0130${token.aws.slice(1)}`)).toBeUndefined();
    expect(classifyProviderToken(token.stripe.toUpperCase())).toBeUndefined();
    expect(classifyProviderToken(null)).toBeUndefined();
    expect(classifyProviderToken(42)).toBeUndefined();
  });

  it('returns only a safe label and remains deterministic across repeated calls', () => {
    const result = classifyProviderToken(token.github);
    expect(result).toEqual({ kind: 'GitHub token' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token.github);
    expect(Array.from({ length: 20 }, () => classifyProviderToken(token.github))).toEqual(
      Array.from({ length: 20 }, () => ({ kind: 'GitHub token' })),
    );
  });

  it('leaves unreviewed values to generic secret fallback', () => {
    const unreviewed = 'M5y$8Vq2Zr!7Ka9Wn4Cp6Xt3Hd0Ls1Be';
    expect(classifyProviderToken(unreviewed)).toBeUndefined();
    expect(classifySecretValue(unreviewed, 'clientSecret')).toEqual({ kind: 'opaque secret' });
    expect(JSON.stringify(classifySecretValue(unreviewed, 'clientSecret'))).not.toContain(unreviewed);

    const shortGitHubLookalike = `ghp_${'A'.repeat(12)}`;
    expect(classifyProviderToken(shortGitHubLookalike)).toBeUndefined();
  });
});
