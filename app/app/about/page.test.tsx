import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A passthrough so the assertions inspect what this page actually renders (and
// hands to `pageJsonLd`); the schema.org transformation has its own tests.
vi.mock('../../src/seo/json-ld', () => ({
  JsonLdScript: ({ data }: { data: { description?: string } }) => (
    <script data-testid="jsonld">{JSON.stringify(data)}</script>
  ),
  pageJsonLd: (options: unknown) => options,
}));

import AboutPage from './page';

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe('AboutPage', () => {
  /**
   * Both project repositories are private, so a hardcoded link and an invitation
   * to open one were both false. The page may describe the repository; it may
   * not render an anchor or a future invitation the build cannot honour.
   */
  it('does not claim the source is publicly available', () => {
    render(<AboutPage />);

    const copy = document.body.textContent!.replace(/\s+/g, ' ');
    expect(copy).not.toContain('publicly available on GitHub');
    expect(copy).toContain(
      'Source code, deterministic security rules, and pipeline tools live in the project repository, which is not publicly available at the time of this build.',
    );
  });

  it('omits the repository link without configuration', () => {
    render(<AboutPage />);

    expect(screen.queryByRole('link', { name: /github/i })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Takedown Procedure' })).toBeTruthy();
  });

  it('renders the configured repository link', () => {
    vi.stubEnv('NEXT_PUBLIC_PRODUCT_REPOSITORY_URL', 'https://example.test/repo');
    render(<AboutPage />);

    expect(screen.getByRole('link', { name: /example\.test\/repo/ }).getAttribute('href'))
      .toBe('https://example.test/repo');
    expect(document.body.textContent).not.toContain('not publicly available at the time of this build');
  });

  it('does not invite the reader to open a repository it does not link', () => {
    render(<AboutPage />);

    const copy = document.body.textContent!.replace(/\s+/g, ' ');
    expect(copy).not.toContain('Once that repository is public');
    expect(copy).not.toContain('Inspect the source, report issues, and contribute new policies at our GitHub repository');
  });
});
