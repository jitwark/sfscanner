import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AboutPage from '../../../app/about/page';
import PrivacyPage from '../../../app/privacy/page';

/**
 * Both pages must send a removal request through the controlled `/takedown/`
 * route rather than the About page's public copy or a public issue tracker.
 * Queries are scoped to `container` because Vitest globals (and Testing
 * Library's automatic per-test cleanup) are not enabled in this project.
 *
 * `trailingSlash: true` in next.config is a build-time rewrite that does not
 * run under plain component rendering, so hrefs are compared with a trailing
 * slash stripped (matching site-footer.test.tsx's normalizePath approach).
 */

const normalizePath = (href: string | null) => (href ?? '').replace(/\/+$/, '') || '/';

describe('takedown navigation', () => {
  it('links the About page Takedown Procedure to /takedown/', () => {
    const { container } = render(<AboutPage />);
    const link = within(container).getByRole('link', { name: /takedown request page/i });
    expect(normalizePath(link.getAttribute('href'))).toBe('/takedown');
  });

  it('links the Privacy page removal guidance to /takedown/, not /about/', () => {
    const { container } = render(<PrivacyPage />);
    const link = within(container).getByRole('link', { name: /takedown request page/i });
    expect(normalizePath(link.getAttribute('href'))).toBe('/takedown');
  });

  it('describes local theme storage and hosting logs without claiming zero browser storage', () => {
    const { container } = render(<PrivacyPage />);
    const text = container.textContent ?? '';

    expect(text).toContain('theme preference');
    expect(text).not.toContain('no local storage beyond the browser');
    expect(text).toContain('hosting provider may observe or retain request metadata');
  });
});
