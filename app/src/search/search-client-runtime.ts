import type { FacetCounts } from './facet-bitset';
import type { SearchEngine, SearchFilters } from './worker';
import { createFallbackEngine } from './fallback-engine';
import { fetchSearchIndexWithRelease, sameSearchReleaseIdentity, type ProgressCallback, type SearchReleaseIdentity } from './fetch-index';
import { fetchFacetsResult } from './fetch-facets';
import { resetFacetsState, setFacetsState } from './facets-state';
import { applyCachedFacets, configureFacetsRetry } from './facets-retry';
import { reportRankingImproved, resetSemanticVectorState } from './semantic-vectors';
import { configureDeferredPayloads, requestExtendedTier, requestSemanticVectorsFor, resetDeferredPayloads } from './deferred-payloads';
import { createSearchQueryController, type SearchResultItem } from './search-client-query';

export { getFacetsState, onFacetsStateChange, type FacetsState } from './facets-state';
export { retryFacets } from './facets-retry';

type FacetsData = { total: number; counts: FacetCounts; bitsets: Record<string, string>; ordinals?: string[] };

let workerInstance: Worker | null = null;
let fallbackEngine: SearchEngine | null = null;
let ready = false;
let warmPromise: Promise<void> | null = null;
let warmResolve: (() => void) | null = null;
let warmToken = 0;
let warmReject: ((error: Error) => void) | null = null;
const progressListeners = new Set<ProgressCallback>();
const itemCache = new Map<string, SearchResultItem>();
let loadedIndexJson: string | null = null;
let loadedFacets: FacetsData | undefined;
let loadedSemanticIndexJson: string | undefined;
let loadedReleaseIdentity: SearchReleaseIdentity | undefined;
// AUDIT-SEARCH-004: the extended tier, kept once delivered so a Worker crash
// can reattach it to the rebuilt fallback engine — its request latches after
// delivery and never re-fetches. Cleared with the rest on reset.
let loadedExtendedIndexJson: string | undefined;
let fallbackPromise: Promise<void> | null = null;
let stateVersion = 0;

function markWorkerReady(): void {
  if (typeof performance !== 'undefined') performance.mark('secureflow:search-worker-ready');
}

const workerFailure = (cause?: unknown): Error => {
  const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  const error = new Error(detail ? `Search worker failed: ${detail}` : 'Search worker failed');
  error.name = 'SearchWorkerError';
  return error;
};

export function getLoadedItem(id: string): SearchResultItem | undefined { return itemCache.get(id); }
export function getLoadedSearchReleaseIdentity(): SearchReleaseIdentity | undefined { return loadedReleaseIdentity; }
export function onProgress(callback: ProgressCallback): () => void { progressListeners.add(callback); return () => progressListeners.delete(callback); }
function reportProgress(loaded: number, total: number): void { for (const callback of progressListeners) callback(loaded, total); }

function recoverFallbackAfterWorkerFailure(): void {
  const recoveryVersion = stateVersion;
  const expectedIdentity = loadedReleaseIdentity;
  const indexPromise = loadedIndexJson
    ? Promise.resolve(loadedIndexJson)
    : expectedIdentity
      ? fetchSearchIndexWithRelease(() => undefined).then((verified) => {
        if (!sameSearchReleaseIdentity(expectedIdentity, verified.identity)) {
          throw new Error('Search release changed during worker recovery');
        }
        return verified.indexJson;
      })
      : null;
  if (!indexPromise) return;

  void indexPromise
    .then((indexJson) => {
      if (recoveryVersion !== stateVersion) return;
      return startFallback(indexJson, loadedFacets, loadedSemanticIndexJson, loadedExtendedIndexJson);
    })
    .catch(() => {
      if (recoveryVersion === stateVersion) { ready = false; fallbackEngine = null; }
    });
}

configureDeferredPayloads({
  version: () => stateVersion,
  deliverExtended: (indexJson) => {
    loadedExtendedIndexJson = indexJson;
    if (workerInstance) { workerInstance.postMessage({ type: 'extended', indexJson }); return false; }
    return fallbackEngine?.loadExtendedIndex(indexJson) ?? false;
  },
  deliverSemantic: (semanticIndexJson) => {
    loadedSemanticIndexJson = semanticIndexJson;
    if (workerInstance) { workerInstance.postMessage({ type: 'semantic', semanticIndexJson }); return false; }
    return fallbackEngine?.loadSemanticVectors(semanticIndexJson) ?? false;
  },
});

function handleWorkerFailure(cause?: unknown, failedWorker?: Worker): void {
  if (failedWorker && workerInstance !== failedWorker) return;
  const failure = workerFailure(cause);
  workerInstance?.terminate(); workerInstance = null; ready = false;
  queryController.rejectPending(failure);
  queryController.rejectQueued(failure);
  const rejectWarm = warmReject;
  warmResolve = null; warmReject = null; rejectWarm?.(failure);
  // AUDIT-SEARCH-004: reattach an already-delivered extended tier — its latch
  // won't re-request it, so without this recovery would be stuck at primary.
  recoverFallbackAfterWorkerFailure();
}

function startFallback(indexJson: string, facets?: FacetsData, semanticIndexJson?: string, extendedIndexJson?: string): Promise<void> {
  if (fallbackPromise) return fallbackPromise;
  const version = stateVersion;
  fallbackPromise = createFallbackEngine({ indexJson, facets, semanticIndexJson, extendedIndexJson, isCurrent: () => version === stateVersion })
    .then((engine) => {
      if (!engine) return;
      fallbackEngine = engine;
      if (loadedReleaseIdentity) loadedIndexJson = null;
      applyCachedFacets(engine, facets, loadedFacets); // R3-F1: a retry during the import raced this engine's captured facets
      ready = true;
      warmResolve?.(); warmResolve = null; warmReject = null;
      queryController.settleQueued(); requestExtendedTier();
    })
    .finally(() => { fallbackPromise = null; });
  return fallbackPromise;
}

