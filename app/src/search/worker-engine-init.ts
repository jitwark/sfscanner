import MiniSearch from 'minisearch';
import {
  SEARCH_FIELDS,
  SEARCH_OPTIONS,
  SEARCH_STORE_FIELDS,
} from '@hub/contracts';
import { parseSearchIndexJson } from '@hub/contracts/search-index-artifact';
import { parseSemanticIndexJson } from '@hub/contracts/semantic-index-artifact';
import { parseWorkerFacets } from './validated-facets';
import { toRankedItem } from './ranked-item';
import {
  createBitsetFromIndices,
  decodeBase64ToUint32Array,
} from './facet-bitset';
import type { WorkerFacetsData } from './worker-messages';
import type { SearchDocument } from './worker-messages-doc';
import type { SearchEngineState } from './worker-engine-state';

function parseSemantic(json: string | undefined) {
  if (!json) return undefined;
  try { return parseSemanticIndexJson(json); } catch { return undefined; }
}

function ordinalList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((id): id is string => typeof id === 'string');
  return ids.length > 0 ? ids : undefined;
}

function hydrateItems(state: SearchEngineState, index: MiniSearch<SearchDocument>): void {
  state.ordinalIds.forEach((id, ordinal) => {
    if (state.ordinalToItem[ordinal]) return;
    const doc = index.getStoredFields(id);
    if (doc) state.ordinalToItem[ordinal] = toRankedItem(id, doc);
  });
  state.publishableBitset = createBitsetFromIndices(
    state.ordinalToItem.flatMap((item, ordinal) => (item ? [ordinal] : [])),
    state.totalEntries,
  );
}

export function initializeEngine(
  state: SearchEngineState,
  indexJson: string,
  facetsData?: WorkerFacetsData,
  semanticIndexJson?: string,
): void {
  const parsedIndex = parseSearchIndexJson(indexJson);
  const parsedFacets = parseWorkerFacets(facetsData);
  const miniSearch = MiniSearch.loadJSON(indexJson, {
    fields: [...SEARCH_FIELDS],
    storeFields: [...SEARCH_STORE_FIELDS],
    searchOptions: SEARCH_OPTIONS,
  });

  state.miniSearch = miniSearch;
  state.ordinalToItem = [];
  state.idToOrdinal.clear();
  // Facet bitsets belong to one release. Do not let an optional/malformed
  // payload keep filtering a later initialization with stale ordinals.
  state.rawBitsets = {};
  const explicitOrdinals = ordinalList(parsedFacets?.ordinals)
    ?? ordinalList(parseSemantic(semanticIndexJson)?.ordinals);
  const ordinalIds = explicitOrdinals ?? Object.keys(parsedIndex.documentIds ?? {})
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => parsedIndex.documentIds?.[key] ?? '');

  state.ordinalIds = ordinalIds;
  state.ordinalToItem = new Array(ordinalIds.length);
  ordinalIds.forEach((id, ordinal) => state.idToOrdinal.set(id, ordinal));
  state.totalEntries = ordinalIds.length;
  state.indexes = [miniSearch];
  hydrateItems(state, miniSearch);

  state.semanticVectors.clear();
  if (semanticIndexJson) loadSemanticVectors(state, semanticIndexJson);

  if (parsedFacets && parsedFacets.total === state.totalEntries) {
    state.rawBitsets = {};
    for (const [key, base64] of Object.entries(parsedFacets.bitsets)) {
      state.rawBitsets[key] = decodeBase64ToUint32Array(base64);
    }
  }
}

/**
 * AUDIT-SEARCH-002: facets are optional, but the ordinal universe cannot
 * depend on them — before this reconciliation, a missing, malformed, or
 * merely stale facets payload left `ordinalIds` fixed at whatever the
 * primary tier (or a too-small facets total) provided, and the extended
 * tier had nowhere to attach its documents. It silently capped the whole
 * session at the primary tier's document count.
 *
 * The extended index is already independently schema-validated
 * (`parseSearchIndexJson`) and carries its own `documentIds`, in the same
 * catalogue order the pipeline always builds (primary tier, then the rest).
 * That makes it a second, self-sufficient source of truth for corpus
 * completeness: any id it names that the engine does not already know about
 * is a real document that belongs in the ordinal universe, facets or not.
 *
 * Growing `ordinalIds` after init invalidates any bitsets a facets payload
 * already installed — they were only ever sized and computed for the
 * smaller total known at the time. Rather than filter on stale bits, they
 * are dropped: coverage recovers in full, and only filtering degrades until
 * a facets payload whose total matches the new, complete total is applied
 * (see `applyFacets`).
 */
export function loadExtendedSearchIndex(state: SearchEngineState, indexJson: string): boolean {
  if (state.ordinalIds.length === 0) return false;
  let parsedExtended: ReturnType<typeof parseSearchIndexJson>;
  let extended: MiniSearch<SearchDocument>;
  try {
    parsedExtended = parseSearchIndexJson(indexJson);
    extended = MiniSearch.loadJSON(indexJson, {
      fields: [...SEARCH_FIELDS],
      storeFields: [...SEARCH_STORE_FIELDS],
      searchOptions: SEARCH_OPTIONS,
    });
  } catch {
    return false;
  }

  const newIds = Object.keys(parsedExtended.documentIds)
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => parsedExtended.documentIds[key]!)
    .filter((id) => !state.idToOrdinal.has(id));
  if (newIds.length > 0) {
    const start = state.ordinalIds.length;
    state.ordinalIds = [...state.ordinalIds, ...newIds];
    newIds.forEach((id, offset) => state.idToOrdinal.set(id, start + offset));
    state.ordinalToItem.length = state.ordinalIds.length;
    state.totalEntries = state.ordinalIds.length;
    state.rawBitsets = {};
  }

  state.indexes.push(extended);
  const before = state.ordinalToItem.filter(Boolean).length;
  hydrateItems(state, extended);
  return state.ordinalToItem.filter(Boolean).length > before;
}

/**
 * Applies a facets payload fetched after init — a retry following an
 * earlier failure, or a corrected artifact for the release. Only accepted
 * once its `total` matches the engine's current, complete ordinal count:
 * bitsets computed against any other total would misalign silently rather
 * than fail loudly, which is exactly the failure mode this guards against.
 */
export function applyFacets(state: SearchEngineState, facetsData?: WorkerFacetsData): boolean {
  const parsedFacets = parseWorkerFacets(facetsData);
  if (!parsedFacets || parsedFacets.total !== state.totalEntries) return false;
  state.rawBitsets = {};
  for (const [key, base64] of Object.entries(parsedFacets.bitsets)) {
    state.rawBitsets[key] = decodeBase64ToUint32Array(base64);
  }
  return true;
}

export function loadSemanticVectors(state: SearchEngineState, semanticIndexJson: string): boolean {
  const semantic = parseSemantic(semanticIndexJson);
  if (!semantic) return false;
  state.semanticVectors.clear();
  for (const document of semantic.documents) {
    state.semanticVectors.set(document.id, document.vector);
  }
  return state.semanticVectors.size > 0;
}
