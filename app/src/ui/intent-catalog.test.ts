import { describe, expect, it } from 'vitest';
import type { HubIndex, HubInfo } from '../catalogue/hub-types';
import type { FacetCounts } from '../search/facet-bitset';
import { buildIntentCatalog } from './intent-catalog';

const hub = (kind: HubInfo['kind'], slug: string, title: string, totalEntries: number): HubInfo => ({
  kind, slug, title, totalEntries, entryIds: [], totalPages: 1, companionIntegrations: [], companionTags: [],
  dominantTrigger: 'manual', gradeSpread: { low: 0, medium: 0, high: 0, critical: 0, unknown: 0 }, introCopy: '',
});

const index: HubIndex = {
  integrations: { slack: hub('integration', 'slack', 'Slack', 8), zero: hub('integration', 'zero', 'Zero', 0) },
  tags: { 'ai-agent': hub('tag', 'ai-agent', 'AI Agent', 6) },
  triggers: { webhook: hub('trigger', 'webhook', 'Webhook Trigger', 5) },
  security: { high: hub('security', 'high', 'HIGH Security Risk', 4) },
};

const counts: FacetCounts = {
  rights: { redistributable: 7, link_only: 3, unknown: 0 }, grade: {}, trigger: {}, complexity: {}, tags: {},
  capabilities: { code: 9, ai: 2, webhook: 0, invented: 12 },
  integrations: {},
};

describe('buildIntentCatalog', () => {
  it('projects all six families from published hubs and approved facet counters', () => {
    const catalog = buildIntentCatalog(index, counts);

    expect(catalog.integration).toEqual([{ family: 'integration', slug: 'slack', label: 'Slack', count: 8, href: '/integrations/slack/' }]);
    expect(catalog.tag).toEqual([{ family: 'tag', slug: 'ai-agent', label: 'AI Agent', count: 6, href: '/library/?tag=ai-agent' }]);
    expect(catalog.trigger).toEqual([{ family: 'trigger', slug: 'webhook', label: 'Webhook Trigger', count: 5, href: '/triggers/webhook/' }]);
    expect(catalog.security).toEqual([{ family: 'security', slug: 'high', label: 'HIGH Security Risk', count: 4, href: '/security/high/' }]);
    expect(catalog.capability).toEqual([
      { family: 'capability', slug: 'code', label: 'Code', count: 9, href: '/library/?capability=code' },
      { family: 'capability', slug: 'ai', label: 'AI', count: 2, href: '/library/?capability=ai' },
    ]);
    expect(catalog.rights).toEqual([
      { family: 'rights', slug: 'redistributable', label: 'Redistributable', count: 7, href: '/library/?rights=redistributable' },
      { family: 'rights', slug: 'link_only', label: 'Link-only', count: 3, href: '/library/?rights=link_only' },
    ]);
  });

  it('orders by count then slug and limits every family to six non-zero known items', () => {
    const many = Object.fromEntries(['z', 'a', 'b', 'c', 'd', 'e', 'f'].map((slug) => [slug, hub('integration', slug, slug.toUpperCase(), 3)]));
    const catalog = buildIntentCatalog({ ...index, integrations: many }, counts);

    expect(catalog.integration.map((item) => item.slug)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(catalog.capability.map((item) => item.slug)).toEqual(['code', 'ai']);
    expect(catalog.rights.every((item) => item.count > 0)).toBe(true);
    expect(catalog.rights.find((item) => item.slug === 'unknown')).toBeUndefined();
  });
});
