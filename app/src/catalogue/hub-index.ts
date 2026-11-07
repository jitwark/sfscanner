import { isIndexable, type Entry } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { allEntries } from './prerender-list';
import {
  createAccumulator,
  finalizeHubInfo,
  recordEntry,
  type HubAccumulator,
} from './hub-aggregation';
import { slugify } from './hub-copy';
import type { HubIndex, HubInfo } from './hub-types';

export type { HubIndex, HubInfo } from './hub-types';

function addEntry(
  map: Map<string, HubAccumulator>,
  slug: string,
  entry: Entry,
  kind: Parameters<typeof recordEntry>[3],
): void {
  if (!slug) return;
  if (!map.has(slug)) map.set(slug, createAccumulator());
  recordEntry(map.get(slug)!, entry, slug, kind);
}

function materialize(
  map: Map<string, HubAccumulator>,
  kind: Parameters<typeof recordEntry>[3],
  minimumEntries = 3,
): Record<string, HubInfo> {
  const result: Record<string, HubInfo> = {};
  for (const [slug, accumulator] of map.entries()) {
    if (accumulator.entryMap.size >= minimumEntries) {
      result[slug] = finalizeHubInfo(kind, slug, accumulator);
    }
  }
  return result;
}

export function buildHubIndex(entries: Entry[]): HubIndex {
  const integrationMap = new Map<string, HubAccumulator>();
  const tagMap = new Map<string, HubAccumulator>();
  const triggerMap = new Map<string, HubAccumulator>();
  const securityMap = new Map<string, HubAccumulator>();

  for (const entry of entries.filter(isIndexable)) {
    for (const integration of entry.structure?.integrations || []) {
      addEntry(integrationMap, slugify(integration), entry, 'integration');
    }
    for (const tag of entry.tags || []) {
      addEntry(tagMap, slugify(tag), entry, 'tag');
    }
    if (entry.structure?.trigger) {
      const slug = slugify(entry.structure.trigger);
      if (slug !== 'unknown') addEntry(triggerMap, slug, entry, 'trigger');
    }
    if (entry.security?.grade) {
      const slug = entry.security.grade.toLowerCase();
      if (['low', 'medium', 'high', 'critical'].includes(slug)) {
        addEntry(securityMap, slug, entry, 'security');
      }
    }
  }

  const tags = [...tagMap.entries()]
    .filter(([, accumulator]) => accumulator.entryMap.size >= 3)
    .sort((a, b) => b[1].entryMap.size - a[1].entryMap.size || compareCanonicalStrings(a[0], b[0]))
    .slice(0, 150);

  const tagIndex: Record<string, HubInfo> = {};
  for (const [slug, accumulator] of tags) {
    tagIndex[slug] = finalizeHubInfo('tag', slug, accumulator);
  }

  return {
    integrations: materialize(integrationMap, 'integration'),
    tags: tagIndex,
    triggers: materialize(triggerMap, 'trigger'),
    security: materialize(securityMap, 'security'),
  };
}

let cachedHubIndex: HubIndex | null = null;

export function getHubIndex(): HubIndex {
  if (!cachedHubIndex) cachedHubIndex = buildHubIndex(allEntries());
  return cachedHubIndex;
}

export function clearHubIndexCache(): void {
  cachedHubIndex = null;
}
