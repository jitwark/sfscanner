import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { ResultCard } from './result-card';
import type { SearchDisplayItem } from '@hub/contracts';

describe('ResultCard', () => {
  afterEach(() => {
    cleanup();
  });

  const sampleItem: SearchDisplayItem = {
    id: 'abc12345',
    slug: 'slack-email-notify-workflow',
    title: 'Slack Email Notification Workflow',
    summary: 'Sends a Slack message whenever a new email arrives in Gmail.',
    tags: ['email', 'slack', 'gmail', 'postgres', 'supabase', 'webhook'],
    integrations: ['gmail', 'slack', 'postgres', 'supabase', 'openai'],
    triggers: ['webhook'],
    capabilities: ['webhook'],
    grade: 'LOW',
    nodeCount: 14,
    rights: 'redistributable',
    complexity: 'medium',
    isIndexable: true,
    isPrerendered: true,
  };

  it('renders title, summary, node count, trigger, and grade pill', () => {
    render(<ResultCard item={sampleItem} />);

    expect(screen.getByText('Slack Email Notification Workflow')).toBeDefined();
    expect(screen.getByText(/Sends a Slack message/)).toBeDefined();
    expect(screen.getByText(/14 nodes/)).toBeDefined();
    expect(screen.getAllByText('Webhook').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Low risk/)).toBeDefined();
    expect(screen.getByText(/Redistributable/)).toBeDefined();
  });

  it('renders up to 4 integration chips and +n remainder', () => {
    render(<ResultCard item={sampleItem} />);

    expect(screen.getAllByText('Gmail').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Slack').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('PostgreSQL')).toBeDefined();
    expect(screen.getAllByText('Supabase').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('+1')).toBeDefined();
  });

  it('routes to /w/<slug>/ for prerendered entry with valid description and structure', () => {
    render(<ResultCard item={sampleItem} />);
    const link = screen.getByRole('link', { name: 'Slack Email Notification Workflow' });
    expect(link.getAttribute('href')).toMatch(/^\/w\/slack-email-notify-workflow/);
  });

  /**
   * This asserted four specific utility classes, three of which named the
   * mechanism rather than the guarantee: a `bg-raised` hover on the link, a
   * `ring` focus style, a `bg-raised` active style. The row now carries the
   * hover, focus uses an outline, and the link is stretched over the whole row
   * — so the target grew from 44px to the full 92px row while every affordance
   * survived. What is worth pinning is the guarantee, not the class list.
   */
  it('makes the whole row a detail target with hover, focus and active affordances', () => {
    const { container } = render(<ResultCard item={sampleItem} />);

    const link = screen.getByRole('link', { name: 'Slack Email Notification Workflow' });
    expect(link.className).toContain('min-h-11');
    expect(link.className).toMatch(/hover:/);
    expect(link.className).toMatch(/focus-visible:/);
    expect(link.className).toMatch(/active:/);
    // Stretched over the row, so the click target is the row rather than the
    // title alone. The overlay is presentational; the accessible name is still
    // the title.
    const overlay = link.querySelector('[aria-hidden="true"]');
    expect(overlay?.className).toContain('absolute');
    expect(overlay?.className).toContain('inset-0');
    expect(container.querySelector('article')?.className).toMatch(/hover:bg-raised/);
  });

  it('routes to the slug page whatever the entry is, because every entry has one', () => {
    // These three used to expect `/w/view/?id=`. They encoded a real constraint:
    // only 250 slugs had a page, and an entry below the publication floor never
    // would. `scripts/generate-lean-pages.tsx` writes a page for all 13,221 —
    // the sub-floor ones noindex, but readable — so the branch is gone.
    const belowFloor = [
      { ...sampleItem, descriptionSource: 'fallback', isPrerendered: false },
      { ...sampleItem, nodeCount: 2, isPrerendered: false },
      { ...sampleItem, tags: ['webhook'], integrations: [], isPrerendered: false },
    ];

    for (const item of belowFloor) {
      const { container } = render(<ResultCard item={item} />);
      const link = within(container).getByRole('link', { name: 'Slack Email Notification Workflow' });
      // Prefix, not exact: `next/link` only applies `trailingSlash` at build
      // time, so jsdom drops the slash the real export carries.
      expect(link.getAttribute('href')).toMatch(/^\/w\/slack-email-notify-workflow\/?$/);
      cleanup();
    }
  });

  it('applies highlighted styles when isHighlighted is true', () => {
    const { container } = render(<ResultCard item={sampleItem} isHighlighted={true} />);
    const article = container.querySelector('article');
    expect(article?.className).toContain('ring-2');
    expect(article?.className).toContain('ring-accent-border');
  });

  it('uses explicit tags without inferring a trigger alias', () => {
    const legacy = {
      ...sampleItem, integrations: [], triggers: [], tags: ['legacy-vendor'], trigger: 'Webhook',
    } as SearchDisplayItem & { trigger: string };
    render(<ResultCard item={legacy} />);

    expect(screen.getByText('Legacy Vendor')).toBeDefined();
    expect(screen.getByText('Uncategorized')).toBeDefined();
  });

  it('renders explicit tags and source alongside the provided workflow fields', () => {
    render(<ResultCard item={{ ...sampleItem, tags: ['notification'], sourceRepo: 'owner/repository' }} />);

    expect(screen.getByText('Notification')).toBeDefined();
    expect(screen.getByText('owner/repository')).toBeDefined();
  });

  it('does not guess a source when provenance is unavailable', () => {
    const variants = [
      { rights: 'redistributable' as const, guessedSource: 'GitHub' },
      { rights: 'link_only' as const, guessedSource: 'n8n.io' },
    ];

    for (const { rights, guessedSource } of variants) {
      render(<ResultCard item={{ ...sampleItem, rights, sourceRepo: undefined }} />);

      expect(screen.getByText('Source unavailable')).toBeDefined();
      expect(screen.queryByText(guessedSource)).toBeNull();
      expect(screen.getByText(rights === 'link_only' ? 'Link-only' : 'Redistributable')).toBeDefined();
      cleanup();
    }
  });

  it('renders the complete explicit tag set without a hidden remainder', () => {
    render(<ResultCard item={{ ...sampleItem, tags: ['one', 'two', 'three', 'four'], integrations: [], triggers: [] }} />);

    expect(screen.getByText('One')).toBeDefined();
    expect(screen.getByText('Two')).toBeDefined();
    expect(screen.getByText('Three')).toBeDefined();
    expect(screen.getByText('Four')).toBeDefined();
  });
});
