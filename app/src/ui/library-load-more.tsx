'use client';

import { useEffect, useRef } from 'react';

type LibraryLoadMoreProps = {
  loaded: number;
  total: number;
  busy: boolean;
  onLoadMore: () => void;
};

/**
 * A button, not a bare scroll sentinel.
 *
 * Infinite scroll alone would make the footer unreachable — and the footer is
 * where the takedown and licence links live, which is not something to put
 * permanently out of reach. It is also invisible to the keyboard, and it fights
 * the roving `activeIndex` the results list already uses for arrow-key
 * navigation.
 *
 * So the button is the mechanism and an IntersectionObserver merely presses it
 * when the reader scrolls to the end. Turning JavaScript observation off leaves
 * a control that still works.
 */
export function LibraryLoadMore({ loaded, total, busy, onLoadMore }: LibraryLoadMoreProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const remaining = Math.max(0, total - loaded);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || busy || remaining === 0) return;
    if (typeof IntersectionObserver === 'undefined') return;
    // `fired` stops a single intersection queueing several pages while the
    // first is still in flight.
    let fired = false;
    const observer = new IntersectionObserver((entries) => {
      if (fired || !entries.some((entry) => entry.isIntersecting)) return;
      fired = true;
      onLoadMore();
    }, { rootMargin: '400px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [busy, onLoadMore, remaining]);

  if (remaining === 0) {
    return (
      <p className="mt-4 text-center font-mono text-2xs text-ink-faint">
        That is all {total.toLocaleString()} {total === 1 ? 'workflow' : 'workflows'}.
      </p>
    );
  }

  return (
    <div className="mt-4 flex flex-col items-center gap-2">
      <div ref={sentinelRef} aria-hidden="true" className="h-px w-full" />
      <button
        type="button"
        onClick={onLoadMore}
        disabled={busy}
        className="min-h-11 w-full rounded-control border border-hairline bg-panel px-4 font-mono text-sm text-ink transition-colors hover:border-ink-muted hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border active:bg-raised disabled:opacity-60 sm:w-auto sm:px-8"
      >
        {busy ? 'Loading…' : 'Load more workflows'}
      </button>
      {/*
        Announced, because appending list items is silent to a screen reader —
        the reader is told "48 of 60", not left to infer it from the scrollbar.
      */}
      <p aria-live="polite" className="font-mono text-2xs tabular-nums text-ink-faint">
        Showing {loaded.toLocaleString()} of {total.toLocaleString()}
      </p>
    </div>
  );
}
