import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import { makeEntry, makeSource } from '../../test-support/make-entry';
import { DetailHeader } from './header';

afterEach(() => cleanup());

describe('DetailHeader action label', () => {
  it('labels the redistributable static CTA as opening the interactive view and targets it', () => {
    const entry = makeEntry({ rights: { status: 'redistributable' } });
    const { container } = render(
      <DetailHeader entry={entry} staticDownloadHref="/w/view/?id=abc" />,
    );

    const link = container.querySelector('a[href="/w/view/?id=abc"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toBe('Open interactive view to download');
    expect(link.getAttribute('href')).toBe('/w/view/?id=abc');
  });

  it('labels the redistributable interactive CTA as a real download control', () => {
    const entry = makeEntry({
      rights: { status: 'redistributable' },
      download: { pack: 0, line: 0, offset: 0, length: 10 },
    });
    const { getByRole } = render(<DetailHeader entry={entry} />);

    const button = getByRole('button', { name: 'Download workflow' });
    expect(button).toBeTruthy();
    expect(button.getAttribute('href')).toBeNull();
  });

  it('labels a link-only GitHub CTA honestly and targets the GitHub source', () => {
    const source = makeSource({
      kind: 'github',
      permalink: 'https://github.com/example/workflows/blob/main/booking.json',
    });
    const entry = makeEntry({
      source,
      rights: { status: 'link_only', licence: null, licenceUrl: null },
    });
    const { getByRole } = render(<DetailHeader entry={entry} />);

    const link = getByRole('link', { name: 'View on GitHub' });
    expect(link.textContent).toBe('View on GitHub');
    expect(link.getAttribute('href')).toBe(source.permalink);
  });

  it('labels a link-only n8n official CTA honestly and targets the n8n source', () => {
    const source = makeSource({
      kind: 'n8n_official',
      permalink: 'https://n8n.io/workflows/12345',
    });
    const entry = makeEntry({
      source,
      rights: { status: 'link_only', licence: null, licenceUrl: null },
    });
    const { getByRole } = render(<DetailHeader entry={entry} />);

    const link = getByRole('link', { name: 'View on n8n.io' });
    expect(link.textContent).toBe('View on n8n.io');
    expect(link.getAttribute('href')).toBe(source.permalink);
  });

  it('withholds source actions when the acquired permalink is unsafe', () => {
    const entry = makeEntry({
      source: makeSource({ kind: 'github', permalink: 'javascript:alert(1)' }),
      rights: { status: 'link_only', licence: null, licenceUrl: null },
    });
    const { container } = render(<DetailHeader entry={entry} />);
    const view = within(container);

    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(view.queryByRole('link', { name: 'View on GitHub' })).toBeNull();
    expect(view.getByText('Source link unavailable.')).toBeTruthy();
  });

  it('keeps the current detail breadcrumb as the current page for unusual slugs', () => {
    const entry = makeEntry({ slug: 'folder/name?one' });
    const { container } = render(<DetailHeader entry={entry} />);
    const currentPage = container.querySelector('[aria-current="page"]');

    expect(currentPage?.textContent).toContain(entry.title);
    expect(container.querySelector('a[href^="/w/folder/"]')).toBeNull();
  });
});
