import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hubMeta } from '../../app/src/seo/page-meta';

const SITE_URL = 'https://example.test';

// The origin is call-time state, so pin it per test instead of relying on an
// ambient build variable that a module constant would have captured.
beforeEach(() => vi.stubEnv('NEXT_PUBLIC_SITE_URL', SITE_URL));
afterEach(() => vi.unstubAllEnvs());

function setBuildMode(mode) {
  vi.stubEnv('NEXT_PUBLIC_BUILD_MODE', mode ?? '');
}

function metadataFor(mode) {
  setBuildMode(mode);
  return hubMeta('integration', 'openai');
}

describe('preview SEO build-mode contract', () => {
  it('keeps canonical and indexable metadata for every non-preview mode', () => {
    for (const mode of [undefined, '', 'production', 'prod', 'preview=false']) {
      const metadata = metadataFor(mode);

      expect(metadata.robots).toEqual({ index: true, follow: true });
      expect(metadata.alternates?.canonical).toBe(`${SITE_URL}/integrations/openai/`);
      expect(metadata.openGraph?.url).toBe(`${SITE_URL}/integrations/openai/`);
      expect(metadata.openGraph?.images).toEqual([{
        url: `${SITE_URL}/og/og-generic-LOW.png`,
        width: 1200,
        height: 630,
        alt: 'Openai n8n Workflows | n8n-secureflow',
      }]);
    }
  });

  it('uses preview noindex and omits production-origin metadata only for the explicit preview flag', () => {
    const metadata = metadataFor('preview');

    expect(metadata.robots).toEqual({ index: false, follow: false, noarchive: true, nosnippet: true });
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph).not.toHaveProperty('url');
    expect(metadata.openGraph).not.toHaveProperty('images');
    expect(metadata.twitter).not.toHaveProperty('images');
  });

  it('omits the origin-bearing fields in a non-preview build with no release origin', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    setBuildMode('production');
    const metadata = hubMeta('integration', 'openai');

    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph).not.toHaveProperty('url');
    expect(metadata.openGraph).not.toHaveProperty('images');
    expect(metadata.twitter).not.toHaveProperty('images');
  });
});
