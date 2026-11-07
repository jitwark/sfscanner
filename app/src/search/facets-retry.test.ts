// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCachedFacets } from './facets-retry';
import { getFacetsState, resetFacetsState, setFacetsState } from './facets-state';

afterEach(() => {
  resetFacetsState();
  vi.restoreAllMocks();
});

/**
 * R3-F1. `createFallbackEngine` closes over the `facets` value passed when
 * `startFallback` was invoked, but it awaits a real dynamic import before the
 * engine exists. A `retryFacets()` landing in that window cached fresh facets
 * that the constructed engine never saw — and the retry reported `ok`, so the
 * degraded notice disappeared while every faceted filter silently returned
 * nothing.
 *
 * Reachable from two real paths: a browser that cannot construct a module
 * Worker, and *every worker-crash recovery* — the exact path W2-B added in this
 * same session, where the retry button is already on screen.
 */
describe('applyCachedFacets — the retry/construction race (R3-F1)', () => {
  const engineThatAccepts = () => ({ applyFacets: vi.fn(() => true) });
  const engineThatRejects = () => ({ applyFacets: vi.fn(() => false) });

  it('delivers facets that were cached after the engine was already building', () => {
    const engine = engineThatAccepts();
    setFacetsState({ status: 'degraded', reason: 'unavailable', retryable: true });

    applyCachedFacets(engine, undefined, { total: 6 });

    expect(engine.applyFacets).toHaveBeenCalledWith({ total: 6 });
    expect(getFacetsState()).toEqual({ status: 'ok' });
  });

  it('reports degraded, not ok, when the late facets do not match the corpus', () => {
    const engine = engineThatRejects();
    setFacetsState({ status: 'degraded', reason: 'unavailable', retryable: true });

    applyCachedFacets(engine, undefined, { total: 3 });

    expect(getFacetsState()).toEqual({ status: 'degraded', reason: 'incomplete', retryable: true });
  });

  it('does no work when the engine was already built with the cached facets', () => {
    const engine = engineThatAccepts();
    const facets = { total: 6 };

    applyCachedFacets(engine, facets, facets);

    expect(engine.applyFacets).not.toHaveBeenCalled();
  });

  it('does no work when nothing was cached', () => {
    const engine = engineThatAccepts();

    applyCachedFacets(engine, undefined, undefined);

    expect(engine.applyFacets).not.toHaveBeenCalled();
  });

  it('leaves a degraded state untouched rather than claiming ok prematurely', () => {
    // The old no-engine branch of `retryFacets` set `{ status: 'ok' }` here on
    // the assumption the cache would be picked up. Nothing had received the
    // facets yet, so that was a false healthy state.
    setFacetsState({ status: 'degraded', reason: 'http', retryable: true });

    applyCachedFacets(engineThatAccepts(), undefined, undefined);

    expect(getFacetsState()).toEqual({ status: 'degraded', reason: 'http', retryable: true });
  });
});
