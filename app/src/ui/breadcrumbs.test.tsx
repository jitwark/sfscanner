import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Breadcrumbs } from './breadcrumbs';

vi.mock('next/link', () => ({
  default: ({ href, prefetch, className, children }: {
    href: string;
    prefetch?: boolean;
    className?: string;
    children: ReactNode;
  }) => <a href={href} className={className} data-prefetch={prefetch === false ? 'false' : 'unset'}>{children}</a>,
}));

afterEach(() => cleanup());

/**
 * P3.1 (2026-08-27): the trailing (current-page) crumb had `flex-1` with no
 * `min-width`, so on a four-level trail it competed for space against earlier
 * crumbs sized by their own content — and since the earlier crumbs' sizes
 * already summed to nearly the container width, the flex algorithm treated
 * the line as having *positive* slack and handed the flex-1 item only that
 * slack (measured live at 320px on `/w/view/`: 9px, for a title that needed
 * hundreds), rather than shrinking the earlier crumbs to make room. Confirmed
 * fixed live: `docs/audit/2026-08-26/baseline/phase-0-p0.4-baseline.md`'s
 * `/w/view/` overflow finding no longer reproduces once the trailing crumb
 * carries its own `min-width` floor, which forces the browser into
 * shrink-to-fit instead.
 *
 * jsdom does not lay out flexbox, so this only pins the structural fix (the
 * trailing crumb has a `min-w-*` floor instead of relying solely on
 * `min-w-0`); the real, browser-measured regression guard is the Playwright
 * spec in `e2e/no-horizontal-overflow.spec.ts`.
 */
describe('Breadcrumbs', () => {
  it('gives the trailing (current-page) crumb a minimum-width floor so earlier crumbs shrink first', () => {
    const { container } = render(
      <Breadcrumbs
        items={[
          { label: 'Home', href: '/' },
          { label: 'Integrations', href: '/integrations/' },
          { label: 'acuity-scheduling', href: '/library/?integration=acuity-scheduling' },
          { label: 'Receive updates on appointments via Acuity Scheduling' },
        ]}
      />,
    );

    const items = container.querySelectorAll('ol > li');
    expect(items).toHaveLength(4);

    const [first, , , last] = Array.from(items);
    // Earlier crumbs stay free to shrink to nothing rather than hold space
    // hostage from the trailing one.
    expect(first!.className).toContain('min-w-0');
    // The trailing crumb no longer relies on leftover flex space: it claims a
    // floor up front.
    expect(last!.className).not.toContain('min-w-0');
    expect(last!.className).toMatch(/min-w-(28|40|\[)/);
    expect(last!.className).toContain('flex-1');
  });

  it('disables RSC prefetch for static-export breadcrumb links', () => {
    const { container } = render(
      <Breadcrumbs
        items={[
          { label: 'Home', href: '/' },
          { label: 'Integrations', href: '/integrations/' },
          { label: 'gmail', href: '/library/?integration=gmail' },
          { label: 'ClientFlow' },
        ]}
      />,
    );

    const links = [...container.querySelectorAll('ol a')];
    expect(links).toHaveLength(3);
    expect(links.map((link) => link.getAttribute('data-prefetch'))).toEqual(['false', 'false', 'false']);
  });
});
