import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { FeaturedRail } from './featured-rail';
import { IdlePrefetch } from './idle-prefetch';

function makeEntry(index: number): Entry {
  return {
    id: `entry-${index}`, slug: `entry-${index}`, title: `Workflow ${index}`, summary: 'Summary', description: 'Description', descriptionSource: 'upstream',
    source: { kind: index % 2 ? 'github' : 'n8n_official', repo: index % 2 ? 'owner/repo' : undefined, permalink: 'https://example.test', fetchedAt: '2026-01-01' },
    rights: { status: index % 2 ? 'redistributable' : 'link_only', licence: null, licenceUrl: null, reason: 'Source' },
    structure: { nodeCount: index + 2, rawNodeCount: index + 2, annotationNodeCount: 0, connectionCount: 1, nodeTypes: ['Manual'], integrations: ['slack', 'gmail'], trigger: 'Manual', isSubWorkflow: false, complexity: 'simple', hasCode: false, hasAI: false, hasWebhook: false },
    security: { grade: index % 2 ? 'LOW' : 'UNKNOWN', score: 1, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [], hardenedExtra: 0, scannerVersion: '1', profile: 'beta-default' },
    tags: ['slack'], dedup: { fingerprint: `${index}`, structuralHash: `${index}`, canonical: true, alsoFoundIn: [] },
  };
}

describe('FeaturedRail', () => {
  afterEach(() => {
    cleanup();
    document.head.querySelectorAll('link[rel="prefetch"]').forEach((el) => el.remove());
  });

  it('renders twelve real workflow links with metadata', () => {
    render(<FeaturedRail entries={Array.from({ length: 12 }, (_, index) => makeEntry(index))} />);
    expect(screen.getAllByRole('link')).toHaveLength(13);
    expect(screen.getByText('Workflow 0')).toBeTruthy();
    expect(screen.getAllByText(/risk|grade/).length).toBeGreaterThanOrEqual(12);
    expect(screen.getAllByText('slack').length).toBe(12);
  });

  it('injects prefetch link on hover (mouseEnter)', () => {
    render(
      <div>
        <IdlePrefetch />
        <FeaturedRail entries={[makeEntry(0)]} />
      </div>
    );
    const card = screen.getByRole('link', { name: /Workflow 0/ });
    expect(document.head.querySelector('link[rel="prefetch"]')).toBeNull();

    fireEvent.mouseOver(card);

    const prefetchLink = document.head.querySelector('link[rel="prefetch"][href="/w/entry-0/"]');
    expect(prefetchLink).not.toBeNull();
    expect(prefetchLink?.getAttribute('as')).toBe('document');
  });

  it('injects prefetch link on touch (touchStart)', () => {
    render(
      <div>
        <IdlePrefetch />
        <FeaturedRail entries={[makeEntry(1)]} />
      </div>
    );
    const card = screen.getByRole('link', { name: /Workflow 1/ });
    expect(document.head.querySelector('link[rel="prefetch"]')).toBeNull();

    fireEvent.touchStart(card);

    const prefetchLink = document.head.querySelector('link[rel="prefetch"][href="/w/entry-1/"]');
    expect(prefetchLink).not.toBeNull();
    expect(prefetchLink?.getAttribute('as')).toBe('document');
  });

  it('does not append duplicate link tags on repeated hover events', () => {
    render(
      <div>
        <IdlePrefetch />
        <FeaturedRail entries={[makeEntry(0)]} />
      </div>
    );
    const card = screen.getByRole('link', { name: /Workflow 0/ });

    fireEvent.mouseOver(card);
    fireEvent.mouseOver(card);
    fireEvent.touchStart(card);

    const links = document.head.querySelectorAll('link[rel="prefetch"][href="/w/entry-0/"]');
    expect(links).toHaveLength(1);
  });
});

