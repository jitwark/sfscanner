// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { makeEntry } from '../test-support/make-entry';
import { RelatedRail } from './related-rail';

afterEach(() => cleanup());

describe('RelatedRail', () => {
  it('removes self-links and duplicate ids before applying the six-link limit', () => {
    const entry = makeEntry({ id: 'current', slug: 'current' });
    const related = [
      entry,
      makeEntry({ id: 'first', slug: 'first' }),
      makeEntry({ id: 'first', slug: 'first-copy' }),
      makeEntry({ id: 'second', slug: 'second' }),
    ];

    render(<RelatedRail entry={entry} related={related} />);

    const section = screen.getByRole('heading', { name: 'Related workflows' }).parentElement!;
    const links = within(section).getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/w/first/', '/w/second/']);
  });

  it('shows the empty state when every supplied target is ineligible', () => {
    const entry = makeEntry({ id: 'current', slug: 'current' });

    render(<RelatedRail entry={entry} related={[entry, entry]} />);

    const section = screen.getByRole('heading', { name: 'Related workflows' }).parentElement!;
    expect(within(section).getByText('No related workflows are available yet.')).toBeDefined();
    expect(within(section).queryAllByRole('link')).toHaveLength(0);
  });
});
