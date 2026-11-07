import type { FacetCounts, SearchDisplayItem } from '@hub/contracts';

/**
 * The protocol between the search client and the search worker.
 *
 * Extracted so `worker.ts` carries the engine and this carries the contract:
 * the shapes are read by both sides, and a change here is a change to something
 * that crosses a `postMessage` boundary — worth seeing on its own.
 */

export type RankedSearchDisplayItem = SearchDisplayItem & {
  qualityScore?: number;
  score?: number;
  lexicalScore?: number;
  semanticScore?: number;
};

export type SearchFilters = {
  trigger?: string | string[];
  capability?: string[];
  complexity?: string;
  grade?: string;
  rights?: string;
  integration?: string[];
  tag?: string[];
  [key: string]: unknown;
};

/** Ordinals travel with the bitsets they index; see `FacetData` in contracts. */
export type WorkerFacetsData = {
  total: number;
  counts: FacetCounts;
  bitsets: Record<string, string>;
  ordinals?: string[];
};

export type WorkerInitMessage = {
  type: 'init';
  indexJson: string;
  facetsData?: WorkerFacetsData;
  semanticIndexJson?: string;
};

/**
 * Vectors arrive after init. The semantic index is 1.55 MB gzip and nothing
 * needs it until someone types; the client re-runs the outstanding query once
 * it lands, because semantic carries 0.38 of the relevance blend and the
 * ranking visibly improves.
 */
export type WorkerSemanticMessage = {
  type: 'semantic';
  semanticIndexJson: string;
};

export type WorkerExtendedMessage = {
  type: 'extended';
  indexJson: string;
};

/**
 * A facets payload delivered after init — a retry following an earlier
 * fetch failure, or a corrected artifact. See `applyFacets` in
 * `worker-engine-init.ts` for why it is only accepted when its `total`
 * matches the engine's current, complete ordinal count.
 */
export type WorkerFacetsMessage = {
  type: 'facets';
  facetsData: WorkerFacetsData;
};

export type WorkerSearchMessage = {
  type: 'search';
  id: number;
  query: string;
  filters?: SearchFilters;
  options?: {
    sort?: string;
    page?: number;
    limit?: number;
  };
};

export type WorkerMessage =
  | WorkerInitMessage
  | WorkerSearchMessage
  | WorkerSemanticMessage
  | WorkerExtendedMessage
  | WorkerFacetsMessage;

export type SearchResponse = {
  type: 'searchResult';
  id: number;
  ids: string[];
  items: RankedSearchDisplayItem[];
  total: number;
  counts: FacetCounts;
};
