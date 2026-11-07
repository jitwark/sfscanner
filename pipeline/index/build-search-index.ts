import MiniSearch from 'minisearch';
import { gzipSync } from 'node:zlib';
import {
  SEARCH_BOOSTS,
  SEARCH_FIELDS,
  SEARCH_OPTIONS,
  SEARCH_STORE_FIELDS,
  isIndexable,
  qualityScore,
  rankedSearchableEntries,
  toSearchDisplayItem,
  type Entry,
  type SearchDisplayItem,
} from '@hub/contracts';
import { buildSearchText } from './search-text';
import { buildSemanticIndex, type SemanticIndexResult } from './semantic-index';

export type SearchDocument = SearchDisplayItem & {
  content: string;
};

export type { SearchDisplayItem } from '@hub/contracts';

/**
 * How many entries get their full text indexed.
 *
 * Measured on the packaged corpus: indexing `content` for all 12,923 entries
 * costs 11.65 MB gzip, against 3.95 MB with no content at all — the inverted
 * index is 81% of the weight and `content` is most of it. Neither extreme is
 * shippable. The top tier keeps full-text search where it earns its cost, and
 * the extended tier keeps titles, tags and integrations, which is what most
 * queries actually match on.
 */
export const PRIMARY_TIER_SIZE = 2_000;

export type BuildSearchIndexResult = {
  /** The eager tier: full text, fetched before the first search. */
  serializedIndex: string;
  /** The rest of the catalogue, no `content`, fetched after first paint. */
  serializedExtendedIndex: string;
  semanticIndex: SemanticIndexResult;
  /** Every indexable entry, primary tier first — the ordinal order. */
  displayItems: SearchDisplayItem[];
  stats: {
    uncompressedBytes: number;
    compressedBytes: number;
    extendedUncompressedBytes: number;
    primaryCount: number;
    extendedCount: number;
  };
};

export const DEFAULT_SEARCH_BOOSTS = { ...SEARCH_BOOSTS };
export const DEFAULT_SEARCH_OPTIONS = SEARCH_OPTIONS;

function displayItem(entry: Entry): SearchDisplayItem {
  return toSearchDisplayItem(entry, {
    // Truthful, not hardcoded: with search widened past the rights gate, the
    // client reads this to decide whether a result has a prerendered page or
    // must route through the client shell.
    isIndexable: isIndexable(entry),
    isPrerendered: entry.isPrerendered ?? false,
  });
}

function serializeIndex(items: SearchDisplayItem[], contents: string[]): string {
  const miniSearch = new MiniSearch<SearchDocument>({
    fields: [...SEARCH_FIELDS],
    storeFields: [...SEARCH_STORE_FIELDS],
    searchOptions: DEFAULT_SEARCH_OPTIONS,
  });
  miniSearch.addAll(items.map((item, index) => ({ ...item, content: contents[index] ?? '' })));
  return JSON.stringify(miniSearch);
}

export function buildSearchIndex(
  entries: Entry[],
  options: { primaryTierSize?: number } = {},
): BuildSearchIndexResult {
  const visible = rankedSearchableEntries(entries);
  const displayItems = visible.map(displayItem);
  const primaryCount = Math.min(options.primaryTierSize ?? PRIMARY_TIER_SIZE, visible.length);

  const serializedIndex = serializeIndex(
    displayItems.slice(0, primaryCount),
    visible.slice(0, primaryCount).map((entry) => buildSearchText(entry).content),
  );
  // The extended tier carries no `content`: that field is roughly 240 of the
  // ~300 indexed terms per document, and dropping it is what makes the tail
  // affordable at all.
  const extendedItems = displayItems.slice(primaryCount);
  const serializedExtendedIndex = serializeIndex(extendedItems, extendedItems.map(() => ''));

  const indexBuf = Buffer.from(serializedIndex, 'utf8');
  return {
    serializedIndex,
    serializedExtendedIndex,
    // Vectors for the primary tier only. Across all 12,923 entries they came
    // to 10.44 MB gzip — deferred or not, that is not a download to ask for on
    // a first query. Semantic reranking matters most where people actually
    // look, which is the same top tier that gets its full text indexed.
    semanticIndex: buildSemanticIndex(visible.slice(0, primaryCount)),
    displayItems,
    stats: {
      uncompressedBytes: indexBuf.byteLength,
      compressedBytes: gzipSync(indexBuf).byteLength,
      extendedUncompressedBytes: Buffer.byteLength(serializedExtendedIndex, 'utf8'),
      primaryCount,
      extendedCount: extendedItems.length,
    },
  };
}
