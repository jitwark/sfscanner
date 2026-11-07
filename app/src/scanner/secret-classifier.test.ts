import { describe, expect, it } from 'vitest';
import { PROVIDER_TOKEN_PATTERNS } from '@hub/scanner-core/provider-token-patterns';
import { classifySecretValue } from '@hub/scanner-core/secret-classifier';

describe('classifySecretValue', () => {
  it('classifies provider-shaped values without returning the value', () => {
    expect(classifySecretValue(`AIza${'A'.repeat(35)}`)).toEqual({ kind: 'Google API key' });
  });

  it('retains recognition of raw authorization values', () => {
    expect(classifySecretValue('Bearer opaque-token-value-123')).toEqual({ kind: 'bearer token' });
  });

  it('requires context, safe syntax, and entropy before classifying an opaque secret', () => {
    const opaque = 'M5y$8Vq2Zr!7Ka9Wn4Cp6Xt3Hd0Ls1Be';

    expect(classifySecretValue(opaque, 'clientSecret')).toEqual({ kind: 'opaque secret' });
    expect(classifySecretValue(opaque)).toBeUndefined();
    expect(classifySecretValue('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'clientSecret')).toBeUndefined();
  });

  it('does not classify dynamic expressions or oversized text', () => {
    expect(classifySecretValue('={{ $env.API_KEY }}', 'apiKey')).toBeUndefined();
    expect(classifySecretValue('a'.repeat(4_097), 'apiKey')).toBeUndefined();
  });

  it('classifies every catalogued provider canary and rejects its near miss', () => {
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

  it('checks the sk- collision in favor of Anthropic', () => {
    const anthropic = PROVIDER_TOKEN_PATTERNS.find(({ kind }) => kind === 'Anthropic API key');
    if (!anthropic) throw new Error('Anthropic provider pattern is missing');

    expect(classifySecretValue(anthropic.canary.positive)).toEqual({ kind: 'Anthropic API key' });
  });
});
