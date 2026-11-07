import { afterEach, describe, expect, it, vi } from 'vitest';
import { productRepositoryUrl, scannerRuleReferenceUrl } from './product-links';

afterEach(() => vi.unstubAllEnvs());

describe('product links', () => {
  it('allows a fragment on the rule reference', () => {
    vi.stubEnv('NEXT_PUBLIC_RULE_REFERENCE_URL', 'https://example.test/rules#profiles');
    expect(scannerRuleReferenceUrl()).toBe('https://example.test/rules#profiles');
  });

  it('keeps a query on the repository link', () => {
    vi.stubEnv('NEXT_PUBLIC_PRODUCT_REPOSITORY_URL', 'https://example.test/repo?tab=readme');
    expect(productRepositoryUrl()).toBe('https://example.test/repo?tab=readme');
  });

  it.each(['http://example.test', 'https://u:p@example.test', '', 'not-a-url', '  '])(
    'rejects %s',
    (value) => {
      vi.stubEnv('NEXT_PUBLIC_PRODUCT_REPOSITORY_URL', value);
      vi.stubEnv('NEXT_PUBLIC_RULE_REFERENCE_URL', value);
      expect(productRepositoryUrl()).toBeNull();
      expect(scannerRuleReferenceUrl()).toBeNull();
    },
  );

  it('omits both links when nothing is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_PRODUCT_REPOSITORY_URL', '');
    vi.stubEnv('NEXT_PUBLIC_RULE_REFERENCE_URL', '');
    expect(productRepositoryUrl()).toBeNull();
    expect(scannerRuleReferenceUrl()).toBeNull();
  });
});
