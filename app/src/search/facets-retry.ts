import { fetchFacetsResult } from './fetch-facets';
import { getFacetsState, setFacetsState, type FacetsState } from './facets-state';
import type { WorkerFacetsData } from './worker-messages';

/**
 * Retries the facets artifact after an earlier failure (see `fetchFacetsResult`
 * for the reasons that put it in a degraded state). Facets never gate corpus
 * coverage — the ordinal universe is reconciled from the extended index
 * regardless (`worker-engine-init.ts`) — so recovering here only ever
 * restores live filter counts. The caller supplies how to reach whichever
 * engine is live, because that is a worker `postMessage` on the normal path
 * and a direct call on the fallback path, mirroring `deferred-payloads.ts`.
 */
export type FacetsRetryTarget = {
  hasWorker: () => boolean;
  postToWorker: (facetsData: WorkerFacetsData) => void;
  getFallbackEngine: () => { applyFacets: (facetsData: WorkerFacetsData) => boolean } | null;
  cacheFacets: (facetsData: WorkerFacetsData) => void;
};

let target: FacetsRetryTarget | null = null;

export function configureFacetsRetry(next: FacetsRetryTarget): void {
  target = next;
}

export async function retryFacets(): Promise<FacetsState> {
  const result = await fetchFacetsResult();
  if (!result.ok) {
    setFacetsState({ status: 'degraded', reason: result.reason, retryable: result.retryable });
    return getFacetsState();
  }
  if (!target) return getFacetsState();
  target.cacheFacets(result.data);
  if (target.hasWorker()) {
    // Confirmed asynchronously by the 'facetsReady' worker message.
    target.postToWorker(result.data);
    return getFacetsState();
  }
  const fallback = target.getFallbackEngine();
  if (!fallback) {
    // R3-F1: warm-up is still in flight, so nothing has received these facets
    // yet. This used to report `ok` on the assumption the cache would be picked
    // up — but `createFallbackEngine` closes over the `facets` argument passed
    // when `startFallback` was invoked, so a retry landing during the dynamic
    // import was silently dropped while the UI showed a healthy state and every
    // faceted filter returned nothing. `applyCachedFacets` below now re-applies
    // the cache once the engine exists; until it confirms, leave the state as it
    // is, exactly like the worker branch above.
    return getFacetsState();
  }
  setFacetsState(fallback.applyFacets(result.data)
    ? { status: 'ok' }
    : { status: 'degraded', reason: 'incomplete', retryable: true });
  return getFacetsState();
}

/**
 * Re-applies whatever facets the module cache holds to a freshly constructed
 * engine, when that differs from the value the engine was built with. Closes
 * the R3-F1 race between `retryFacets()` and fallback-engine construction.
 */
export function applyCachedFacets<T>(
  engine: { applyFacets: (data: T) => boolean },
  builtWith: T | undefined,
  cached: T | undefined,
): void {
  if (!cached || cached === builtWith) return;
  setFacetsState(engine.applyFacets(cached)
    ? { status: 'ok' }
    : { status: 'degraded', reason: 'incomplete', retryable: true });
}
