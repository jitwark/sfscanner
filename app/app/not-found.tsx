import type { Metadata } from 'next';
import Link from 'next/link';
import { robotsMetadata } from '../src/seo/robots';

export const metadata: Metadata = {
  title: 'Page not found · n8n-secureflow',
  robots: robotsMetadata(false),
};

/**
 * SW-2 (audit 2026-08-25). Without this file Next renders its built-in 404:
 * unstyled, no header, no footer, no way back into the catalogue. `w/[slug]`
 * calls `notFound()` for an unknown slug, and the export writes `404.html`, so
 * this is the page a mistyped or stale workflow URL actually lands on.
 */
export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-[68ch] flex-col items-start gap-4 py-12">
      <p className="font-mono text-2xs uppercase tracking-[0.16em] text-ink-faint">404</p>
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink md:text-4xl">
        There is nothing at this address
      </h1>
      <p className="text-base leading-7 text-ink-muted">
        The page may have been removed, or the workflow it pointed at may no longer be in the
        catalogue — entries are withdrawn when a source asks us to. The library is the fastest way
        to find what you were looking for.
      </p>
      <div className="mt-2 flex flex-wrap gap-3">
        <Link
          href="/library/"
          className="flex min-h-11 items-center rounded-control bg-accent px-4 font-mono text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent-border"
        >
          Search the library
        </Link>
        <Link
          href="/scanner/"
          className="flex min-h-11 items-center rounded-control border border-hairline px-4 font-mono text-sm text-ink transition-colors hover:border-ink-muted hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent-border"
        >
          Scan a workflow
        </Link>
      </div>
    </div>
  );
}
