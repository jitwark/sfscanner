import {
  buildSemanticVector,
  cosineSimilarity,
  normalizeDiscoveryFilterValue,
  normalizeTaxonomyFilterValue,
} from '@hub/contracts';
import { matchTokens } from './lexical-match';
import { sortSearchResults } from './result-sort';
import {
  computeLiveCounts,
  createBitsetFromIndices,
  intersectUint32Arrays,
  unionUint32Arrays,
} from './facet-bitset';
import type {
  RankedSearchDisplayItem,
  SearchFilters,
  SearchResponse,
} from './worker-messages';
import type { SearchEngineState } from './worker-engine-state';

type SearchOptions = { sort?: string; page?: number; limit?: number };

function selectedValues(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function appendFilterGroup(
  state: SearchEngineState,
  target: Uint32Array[],
  prefix: string,
  selected: string[],
  normalize: (value: string) => string | null,
): void {
  if (selected.length === 0) return;
  const normalized = [...new Set(selected.map(normalize))];
  const bitsets = normalized.map((value) => value === null
    ? new Uint32Array(Math.ceil(state.totalEntries / 32))
    : state.rawBitsets[`${prefix}:${value}`]
      ?? new Uint32Array(Math.ceil(state.totalEntries / 32)));
  target.push(unionUint32Arrays(bitsets, state.totalEntries));
}

function addFilters(state: SearchEngineState, filters: SearchFilters | undefined, target: Uint32Array[]): void {
  if (!filters) return;
  appendFilterGroup(state, target, 'rights', selectedValues(filters.rights), (value) => normalizeTaxonomyFilterValue('rights', value));
  appendFilterGroup(state, target, 'grade', selectedValues(filters.grade), (value) => normalizeTaxonomyFilterValue('security', value));
  appendFilterGroup(state, target, 'trigger', selectedValues(filters.trigger), (value) => normalizeTaxonomyFilterValue('trigger', value));
  appendFilterGroup(state, target, 'complexity', selectedValues(filters.complexity), (value) => normalizeTaxonomyFilterValue('complexity', value));
  appendFilterGroup(state, target, 'capability', selectedValues(filters.capability), (value) => normalizeTaxonomyFilterValue('capability', value));
  appendFilterGroup(state, target, 'integration', selectedValues(filters.integration), normalizeDiscoveryFilterValue);
  appendFilterGroup(state, target, 'tag', selectedValues(filters.tag), normalizeDiscoveryFilterValue);
}

export function runSearch(
  state: SearchEngineState,
  reqId: number,
  query: string,
  filters?: SearchFilters,
  options?: SearchOptions,
): SearchResponse | null {
  if (reqId <= state.lastHandledQueryId) return null;
  state.lastHandledQueryId = reqId;
  if (!state.miniSearch) return null;

  const tokens = query.match(/"[^"]*"|\S+/g) || [];
  const matches: Array<{ ordinal: number; bm25: number; semantic: number }> = [];
  const semanticScores = new Map<number, number>();
  const hasQuotedPhrase = tokens.some((token) => token.startsWith('"') && token.endsWith('"'));
  if (tokens.length > 0 && !hasQuotedPhrase && state.semanticVectors.size > 0) {
    const queryVector = buildSemanticVector({ title: query, summary: '', tags: '', integrations: '', trigger: '', content: query });
    for (const [id, vector] of state.semanticVectors) {
      const ordinal = state.idToOrdinal.get(id);
      if (ordinal !== undefined) semanticScores.set(ordinal, Math.max(0, cosineSimilarity(queryVector, vector)));
    }
  }

  // A tag-filtered browse with no limit asks for every match the filter has,
  // so its window is always satisfied by the strict intersection; every other
  // caller gets page × limit candidates, which is what the lexical reach has
  // to fill before the window can be answered with query vocabulary.
  const returnsAllTagMatches = selectedValues(filters?.tag).length > 0 && options?.limit === undefined;
  const requestedWindow = returnsAllTagMatches ? 1 : (options?.page || 1) * (options?.limit || 24);

  if (tokens.length > 0) {
    matches.push(...matchTokens({
      tokens,
      indexes: state.indexes,
      ordinalOf: (id) => state.idToOrdinal.get(id),
      semanticScores,
      requiredCandidates: requestedWindow,
    }));
  } else {
    for (let ordinal = 0; ordinal < state.totalEntries; ordinal++) {
      matches.push({ ordinal, bm25: 1.0, semantic: 0 });
    }
  }

  const filterBitsets = [createBitsetFromIndices(matches.map((match) => match.ordinal), state.totalEntries), state.publishableBitset];
  addFilters(state, filters, filterBitsets);
  const finalBitset = intersectUint32Arrays(filterBitsets);
  const counts = computeLiveCounts(state.rawBitsets, finalBitset);
  const scoreMap = new Map<number, number>();
  let maxBm25 = 0;
  for (const match of matches) {
    scoreMap.set(match.ordinal, match.bm25);
    maxBm25 = Math.max(maxBm25, match.bm25);
  }

  const finalMatched: RankedSearchDisplayItem[] = [];
  for (let ordinal = 0; ordinal < state.totalEntries; ordinal++) {
    if ((finalBitset[ordinal >> 5]! & (1 << (ordinal & 31))) === 0) continue;
    const item = state.ordinalToItem[ordinal];
    if (!item) continue;
    const bm25 = scoreMap.get(ordinal) ?? 0;
    const semantic = semanticScores.get(ordinal) ?? 0;
    const lexical = maxBm25 > 0 ? bm25 / maxBm25 : 0;
    const relevance = query.trim() ? (0.62 * lexical + 0.38 * semantic) : 1;
    finalMatched.push({ ...item, score: relevance * (item.qualityScore || 1), lexicalScore: lexical, semanticScore: semantic });
  }

  sortSearchResults(finalMatched, query, options?.sort);
  const limit = returnsAllTagMatches ? finalMatched.length : options?.limit || 24;
  const page = returnsAllTagMatches ? 1 : options?.page || 1;
  const pagedItems = finalMatched.slice((page - 1) * limit, (page - 1) * limit + limit);
  return { type: 'searchResult', id: reqId, ids: finalMatched.map((item) => item.id), items: pagedItems, total: finalMatched.length, counts };
}
