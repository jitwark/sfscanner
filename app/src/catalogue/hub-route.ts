import { normalizeDiscoverySlug, type Entry } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { allEntries } from './prerender-list';
import type { HubIndex, HubInfo, HubKind } from './hub-types';

export const HUB_PAGE_SIZE = 24;
// Collection pages are intentionally bounded for static hosting. The complete
// catalogue remains available through the library search and client detail
// shell; only the first, quality-ranked slice is emitted per hub.
export const MAX_STATIC_HUB_PAGES = 1;
export const MAX_STATIC_HUBS_PER_KIND = 24;
export function libraryTagHref(slug: string): string {
  return `/library/?tag=${encodeURIComponent(normalizeDiscoverySlug(slug))}`;
}

export function hubsForKind(index: HubIndex, kind: HubKind): Record<string, HubInfo> {
  if (kind === 'integration') return index.integrations;
  if (kind === 'tag') return index.tags;
  if (kind === 'trigger') return index.triggers;
  return index.security;
}

export function publishedHubsForKind(index: HubIndex, kind: HubKind): HubInfo[] {
  return Object.values(hubsForKind(index, kind))
    .sort((a, b) => b.totalEntries - a.totalEntries || compareCanonicalStrings(a.slug, b.slug))
    .slice(0, MAX_STATIC_HUBS_PER_KIND);
}

export function entriesForHub(hub: HubInfo, page = 1): Entry[] {
  const byId = new Map(allEntries().map((entry) => [entry.id, entry]));
  const start = Math.max(0, page - 1) * HUB_PAGE_SIZE;
  return hub.entryIds
    .slice(start, start + HUB_PAGE_SIZE)
    .map((id) => byId.get(id))
    .filter((entry): entry is Entry => Boolean(entry));
}

export function allEntriesForHub(hub: HubInfo): Entry[] {
  const byId = new Map(allEntries().map((entry) => [entry.id, entry]));
  return hub.entryIds
    .map((id) => byId.get(id))
    .filter((entry): entry is Entry => Boolean(entry));
}

export function pageNumbers(hub: HubInfo): number[] {
  return Array.from({ length: Math.min(hub.totalPages, MAX_STATIC_HUB_PAGES) }, (_, index) => index + 1);
}
