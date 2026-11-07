'use client';

import Link from 'next/link';

/**
 * SW-2 (audit 2026-08-25). Without this, an uncaught render error in any route
 * segment falls through to Next's default boundary, which in production is the
 * bare string "Application error: a client-side exception has occurred" — no
 * recovery, no navigation, no way to report it. The scanner, the search client
 * and `/w/view/` are all heavy client components, so this is reachable.
 *
 * `error.message` is deliberately not rendered: it can carry internals, and it
 * tells the reader nothing they can act on.
 */
export default function RouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto flex max-w-[68ch] flex-col items-start gap-4 py-12">
      <p className="font-mono text-2xs uppercase tracking-[0.16em] text-ink-faint">Error</p>
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink md:text-4xl">
        This page stopped working
      </h1>
      <p className="text-base leading-7 text-ink-muted">
        Something failed while rendering. Nothing you scanned was sent anywhere — the scanner runs
        entirely in your browser, and that is still true when it breaks.
      </p>
      <div className="mt-2 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={reset}
          className="flex min-h-11 items-center rounded-control bg-accent px-4 font-mono text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent-border"
        >
          Try again
        </button>
        <Link
          href="/library/"
          className="flex min-h-11 items-center rounded-control border border-hairline px-4 font-mono text-sm text-ink transition-colors hover:border-ink-muted hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent-border"
        >
          Back to the library
        </Link>
      </div>
      <p className="mt-2 text-sm leading-6 text-ink-muted">
        If it keeps happening,{' '}
        <Link className="text-accent-text underline underline-offset-2" href="/takedown/#security">
          tell us
        </Link>
        .
      </p>
    </div>
  );
}
