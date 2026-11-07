import type { HubIndex, HubInfo, HubKind } from '../catalogue/hub-types';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { libraryTagHref, publishedHubsForKind } from '../catalogue/hub-route';
import type { FacetCounts } from '../search/facet-bitset';

export type IntentFamily = 'integration' | 'tag' | 'trigger' | 'capability' | 'security' | 'rights';
export type IntentItem = { family: IntentFamily; slug: string; label: string; count: number; href: string };

const LIMIT = 6;
const capabilityLabels: Record<string, string> = { code: 'Code', ai: 'AI', webhook: 'Webhook' };
const rightsLabels: Record<string, string> = { redistributable: 'Redistributable', link_only: 'Link-only' };
const hubFamilies: Array<[Exclude<IntentFamily, 'capability' | 'rights'>, HubKind, string]> = [
  ['integration', 'integration', 'integrations'], ['tag', 'tag', 'tags'], ['trigger', 'trigger', 'triggers'], ['security', 'security', 'security'],
];

function sortAndLimit(items: IntentItem[]): IntentItem[] {
  return items.filter((item) => item.count > 0).sort((a, b) => b.count - a.count || compareCanonicalStrings(a.slug, b.slug)).slice(0, LIMIT);
}

function hubItems(index: HubIndex, family: IntentFamily, kind: HubKind, prefix: string): IntentItem[] {
  return publishedHubsForKind(index, kind).map((hub: HubInfo) => ({
    family, slug: hub.slug, label: hub.title, count: hub.totalEntries,
    href: family === 'tag' ? libraryTagHref(hub.slug) : `/${prefix}/${hub.slug}/`,
  }));
}

function countItems(family: 'capability' | 'rights', values: Record<string, number>, labels: Record<string, string>): IntentItem[] {
  return Object.entries(labels).map(([slug, label]) => ({
    family, slug, label, count: values[slug] ?? 0, href: `/library/?${family}=${slug}`,
  }));
}

export function buildIntentCatalog(index: HubIndex, counts: FacetCounts): Record<IntentFamily, IntentItem[]> {
  const catalog = {} as Record<IntentFamily, IntentItem[]>;
  for (const [family, kind, prefix] of hubFamilies) catalog[family] = sortAndLimit(hubItems(index, family, kind, prefix));
  catalog.capability = sortAndLimit(countItems('capability', counts.capabilities, capabilityLabels));
  catalog.rights = sortAndLimit(countItems('rights', counts.rights, rightsLabels));
  return catalog;
}
