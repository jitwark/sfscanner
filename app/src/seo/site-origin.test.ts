import { afterEach, describe, expect, it, vi } from 'vitest';
import { absoluteSiteUrl, siteOrigin, siteUrl } from './site-origin';

afterEach(() => vi.unstubAllEnvs());

describe('siteOrigin', () => {
  it('returns null without configuration', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(siteOrigin()).toBeNull();
    expect(siteUrl()).toBeNull();
    expect(absoluteSiteUrl('/w/x/')).toBeNull();
  });

  it('accepts https with a base path and one trailing slash', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://owner.github.io/repo/');
    expect(siteOrigin()).toBe('https://owner.github.io/repo');
    expect(absoluteSiteUrl('/w/x/')).toBe('https://owner.github.io/repo/w/x/');
    expect(absoluteSiteUrl('w/x/')).toBe('https://owner.github.io/repo/w/x/');
  });

  it.each(['http://x.test', 'https://u:p@x.test', 'https://x.test/?a=1', 'https://x.test/#a', 'not-a-url'])(
    'rejects unsafe %s',
    (value) => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', value);
      expect(siteOrigin()).toBeNull();
    },
  );
});
