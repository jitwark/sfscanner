import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowseByIntent } from './browse-by-intent';

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

const catalog = {
  integration: [{ family: 'integration' as const, slug: 'slack', label: 'Slack', count: 8, href: '/integrations/slack/' }],
  tag: [{ family: 'tag' as const, slug: 'ai-agent', label: 'AI Agent', count: 6, href: '/tags/ai-agent/' }],
  trigger: [{ family: 'trigger' as const, slug: 'webhook', label: 'Webhook Trigger', count: 5, href: '/triggers/webhook/' }],
  capability: [{ family: 'capability' as const, slug: 'hasCode', label: 'Code', count: 4, href: '/library/?capability=hasCode' }],
  security: [{ family: 'security' as const, slug: 'high', label: 'HIGH Security Risk', count: 3, href: '/security/high/' }],
  rights: [{ family: 'rights' as const, slug: 'redistributable', label: 'Redistributable', count: 2, href: '/library/?rights=redistributable' }],
};

describe('BrowseByIntent', () => {
  it('renders six labeled families with visible counts and base-path-safe targets', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/community-hub');
    render(<BrowseByIntent catalog={catalog} />);

    expect(screen.getByRole('heading', { name: 'Browse by intent' })).toBeDefined();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(6);
    expect(screen.getByRole('link', { name: /Slack 8/ }).getAttribute('href')).toBe('/community-hub/integrations/slack/');
    expect(screen.getByRole('link', { name: /Code 4/ }).getAttribute('href')).toBe('/community-hub/library/?capability=hasCode');
    expect(screen.getAllByRole('link', { name: 'Explore all workflows' })).toHaveLength(6);
  });

  it('uses touch-sized active links and a horizontal rail below the desktop breakpoint', () => {
    const { container } = render(<BrowseByIntent catalog={catalog} />);

    const intentLink = screen.getByRole('link', { name: /Slack 8/ });
    const exploreLink = screen.getAllByRole('link', { name: 'Explore all workflows' })[0]!;
    expect(intentLink.className).toContain('min-h-11');
    expect(intentLink.className).toContain('active:bg-raised');
    expect(exploreLink.className).toContain('inline-flex');
    expect(exploreLink.className).toContain('min-h-11');
    expect(exploreLink.className).toContain('min-w-11');
    expect(exploreLink.className).toContain('focus-visible:outline');
    expect(exploreLink.className).toContain('active:bg-raised');
    expect(container.querySelector('[data-intent-rail]')?.className).toContain('overflow-x-auto');
    expect(container.querySelector('[data-intent-rail]')?.className).toContain('md:grid');
  });
});
