import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SiteFooter } from './site-footer';

/**
 * The footer is the only place on the site that offers a removal channel, so a
 * dead link here is not a cosmetic defect — it is the difference between having
 * a takedown process and not having one. The 2026-08-25 audit (TD-1) found the
 * link pointing at a repository that returns 404 to an unauthenticated visitor.
 *
 * This asserts the property that would have caught it: every internal href in
 * the site chrome resolves to a route that exists on disk.
 *
 * Queries are scoped to `container` rather than `screen` because this project
 * does not enable Vitest globals, so Testing Library's automatic per-test
 * cleanup never registers and renders accumulate in the same document.
 */

/** `app/app/`, resolved from this file rather than from an assumed cwd. */
const ROUTES_DIR = join(import.meta.dirname, '..', '..', 'app');

const normalizePath = (href: string | null) => (href ?? '').replace(/\/+$/, '') || '/';

describe('SiteFooter', () => {
  it('links only to routes that exist', () => {
    const { container } = render(<SiteFooter />);
    const hrefs = Array.from(container.querySelectorAll('a[href^="/"]'))
      .map((anchor) => anchor.getAttribute('href') ?? '')
      .filter((href) => !href.startsWith('//'));

    expect(hrefs.length).toBeGreaterThan(0);

    const missing = hrefs.filter((href) => !existsSync(join(ROUTES_DIR, href.replace(/^\/|\/$/g, ''))));
    expect(missing, `footer links with no route directory: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not offer a takedown action in the global footer', () => {
    const { container } = render(<SiteFooter />);
    expect(within(container).queryByRole('link', { name: /takedown/i })).toBeNull();
  });

  it('offers terms alongside the other project pages', () => {
    const { container } = render(<SiteFooter />);
    const terms = within(container).getByRole('link', { name: 'Terms' });
    expect(normalizePath(terms.getAttribute('href'))).toBe('/terms');
  });
});
