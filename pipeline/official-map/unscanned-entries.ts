import { readCatalogueShards } from './official-catalogue.js';

/**
 * The population the published disclaimer is about: entries whose
 * `readiness.analysis` is `unscanned`, split by whether the pipeline could ever
 * have scanned them.
 */
export type UnscannedCatalogue = {
  unscannedTotal: number;
  officialUnscanned: number;
  communityUnscanned: number;
  /** `source.templateId` of every official unscanned entry that carries one. */
  officialIds: Set<number>;
};

export function readUnscannedCatalogue(catalogueDirs: readonly string[]): UnscannedCatalogue {
  const officialIds = new Set<number>();
  let unscannedTotal = 0;
  let officialUnscanned = 0;
  let communityUnscanned = 0;
  for (const dir of catalogueDirs) {
    for (const shard of readCatalogueShards(dir)) {
      for (const item of shard) {
        if (typeof item !== 'object' || item === null) continue;
        const readiness = 'readiness' in item ? item.readiness : undefined;
        if (typeof readiness !== 'object' || readiness === null || !('analysis' in readiness)) continue;
        if (readiness.analysis !== 'unscanned') continue;
        unscannedTotal += 1;
        const source = 'source' in item ? item.source : undefined;
        const kind = typeof source === 'object' && source !== null && 'kind' in source ? source.kind : undefined;
        if (kind !== 'n8n_official') {
          communityUnscanned += 1;
          continue;
        }
        officialUnscanned += 1;
        const templateId =
          typeof source === 'object' && source !== null && 'templateId' in source ? source.templateId : undefined;
        // The join key is the template id, so an entry without one cannot be
        // recovered by a body: it stays uncounted here and is reported by the
        // reconciliation rather than being silently folded in.
        if (typeof templateId === 'number' && Number.isSafeInteger(templateId)) officialIds.add(templateId);
      }
    }
  }
  return { unscannedTotal, officialUnscanned, communityUnscanned, officialIds };
}
