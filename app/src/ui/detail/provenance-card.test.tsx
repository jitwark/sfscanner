import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Entry } from '@hub/contracts';
import { ProvenanceCard } from './provenance-card';

afterEach(() => cleanup());

const MOCK_ENTRY: Entry = {
  id: 'test-1',
  slug: 'test-workflow',
  title: 'Test Workflow Title',
  summary: 'A test workflow summary.',
  description: 'Test workflow description.',
  source: {
    kind: 'community_repo',
    repo: 'user/sample-repo',
    permalink: 'https://github.com/user/sample-repo',
    author: { name: 'Alice Developer', url: 'https://github.com/alice' },
    fetchedAt: '2026-08-20T12:00:00Z',
  },
  rights: {
    status: 'redistributable',
    licence: 'MIT',
    licenceUrl: 'https://opensource.org/licenses/MIT',
    reason: 'MIT-licensed public repository',
  },
  security: {
    grade: 'A',
    score: 95,
    findings: [],
    scannerVersion: '1.0.0',
    profile: 'strict',
    counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  },
  structure: {
    nodeCount: 12,
    rawNodeCount: 12,
    annotationNodeCount: 0,
    connectionCount: 14,
    trigger: 'Webhook',
    complexity: 'low',
    integrations: ['github', 'slack'],
  },
} as unknown as Entry;

describe('ProvenanceCard', () => {
  it('renders author, source link, and licence badge', () => {
    render(<ProvenanceCard entry={MOCK_ENTRY} />);
    expect(screen.getByText('Alice Developer')).toBeTruthy();
    expect(screen.getByText('user/sample-repo')).toBeTruthy();
    expect(screen.getByText('MIT')).toBeTruthy();
  });

  it('says the author contact was withheld when the published name is only the marker', () => {
    const redacted = { ...MOCK_ENTRY, source: { ...MOCK_ENTRY.source, author: { name: '[email]' } } } as Entry;
    render(<ProvenanceCard entry={redacted} />);

    expect(screen.getByText('Author contact withheld')).toBeTruthy();
    expect(screen.queryByText('[email]')).toBeNull();
  });

  it('keeps the non-email part of a mixed author name', () => {
    const mixed = { ...MOCK_ENTRY, source: { ...MOCK_ENTRY.source, author: { name: 'Alice <[email]>' } } } as Entry;
    render(<ProvenanceCard entry={mixed} />);

    expect(screen.getByText('Alice <[email]>')).toBeTruthy();
  });

  it('renders metric badges when showMetrics is true', () => {
    render(<ProvenanceCard entry={MOCK_ENTRY} showMetrics={true} />);
    expect(screen.getByText('NODES:')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('Webhook')).toBeTruthy();
  });

  it('renders View on n8n.io link with target=_blank when link_only and n8n_official', () => {
    const n8nEntry = {
      ...MOCK_ENTRY,
      source: {
        ...MOCK_ENTRY.source,
        kind: 'n8n_official',
        permalink: 'https://n8n.io/workflows/1234',
      },
      rights: {
        status: 'link_only',
        licence: 'Proprietary',
        reason: 'Hosted on n8n.io',
      },
    } as unknown as Entry;

    render(<ProvenanceCard entry={n8nEntry} />);
    const link = screen.getByRole('link', { name: 'View on n8n.io' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('href')).toBe('https://n8n.io/workflows/1234');
  });
});
