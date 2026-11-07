import type { FacetsFailureReason } from './fetch-facets';

/**
 * The facets degraded state, mirroring the `onProgress` / `onRankingImproved`
 * pub/sub shape already used elsewhere in this module for "something optional
 * changed, tell whoever is showing UI about it." A `degraded` state is always
 * paired with a reason and whether the runtime — or a user-triggered retry —
 * can plausibly recover it; see `search-client-runtime.ts`'s `retryFacets`.
 */
export type FacetsState =
  | { status: 'ok' }
  | { status: 'degraded'; reason: FacetsFailureReason; retryable: boolean };

const listeners = new Set<(state: FacetsState) => void>();
let current: FacetsState = { status: 'ok' };

export function getFacetsState(): FacetsState {
  return current;
}

export function setFacetsState(next: FacetsState): void {
  current = next;
  for (const listener of listeners) listener(current);
}

export function onFacetsStateChange(callback: (state: FacetsState) => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function resetFacetsState(): void {
  current = { status: 'ok' };
  listeners.clear();
}
