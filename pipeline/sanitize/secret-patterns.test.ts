import { describe, expect, it } from 'vitest';
import { SECRET_PATTERNS } from './secret-patterns.js';

describe('SECRET_PATTERNS table tests', () => {
  it('has at least 15 patterns', () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(15);
  });

  it.each(SECRET_PATTERNS)('pattern "$name" passes positive and negative tests', (def) => {
    expect(def.name).toBeTruthy();

    // Positive test
    if (def.keyPattern) {
      const keyMatches = def.keyPattern.test(def.positiveTest.key ?? 'apiKey');
      const valMatches = def.pattern.test(def.positiveTest.value);
      expect(keyMatches).toBe(true);
      expect(valMatches).toBe(true);
    } else {
      expect(def.pattern.test(def.positiveTest.value)).toBe(true);
    }

    // Negative test
    if (def.keyPattern) {
      const keyMatches = def.keyPattern.test(def.negativeTest.key ?? 'apiKey');
      const valMatches = def.pattern.test(def.negativeTest.value);
      expect(keyMatches && valMatches).toBe(false);
    } else {
      expect(def.pattern.test(def.negativeTest.value)).toBe(false);
    }
  });
  it('does not classify ordinary words with provider-like prefixes as tokens', () => {
    const githubToken = SECRET_PATTERNS.find((definition) => definition.name === 'github_token');

    expect(githubToken?.pattern.test('ghostwritingpartner')).toBe(false);
  });
});