async function loadIndex(onProgress?: ProgressCallback, suppliedIndex?: string, suppliedFacets?: FacetsData, suppliedSemanticIndex?: string): Promise<void> {
  let indexJson = suppliedIndex;
  let facets = suppliedFacets;
  let semanticIndexJson = suppliedSemanticIndex;
  if (!indexJson) {
    const verified = await fetchSearchIndexWithRelease((loaded, total) => { reportProgress(loaded, total); onProgress?.(loaded, total); });
    indexJson = verified.indexJson;
    loadedReleaseIdentity = verified.identity;
    const facetsResult = await fetchFacetsResult();
    if (facetsResult.ok) {
      facets = facetsResult.data as FacetsData;
      setFacetsState({ status: 'ok' });
    } else {
      setFacetsState({ status: 'degraded', reason: facetsResult.reason, retryable: facetsResult.retryable });
    }
    // The semantic index is deliberately fetched only when a tokenised query needs it.
  }
  if (!indexJson) throw new Error('search-index.json unavailable');
  loadedIndexJson = indexJson;
  loadedFacets = facets;
  loadedSemanticIndexJson = semanticIndexJson;
  if (typeof Worker !== 'undefined' && typeof window !== 'undefined') {
    try {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      workerInstance = worker;
      worker.onmessage = (event) => queryController.handleWorkerMessage(event.data, worker);
      worker.onerror = () => handleWorkerFailure(undefined, worker);
      worker.postMessage({ type: 'init', indexJson, facetsData: facets, semanticIndexJson });
      return;
    } catch { workerInstance?.terminate(); workerInstance = null; }
  }
  await startFallback(indexJson, facets, semanticIndexJson);
}

function startWarm(onProgress?: ProgressCallback, suppliedIndex?: string, suppliedFacets?: FacetsData, suppliedSemanticIndex?: string): Promise<void> {
  if (ready) return Promise.resolve();
  if (fallbackPromise) return fallbackPromise;
  if (warmPromise && suppliedIndex) { warmToken++; warmPromise = null; warmResolve = null; warmReject = null; }
  if (warmPromise) return warmPromise;
  const token = ++warmToken;
  warmPromise = new Promise<void>((resolve, reject) => {
    warmResolve = resolve; warmReject = reject;
    void loadIndex(onProgress, suppliedIndex, suppliedFacets, suppliedSemanticIndex).catch(reject);
  });
  warmPromise.catch(() => { if (warmToken === token) { warmPromise = null; warmResolve = null; warmReject = null; } });
  return warmPromise;
}

const queryController = createSearchQueryController({
  getWorker: () => workerInstance,
  getFallbackEngine: () => fallbackEngine,
  isReady: () => ready,
  startWarm: () => startWarm(),
  isCurrentWarm: (promise) => warmPromise === promise,
  requestExtendedTier,
  requestSemanticVectorsFor,
  cacheItems: (items) => { for (const item of items) itemCache.set(item.id, item); },
  onWorkerFailure: handleWorkerFailure,
  onWorkerReady: () => {
    ready = true;
    if (loadedReleaseIdentity) loadedIndexJson = null;
    markWorkerReady(); warmResolve?.(); warmResolve = null; warmReject = null;
  },
  reportRankingImproved,
  onFacetsApplied: () => setFacetsState({ status: 'ok' }),
});

configureFacetsRetry({
  hasWorker: () => workerInstance !== null,
  postToWorker: (facetsData) => workerInstance?.postMessage({ type: 'facets', facetsData }),
  getFallbackEngine: () => fallbackEngine,
  cacheFacets: (facetsData) => { loadedFacets = facetsData as FacetsData; },
});

export function warmIndex(): Promise<void>;
export function warmIndex(indexJson: string, facetsData?: FacetsData, semanticIndexJson?: string): Promise<void>;
export function warmIndex(onProgress: ProgressCallback | undefined, indexJson?: string, facetsData?: FacetsData, semanticIndexJson?: string): Promise<void>;
export function warmIndex(
  onProgressOrIndex?: ProgressCallback | string,
  suppliedIndexOrFacets?: string | FacetsData,
  suppliedFacets?: FacetsData | string,
  suppliedSemanticIndex?: string,
): Promise<void> {
  if (typeof onProgressOrIndex === 'string') {
    return startWarm(undefined, onProgressOrIndex, suppliedIndexOrFacets as FacetsData | undefined, suppliedFacets as string | undefined);
  }
  return startWarm(onProgressOrIndex, suppliedIndexOrFacets as string | undefined, suppliedFacets as FacetsData | undefined, suppliedSemanticIndex);
}

export function search(query: string, filters?: SearchFilters, options?: { sort?: string; page?: number; limit?: number }, signal?: AbortSignal) {
  return queryController.search(query, filters, options, signal);
}

export function resetSearchClientState(): void {
  stateVersion++; resetDeferredPayloads(); resetSemanticVectorState(); resetFacetsState();
  workerInstance?.terminate(); workerInstance = null; fallbackEngine = null; fallbackPromise = null;
  loadedIndexJson = null; loadedFacets = undefined; loadedSemanticIndexJson = undefined; loadedReleaseIdentity = undefined;
  loadedExtendedIndexJson = undefined; ready = false; warmPromise = null; warmResolve = null; warmReject = null;
  queryController.reset(); itemCache.clear();
}

if (typeof window !== 'undefined') {
  document.addEventListener('focusin', (event) => { if ((event.target as Element | null)?.matches?.('input[type="search"], input[role="combobox"]')) void startWarm(); }, { once: true });
}
