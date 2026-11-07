// No .js extension: also bundled by Next (via app/src consumers), and webpack
// cannot resolve the Node-ESM '.js' spelling against a .ts source (see the
// same note in pipeline/index/facets.ts).
import { qualityScore } from './search-config';
import { toSearchDisplayItem } from './discovery';
import type { Entry } from './index';
import { compareCanonicalStrings } from './stable-order';

export type IndexableEntry = Entry & {
  dedup: Entry['dedup'] & { canonical: true };
  descriptionSource: Exclude<Entry['descriptionSource'], 'fallback'>;
};

/**
 * Whether a crawler may index this entry's page.
 *
 * Until 2026-08-25 this also required `rights.status === 'redistributable'`,
 * which folded two unrelated questions into one: may we hand you the file, and
 * may we describe the workflow. A detail page publishes derived facts —
 * structure, integrations, a security grade, provenance — and deep-links
 * upstream for the file itself. That is what a directory does, and it
 * republishes nothing.
 *
 * The project had already accepted this argument for search; see `isSearchable`
 * below, and the same reasoning in `docs/sources.md`. Leaving it unaccepted here
 * meant a 13,221-entry catalogue offered a crawler 287 pages. Downloading is
 * still gated on rights, in `app/src/catalogue/download.ts`, which is the only
 * place that needs to be.
 *
 * Legacy `indexable` fields are output hints, never inputs.
 *
 * The "at least one integration" floor this used to carry asked about
 * `structure.integrations`, which since the 88-label canonical taxonomy holds
 * **vendor products only** — a capability word like `code`, `http-request` or
 * `schedule` is no longer an integration. That silently changed the floor's
 * meaning: a workflow built entirely from n8n's own nodes stopped qualifying,
 * and 1,015 published entries (91.5% of them core-node automations) would have
 * dropped out of search, prerendering and the sitemap with no gate failing —
 * the SEO-3 floor is 60% and would not have blinked. The floor is now stated on
 * the fact it actually measured: the analysis recognised a node type. Measured
 * on the pre-regeneration corpus, both forms selected the same 11,245 entries,
 * so this is not a widening — it is refusing to let a vocabulary change decide
 * what gets published.
 */
export function isIndexable(entry: Entry): entry is IndexableEntry {
  return entry.dedup?.canonical === true
    && entry.descriptionSource !== 'fallback'
    && (entry.structure?.nodeCount ?? 0) >= 3
    && (entry.structure?.nodeTypes?.length ?? 0) >= 1;
}

export function indexableEntries(entries: readonly Entry[]): IndexableEntry[] {
  return entries.filter(isIndexable);
}

/**
 * Indexable entries, best first — the ordinal order for the whole search stack.
 *
 * This single ordering does three jobs: it assigns ordinals, it decides which
 * entries land in the content-indexed tier, and `buildFacets` indexes its
 * bitsets by position in it. All three must come from the same sort, so it
 * lives here, beside the predicate, rather than in whichever module happened to
 * need it first. Ties break on id, so a rebuild cannot reorder equal entries.
 */
export function rankedIndexableEntries(entries: readonly Entry[]): IndexableEntry[] {
  return indexableEntries(entries)
    .map((entry) => ({
      entry,
      score: qualityScore(toSearchDisplayItem(entry, { isIndexable: true, isPrerendered: entry.isPrerendered ?? false })),
    }))
    .sort((left, right) => right.score - left.score || compareCanonicalStrings(left.entry.id, right.entry.id))
    .map((ranked) => ranked.entry);
}

/**
 * Whether an entry belongs in the **search** index.
 *
 * This predicate was split from `isIndexable` when search stopped asking about
 * redistribution rights — gating it on them had hidden 11,180 link-only entries
 * from a catalogue that had analysed every one of them. On 2026-08-25 the same
 * argument was accepted for publication, so the two now differ only in that a
 * fallback description may not be *published* while the entry is still worth
 * *finding*.
 *
 * They are kept separate anyway. They answer different questions — may a
 * crawler index this, versus is this worth a result row — and collapsing them
 * into one predicate would mean the next divergence has nowhere to be expressed.
 * `indexability.test.ts` pins the cases where they must agree.
 */
export function isSearchable(entry: Entry): boolean {
  return entry.dedup?.canonical === true
    && (entry.structure?.nodeCount ?? 0) >= 3
    && (entry.structure?.nodeTypes?.length ?? 0) >= 1;
}

/** Searchable entries, best first. See `rankedIndexableEntries` for why the sort lives here. */
export function rankedSearchableEntries(entries: readonly Entry[]): Entry[] {
  return entries
    .filter(isSearchable)
    .map((entry) => ({
      entry,
      score: qualityScore(toSearchDisplayItem(entry, { isIndexable: isIndexable(entry), isPrerendered: entry.isPrerendered ?? false })),
    }))
    .sort((left, right) => right.score - left.score || compareCanonicalStrings(left.entry.id, right.entry.id))
    .map((ranked) => ranked.entry);
}
