'use client';
import { useEffect, useRef, useState } from 'react';
import { getFacetsState, onFacetsStateChange, retryFacets, type FacetsState } from '../search/search-client';

/**
 * A facets failure never hides catalogue coverage (ordinals are reconciled
 * from the extended index regardless — see `worker-engine-init.ts`), so this
 * must say "filtering is limited," never "results are incomplete." The six
 * `FacetsFailureReason`s collapse to two copies because the user's available
 * action only ever has two shapes: retry, or reload. `role="status"` keeps
 * this container mounted for the component's lifetime so a recovery updates
 * the same live region instead of removing a focused node from the DOM.
 */
export function FacetsNotice() {
  const [state, setState] = useState<FacetsState>(getFacetsState);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => onFacetsStateChange((next) => {
    if (state.status === 'degraded' && next.status === 'ok' && containerRef.current?.contains(document.activeElement)) {
      containerRef.current.focus();
    }
    setState(next);
  }), [state]);
  return (
    <div ref={containerRef} tabIndex={-1} role="status">
      {state.status === 'degraded' && (
        <div className="rounded-panel border border-hairline bg-panel p-3 text-sm text-ink-muted">
          Filtering is limited — results are complete.{' '}
          {state.retryable ? (
            <button
              type="button"
              onClick={() => void retryFacets()}
              className="ml-1 min-h-11 rounded-control border border-hairline px-2 text-accent-text transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border active:bg-raised"
            >
              Retry filters
            </button>
          ) : (
            'Reload the page to restore it.'
          )}
        </div>
      )}
    </div>
  );
}
