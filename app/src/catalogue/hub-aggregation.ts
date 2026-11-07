import type { Entry } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { formatHubTitle, generateIntroCopy, slugify } from './hub-copy';
import type { CompanionStat, GradeSpread, HubInfo, HubKind } from './hub-types';
import { qualityScore } from './prerender-list';

export type HubAccumulator = {
  entryMap: Map<string, Entry>;
  companionIntegrations: Map<string, number>;
  companionTags: Map<string, number>;
  triggerCounts: Map<string, number>;
  gradeSpread: GradeSpread;
};

export function createAccumulator(): HubAccumulator {
  return { entryMap: new Map(), companionIntegrations: new Map(), companionTags: new Map(), triggerCounts: new Map(), gradeSpread: { low: 0, medium: 0, high: 0, critical: 0, unknown: 0 } };
}

export function recordEntry(acc: HubAccumulator, entry: Entry, currentHubKey: string, currentKind: HubKind): void {
  acc.entryMap.set(entry.id, entry);
  const grade = (entry.security?.grade || 'UNKNOWN').toLowerCase() as keyof GradeSpread;
  if (grade in acc.gradeSpread) acc.gradeSpread[grade]++;
  else acc.gradeSpread.unknown++;
  if (entry.structure?.trigger) {
    const trigger = slugify(entry.structure.trigger);
    acc.triggerCounts.set(trigger, (acc.triggerCounts.get(trigger) || 0) + 1);
  }
  for (const integration of entry.structure?.integrations || []) {
    const slug = slugify(integration);
    if (slug && !(currentKind === 'integration' && slug === currentHubKey)) acc.companionIntegrations.set(slug, (acc.companionIntegrations.get(slug) || 0) + 1);
  }
  for (const tag of entry.tags || []) {
    const slug = slugify(tag);
    if (slug && !(currentKind === 'tag' && slug === currentHubKey)) acc.companionTags.set(slug, (acc.companionTags.get(slug) || 0) + 1);
  }
}

export function finalizeHubInfo(kind: HubKind, slug: string, acc: HubAccumulator): HubInfo {
  const entries = [...acc.entryMap.values()].sort((a, b) => {
    const difference = qualityScore(b) - qualityScore(a);
    return Math.abs(difference) > 1e-6 ? difference : compareCanonicalStrings(a.id, b.id);
  });
  const companionIntegrations = topCompanions(acc.companionIntegrations);
  const companionTags = topCompanions(acc.companionTags);
  let dominantTrigger = 'manual'; let maxCount = -1;
  for (const [trigger, count] of acc.triggerCounts) if (count > maxCount) { maxCount = count; dominantTrigger = trigger; }
  const base: Omit<HubInfo, 'introCopy'> = { kind, slug, title: formatHubTitle(slug, kind), entryIds: entries.map((entry) => entry.id), totalEntries: entries.length, totalPages: Math.ceil(entries.length / 24), companionIntegrations, companionTags, dominantTrigger, gradeSpread: { ...acc.gradeSpread } };
  return { ...base, introCopy: generateIntroCopy(base) };
}

function topCompanions(values: Map<string, number>): CompanionStat[] {
  return [...values.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || compareCanonicalStrings(a.name, b.name)).slice(0, 3);
}
