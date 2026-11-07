import { isIndexable,
  rankedSearchableEntries,
  toSearchDisplayItem,
  type Entry,
  type FacetData,
  type SearchDisplayItem,
} from '@hub/contracts';
import { buildFacets } from '@hub/contracts/facets-builder';

export type LibraryProjection = {
  total: number;
  facets: FacetData;
  items: SearchDisplayItem[];
};

/**
 * The library is the search surface, so it counts what search can find — which
 * since the rights gate moved off `isSearchable` is the whole quality
 * catalogue, not the redistributable slice of it.
 */
export function libraryTotal(entries: readonly Entry[]): number {
  return rankedSearchableEntries(entries).length;
}

export function buildLibraryProjection(
  entries: Entry[],
  prerendered = new Set<string>(),
): LibraryProjection {
  // One ordering for all three outputs. `buildFacets` derives the same list
  // internally, and its bitsets are indexed by position in it; a total or a
  // first page computed from a different ordering would disagree with the
  // counts rendered beside them.
  const ordered = rankedSearchableEntries(entries);
  return {
    total: ordered.length,
    facets: buildFacets(entries),
    items: ordered.map((entry) => toSearchDisplayItem(entry, {
      // Truthful: with search widened past the rights gate, this is what the
      // client reads to decide whether a result has a crawlable page.
      isIndexable: isIndexable(entry),
      isPrerendered: prerendered.has(entry.slug),
    })),
  };
}
