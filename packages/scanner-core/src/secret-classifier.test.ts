import { describe, expect, it } from 'vitest';
import { classifyLiteralSegments, MAX_SECRET_INDICATORS, classifySecretValue } from './secret-classifier';
import { PROVIDER_TOKEN_PATTERNS } from './provider-token-patterns';

describe('scanner-core secret classification contract', () => {
  it('recognizes catalogued provider canaries and rejects near misses', () => {
    for (const entry of PROVIDER_TOKEN_PATTERNS) {
      const classification = classifySecretValue(entry.canary.positive);
      if (entry.surfaces.some((surface) => surface === 'classify')) {
        expect(classification).toEqual({ kind: entry.kind });
      } else {
        expect(classification).toBeUndefined();
      }
      expect(classifySecretValue(entry.canary.nearMiss)).toBeUndefined();
    }
  });

  it('requires a sensitive context and entropy for opaque values', () => {
    const opaque = 'M5y$8Vq2Zr!7Ka9Wn4Cp6Xt3Hd0Ls1Be';

    expect(classifySecretValue(opaque, 'clientSecret')).toEqual({ kind: 'opaque secret' });
    expect(classifySecretValue(opaque)).toBeUndefined();
    expect(classifySecretValue('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'clientSecret')).toBeUndefined();
  });

  it('never classifies dynamic references or oversized values', () => {
    expect(classifySecretValue('={{ $env.API_KEY }}', 'apiKey')).toBeUndefined();
    expect(classifySecretValue('a'.repeat(4_097), 'apiKey')).toBeUndefined();
  });
  it('classifies the literal island behind the expression marker', () => {
    expect(classifySecretValue('=sk_live_12345678')).toEqual({ kind: 'Stripe API key' });
    expect(classifySecretValue('=sk_live_12345678{{ $json.value }}')).toEqual({ kind: 'Stripe API key' });
    expect(classifySecretValue(`=M5y$8Vq2Zr!7Ka9Wn4Cp6Xt3Hd0Ls1Be`, 'clientSecret')).toEqual({ kind: 'opaque secret' });
  });

  it('never classifies expression-mode dynamics', () => {
    expect(classifySecretValue('={{ $env.API_KEY }}', 'apiKey')).toBeUndefined();
    expect(classifySecretValue("='https://' + $json.x", 'apiKey')).toBeUndefined();
    expect(classifySecretValue('=', 'apiKey')).toBeUndefined();
  });
  it('classifies complete provider tokens in quoted expression strings without reading property names', () => {
    expect(classifySecretValue('={{"sk_live_1234567890abcdef"}}')).toEqual({ kind: 'Stripe API key' });
    expect(classifySecretValue("={{'sk_live_12345678'}}")).toEqual({ kind: 'Stripe API key' });
    expect(classifySecretValue('={{ "sk_live_1234567" }}')).toBeUndefined();
    expect(classifySecretValue('={{ "sk_live_" + $json.suffix }}')).toBeUndefined();
    expect(classifySecretValue('={{ $json["sk_live_1234567890abcdef"] }}')).toBeUndefined();
    expect(classifySecretValue('={{ $credentials.token }}', 'apiKey')).toBeUndefined();
    expect(classifyLiteralSegments('={{"sk_live_1234567890abcdef"}}')).toMatchObject({
      classification: { kind: 'Stripe API key' },
      indicatorCount: 1,
      omitted: false,
    });
  });

  it('never fabricates a provider token by removing a backslash escape', () => {
    // The scanned literal keeps the two-character escape: `sk_live_1234\n5678` is not a token.
    expect(classifySecretValue('={{"sk_live_1234\\n5678"}}')).toBeUndefined();
    expect(classifySecretValue('={{"sk_live_1234\\\\5678"}}')).toBeUndefined();
    expect(classifySecretValue('={{"sk_live_1234567890abcdef"}}')).toEqual({ kind: 'Stripe API key' });
  });

  it('classifies a literal provider token on either side of an expression', () => {
    expect(classifySecretValue('sk_live_12345678{{ $json.value }}suffix')).toEqual({ kind: 'Stripe API key' });
    expect(classifySecretValue('prefix{{ $json.value }}sk_live_12345678')).toEqual({ kind: 'Stripe API key' });
  });

  it('does not turn anchored placeholders or provider near misses into secrets', () => {
    expect(classifySecretValue('<your-password>', 'password')).toBeUndefined();
    expect(classifySecretValue('[sk_live_12345678]')).toEqual({ kind: 'Stripe API key' });
    expect(classifySecretValue('prefix{{ $json.value }}sk_live_1234567')).toBeUndefined();
  });
  it('bounds literal indicator accounting without exposing source values', () => {
    expect(MAX_SECRET_INDICATORS).toBe(10);
    const token = 'sk_live_12345678';
    const repeated = Array.from({ length: MAX_SECRET_INDICATORS + 2 }, () => `${token}{{ value }}`).join('');
    const classification = classifySecretValue(repeated);
    const segments = classifyLiteralSegments(repeated);
    expect(classification).toEqual({ kind: 'Stripe API key' });
    expect(segments).toMatchObject({ indicatorCount: MAX_SECRET_INDICATORS, omitted: true });
    expect(Object.isFrozen(segments)).toBe(true);
    expect(JSON.stringify(segments)).not.toContain(token);
  });
});
