/**
 * The search index is tiered, so "how many workflows are searchable" is a sum
 * and never a single field.
 *
 * This module exists because that sum was open-coded twice and got it wrong
 * both times. `layout.tsx` read `search-index.json`'s `documentCount` and put
 * the primary tier's 2,000 on all 584 pages while the analytics page said
 * 12,923; `derive-analytics.ts` read the same single file and would have
 * rewritten the artifact with 2,000 the next time anyone re-derived it. Neither
 * was a typo — "read documentCount" is the obvious thing to write, and it is
 * correct right up until a second tier exists.
 *
 * So the derivation lives in one place and every caller goes through it. If a
 * third tier is ever added, `SEARCH_INDEX_TIER_FILES` is the line to change.
 */

/**
 * Every index tier that makes an entry findable, in load order.
 *
 * The extended tier counts: it is fetched after the primary index answers, but
 * an entry in it is findable the moment that file lands. Excluding it would
 * understate the catalogue by 10,923 on the pages that exist to say what is in
 * it.
 */
export const SEARCH_INDEX_TIER_FILES = ['search-index.json', 'search-index-extended.json'] as const;

/** The header shape this module reads. Both index tiers carry it. */
export type SearchIndexTier = { documentCount?: number };

/**
 * The searchable total across index tiers.
 *
 * Takes **parsed** tiers rather than serialized JSON. It took strings at first,
 * which read well but made the packager parse ~22 MB of index a second time
 * purely to re-read two integers it already had in scope — and this build has
 * run out of memory twice before.
 *
 * Callers still pass the whole tier list rather than a number they added up
 * themselves, which is the part that matters: hand-summing at the call site is
 * the mistake this module exists to prevent, and passing an array of tiers
 * keeps that impossible while letting each caller parse once.
 */
export function totalSearchableDocuments(tiers: readonly SearchIndexTier[]): number {
  return tiers.reduce<number>((sum, tier) => sum + (tier.documentCount ?? 0), 0);
}
