import fs from 'node:fs';
import path from 'node:path';
import {
  type Entry,
} from '@hub/contracts';
import { parseFacetData } from '@hub/contracts/facet-artifact';
import { parseSearchIndexArtifact } from '@hub/contracts/search-index-artifact';
import { parseSemanticIndexArtifact } from '@hub/contracts/semantic-index-artifact';
import type { BuildSearchIndexResult } from '../index/build-search-index.js';
import type { FacetData } from '../index/facets.js';
import { deriveCorpusAnalytics } from '../derive/corpus-analytics.js';
import { totalSearchableDocuments, type SearchIndexTier } from '../derive/searchable-count.js';
import { readV2AnalyticsEvidence } from '../derive/v2-analytics-evidence.js';

export type WrittenArtifactInfo = {
  relativePath: string;
  absolutePath: string;
  entryCount: number;
  entryRange?: [number, number];
  offsets?: number[];
  lengths?: number[];
  encoding?: 'identity';
};

/**
 * The whole-corpus JSON artifacts: search index, facets, semantic index, stats
 * and analytics. They are the small ones — the shards and packs are written by
 * `write-artifacts.ts` — and they share one rule worth keeping in a single file:
 * **an artifact's `entryCount` is measured from the artifact, never copied from
 * the corpus total.** `search-index.json` was stamped 13,221 over an index
 * holding 1,962 because that rule was applied in one place and not the others.
 */
export function writeIndexArtifacts(
  entries: Entry[],
  searchIndexResult: BuildSearchIndexResult,
  facetsData: FacetData,
  outputDir: string,
  counts: { totalEntries: number; redistributableCount: number; shardCount: number; packCount: number },
  options: { legacyV1?: boolean } = {},
): WrittenArtifactInfo[] {
  const written: WrittenArtifactInfo[] = [];

  const write = (relativePath: string, contents: string, entryCount: number): void => {
    const absolutePath = path.join(outputDir, relativePath);
    fs.writeFileSync(absolutePath, contents, 'utf8');
    written.push({ relativePath, absolutePath, entryCount });
  };

  // Parsed once each and reused below: these two are ~22 MB together, and the
  // packager already holds the whole corpus in memory.
  const primaryTier: SearchIndexTier = parseSearchIndexArtifact(JSON.parse(searchIndexResult.serializedIndex));
  const extendedTier: SearchIndexTier = parseSearchIndexArtifact(JSON.parse(searchIndexResult.serializedExtendedIndex));
  parseFacetData(facetsData);

  write('search-index.json', searchIndexResult.serializedIndex, primaryTier.documentCount ?? 0);

  // The tail of the catalogue, without `content`. Fetched after first paint, so
  // it is never on the critical path — see the first-interaction budget in
  // scripts/check-bundle-budget.mjs.
  write('search-index-extended.json', searchIndexResult.serializedExtendedIndex, extendedTier.documentCount ?? 0);

  write('facets.json', JSON.stringify(facetsData, null, 2), counts.totalEntries);

  const semantic = searchIndexResult.semanticIndex;
  const parsedSemantic = parseSemanticIndexArtifact(JSON.parse(semantic.serializedIndex));
  write(
    'semantic-index.json',
    semantic.serializedIndex,
    parsedSemantic.documents.length,
  );

  // Two rights scopes live in this object on purpose, and neither is the other's
  // bug. `linkOnlyCount` (and `redistributableCount`) are corpus-wide, measured
  // over every entry; `facetCounts.rights`, copied from `facetsData`, is the
  // search split, measured over `rankedSearchableEntries` only
  // (`contracts/facets-builder.ts`'s `buildFacets`). Measured today in
  // `data/stats.json`: 11,464 corpus-wide link-only vs. 11,245 in the facet —
  // the gap is the entries the `isSearchable` floor excludes. Reconcile them
  // only if the scopes themselves change, and change
  // `rights-count-population.test.ts` with them.
  const stats = {
    totalEntries: counts.totalEntries,
    redistributableCount: counts.redistributableCount,
    linkOnlyCount: counts.totalEntries - counts.redistributableCount,
    officialCount: entries.filter((entry) => entry.source?.kind === 'n8n_official').length,
    shardCount: counts.shardCount,
    packCount: counts.packCount,
    facetCounts: facetsData.counts,
  };
  write('stats.json', JSON.stringify(stats, null, 2), counts.totalEntries);

  // Every tier, via the shared sum — see `searchable-count.ts`. Adding the two
  // counts here by hand is what the re-derive script did, and it silently
  // dropped the extended tier.
  const evidence = readV2AnalyticsEvidence(outputDir);
  if (evidence === null) {
    // A v1 tree has no v2 results. It may be an intermediate ingestion tree, but it must not
    // publish a schema-4 artifact that claims native v2 provenance it does not have.
    if (options.legacyV1 === true) return written;
    throw new Error(`No v2 analytics evidence in ${outputDir}; refusing to write a native v2 analytics artifact.`);
  }
  const analytics = deriveCorpusAnalytics(entries, {
    searchableDocumentCount: totalSearchableDocuments([primaryTier, extendedTier]),
    ...evidence,
  });
  write('analytics.json', JSON.stringify(analytics, null, 2), analytics.total);

  return written;
}
