import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { makeEntry, makeSource } from '../../test-support/make-entry';
import { Provenance } from './provenance';

afterEach(() => cleanup());

/**
 * P5.3: stars, repository path, and commit are release/audit evidence, not
 * public-facing facts. They must never reach the rendered public Provenance
 * panel, in any variant, while staying untouched on the `Entry`/`EntrySource`
 * data model these tests build from.
 */
describe('Provenance author redaction', () => {
  it('shows the withheld label for an email-only author on the default layout', () => {
    const base = makeEntry({ source: makeSource({ kind: 'github' }) });
    const entry: Entry = { ...base, source: { ...base.source, author: { name: '[email]' } } };
    const { container } = render(<Provenance entry={entry} />);

    expect(within(container).getByText('Author contact withheld')).toBeTruthy();
    expect(container.textContent).not.toContain('[email]');
  });

  it('keeps the non-email part of a mixed author name', () => {
    const base = makeEntry({ source: makeSource({ kind: 'github' }) });
    const entry: Entry = { ...base, source: { ...base.source, author: { name: 'Alice <[email]>' } } };
    const { container } = render(<Provenance entry={entry} />);

    expect(within(container).getByText('Alice <[email]>')).toBeTruthy();
  });
});

describe('Provenance', () => {
  it('omits stars, path, and commit for a github source that carries all three', () => {
    const entry = makeEntry({
      source: makeSource({ kind: 'github', stars: 4200, path: 'workflows/deep/nested/example.json', commit: 'abc1234567890def' }),
    });
    const { container } = render(<Provenance entry={entry} />);
    const view = within(container);

    expect(view.queryByText('Stars')).toBeNull();
    expect(view.queryByText('Path')).toBeNull();
    expect(view.queryByText('Commit')).toBeNull();
    expect(container.textContent).not.toContain('workflows/deep/nested/example.json');
    expect(container.textContent).not.toContain('abc1234');

    // What must still be shown, accurately.
    expect(view.getByText('Source')).toBeTruthy();
    expect(view.getByText('Source type')).toBeTruthy();
    expect(view.getByRole('link', { name: 'owner/repo' })).toBeTruthy();
    expect(view.getByText('Author')).toBeTruthy();
    expect(view.getByText('Fetched')).toBeTruthy();
    expect(view.getByText('Licence')).toBeTruthy();

    // The source object itself is untouched — this is a presentation redaction.
    expect(entry.source.stars).toBe(4200);
    expect(entry.source.path).toBe('workflows/deep/nested/example.json');
    expect(entry.source.commit).toBe('abc1234567890def');
  });

  it('renders the official n8n source honestly, which never carried these fields', () => {
    const entry = makeEntry({ source: makeSource({ kind: 'n8n_official' }) });
    const { container } = render(<Provenance entry={entry} />);
    const view = within(container);

    expect(view.queryByText('Stars')).toBeNull();
    expect(view.queryByText('Path')).toBeNull();
    expect(view.queryByText('Commit')).toBeNull();
    expect(view.getByRole('link', { name: 'n8n.io' })).toBeTruthy();
    expect(view.getByText('Official n8n template')).toBeTruthy();
  });

  it('omits stars, path, and commit even when only some of them are present', () => {
    const base = makeEntry({ source: makeSource({ kind: 'github' }) });
    const entry: Entry = { ...base, source: { ...base.source, stars: 99, path: undefined, commit: undefined } };
    const { container } = render(<Provenance entry={entry} />);
    const view = within(container);

    expect(view.queryByText('Stars')).toBeNull();
    expect(view.queryByText('Path')).toBeNull();
    expect(view.queryByText('Commit')).toBeNull();
    // Author is still present and un-redacted; the fix is scoped to three fields.
    expect(view.getByText('Author')).toBeTruthy();
  });

  it.each([
    ['redistributable', 'MIT', 'repo licence MIT - permitted for redistribution'],
    ['link_only', 'Unlicensed', 'official n8n template - linked, not redistributed'],
  ] as const)('keeps %s rights evidence explicit', (status, licence, reason) => {
    const entry = makeEntry({ rights: { status } });
    const { container } = render(<Provenance entry={entry} />);
    const view = within(container);

    expect(view.getByText(licence)).toBeTruthy();
    expect(view.getByText(reason)).toBeTruthy();
  });

  it('shows unknown author and keeps a licence without a URL as plain text', () => {
    const base = makeEntry({
      rights: { status: 'link_only', licence: 'Custom terms', licenceUrl: null, reason: 'Hosted upstream' },
    });
    const entry: Entry = { ...base, source: { ...base.source, author: undefined } };
    const { container } = render(<Provenance entry={entry} />);
    const view = within(container);

    expect(view.getByText('Author')).toBeTruthy();
    expect(view.getByText('Unknown')).toBeTruthy();
    expect(view.getByText('Custom terms')).toBeTruthy();
    expect(view.queryByRole('link', { name: 'Custom terms' })).toBeNull();
  });

  it('renders acquired source facts and the source verification date without inference', () => {
    const sourceUrl = 'https://github.com/acme/flows/blob/0123456789abcdef/workflows/mail.json';
    const entry = makeEntry({
      source: makeSource({
        kind: 'github',
        repo: 'acme/flows',
        permalink: sourceUrl,
        author: { name: 'Dana Maintainer', url: 'https://github.com/dana-maintainer' },
        fetchedAt: '2026-08-30T12:34:56.000Z',
      }),
      rights: { status: 'link_only', licence: null, licenceUrl: null, reason: 'Upstream source only; no body redistribution.' },
    });
    const { container } = render(<Provenance entry={entry} />);
    const view = within(container);

    expect(view.getByRole('link', { name: 'acme/flows' }).getAttribute('href')).toBe(sourceUrl);
    expect(view.getByText('GitHub repository')).toBeTruthy();
    expect(view.getByRole('link', { name: 'Dana Maintainer' }).getAttribute('href')).toBe('https://github.com/dana-maintainer');
    expect(view.getByText('2026-08-30')).toBeTruthy();
    expect(view.queryByText('Unknown')).toBeNull();
    expect(view.getByText('Upstream source only; no body redistribution.')).toBeTruthy();
  });

  it('wraps long source, licence, and rights values without changing them', () => {
    const repo = `owner/${'long-repository-name-'.repeat(8)}`;
    const sourceUrl = `https://github.com/${repo}/blob/${'a'.repeat(40)}/${'source-segment/'.repeat(8)}workflow.json`;
    const licence = `Custom licence ${'condition-'.repeat(8)}`;
    const reason = `Rights evidence: ${'permission-detail-'.repeat(8)}`;
    const entry = makeEntry({
      source: makeSource({ repo, permalink: sourceUrl }),
      rights: { status: 'redistributable', licence, licenceUrl: 'https://example.invalid/licence', reason },
    });
    const { container } = render(<Provenance entry={entry} />);
    const view = within(container);
    const sourceLink = view.getByRole('link', { name: repo });
    const licenceLink = view.getByRole('link', { name: licence });

    expect(sourceLink.getAttribute('href')).toBe(sourceUrl);
    expect(sourceLink.className).toContain('break-all');
    expect(licenceLink.className).toContain('break-words');
    expect(view.getByText(reason).className).toContain('break-words');
  });

  it('uses safe new-tab attributes for every external provenance link', () => {
    const entry = makeEntry({
      source: makeSource({ author: { name: 'Alice', url: 'https://github.com/alice' } }),
      rights: { licenceUrl: 'https://spdx.org/licenses/MIT.html' },
    });
    const { container } = render(<Provenance entry={entry} />);

    expect(within(container).getAllByRole('link')).toHaveLength(3);
    within(container).getAllByRole('link').forEach((link) => {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    });
  });

  it('does not render malformed provenance URLs as active links', () => {
    const entry = makeEntry({
      source: makeSource({
        permalink: 'javascript:alert(1)',
        author: { name: 'Alice', url: 'javascript:alert(2)' },
      }),
      rights: { licenceUrl: 'javascript:alert(3)' },
    });
    const { container } = render(<Provenance entry={entry} />);
    const view = within(container);

    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(view.queryByRole('link')).toBeNull();
    expect(view.getByText('Source link unavailable')).toBeTruthy();
    expect(view.getByText('Alice')).toBeTruthy();
    expect(view.getByText('MIT')).toBeTruthy();
  });

});
