import { describe, expect, it } from 'vitest';
import { classifyAnchoredPlaceholder } from './placeholder-classifier';

describe('anchored placeholder classification', () => {
  it('classifies reviewed whole-value placeholder forms without returning their text', () => {
    for (const value of ['<your-password>', '[API_KEY]', '__PLACEHOLDER_VALUE__', 'example-token', 'xxxx', '$env.API_KEY', '$json["value"]']) {
      const result = classifyAnchoredPlaceholder(value);
      expect(result).toMatchObject({ kind: 'PLACEHOLDER' });
      expect(result).not.toHaveProperty('value');
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  it('rejects unanchored placeholder prose and secret-looking near misses', () => {
    for (const value of ['prefix <your-password>', '<your-password> suffix', 'example-token-real', 'sk_live_placeholder12345678', '[sk_live_12345678]', '<sk_live_12345678>']) {
      expect(classifyAnchoredPlaceholder(value)).toBeUndefined();
    }
  });
  it('rejects malformed dynamic access paths', () => {
    for (const value of ['$json.', '$json..value', '$json[not-quoted]', '$json["unterminated]', '$json["a\\"]']) {
      expect(classifyAnchoredPlaceholder(value)).toBeUndefined();
    }
  });

  it('accepts unknown input without throwing', () => {
    expect(classifyAnchoredPlaceholder(null)).toBeUndefined();
    expect(classifyAnchoredPlaceholder({})).toBeUndefined();
    expect(classifyAnchoredPlaceholder(42)).toBeUndefined();
  });
});
