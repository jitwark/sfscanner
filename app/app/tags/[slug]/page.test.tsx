import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TagPage, { generateMetadata } from './page';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('TagPage legacy stub', () => {
  it('prefixes the deployment base path on both the anchor href and meta-refresh', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/community-hub');

    const params = Promise.resolve({ slug: 'ai-agent' });
    const metadata = await generateMetadata({ params });
    expect(metadata.other?.['meta-refresh']).toBe('3;url=/community-hub/library/?tag=ai-agent');

    const component = await TagPage({ params });
    render(component);

    const anchor = screen.getByRole('link');
    expect(anchor.getAttribute('href')).toBe('/community-hub/library/?tag=ai-agent');
  });

  it('leaves the path root-relative when no base path is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');

    const params = Promise.resolve({ slug: 'ai-agent' });
    const metadata = await generateMetadata({ params });
    expect(metadata.other?.['meta-refresh']).toBe('3;url=/library/?tag=ai-agent');

    const component = await TagPage({ params });
    render(component);

    const anchor = screen.getByRole('link');
    expect(anchor.getAttribute('href')).toBe('/library/?tag=ai-agent');
  });
});
