import Link from 'next/link';
import { MAX_STATIC_HUB_PAGES } from '../catalogue/hub-route';

export type HubPaginationProps = {
  basePath: string;
  currentPage: number;
  totalPages: number;
};

export function HubPagination({ basePath, currentPage, totalPages }: HubPaginationProps) {
  const publishedPages = Math.min(totalPages, MAX_STATIC_HUB_PAGES);
  if (publishedPages <= 1) return null;

  const ensureTrailingSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

  const pageUrl = (p: number) => {
    if (p === 1) return ensureTrailingSlash(basePath);
    return ensureTrailingSlash(`${basePath.replace(/\/$/, '')}/${p}`);
  };

  const prevUrl = currentPage > 1 ? pageUrl(currentPage - 1) : null;
  const nextUrl = currentPage < publishedPages ? pageUrl(currentPage + 1) : null;

  const start = Math.max(1, currentPage - 2);
  const end = Math.min(publishedPages, currentPage + 2);
  // The first page is the shallowest static entry point from the home page.
  // Keep every page number there so a workflow on any paginated slice is
  // reachable without forcing crawlers through a long prev/next chain.
  const pages = currentPage === 1
    ? Array.from({ length: publishedPages }, (_, index) => index + 1)
    : Array.from({ length: end - start + 1 }, (_, index) => start + index);

  return (
    <nav aria-label="Pagination" className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-hairline pt-6 text-sm font-mono">
      <div className="flex items-center space-x-2">
        {prevUrl ? (
          <Link
            href={prevUrl}
            className="px-3 py-1.5 rounded-control bg-panel border border-hairline text-ink font-bold hover:border-hairline-strong transition-colors"
            rel="prev"
          >
            &larr; Prev
          </Link>
        ) : (
          <span className="px-3 py-1.5 rounded-control bg-panel border border-hairline text-ink-muted/40 cursor-not-allowed">
            &larr; Prev
          </span>
        )}
      </div>

      <div className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-1.5 overflow-y-auto [scrollbar-gutter:stable]" style={currentPage === 1 ? { maxHeight: '8rem' } : undefined}>
        {currentPage !== 1 && start > 1 && (
          <>
            <Link
              href={pageUrl(1)}
              className={`px-3 py-1.5 rounded-control border border-hairline transition-colors ${
                currentPage === 1
                  ? 'bg-ink border-ink text-page font-bold'
                  : 'bg-panel text-ink hover:border-hairline-strong'
              }`}
            >
              1
            </Link>
            {start > 2 && <span className="text-ink-muted px-1">...</span>}
          </>
        )}

        {pages.map((p) => (
          <Link
            key={p}
            href={pageUrl(p)}
            className={`px-3 py-1.5 rounded-control border border-hairline transition-colors ${
              currentPage === p
                ? 'bg-ink border-ink text-page font-bold'
                : 'bg-panel text-ink hover:border-hairline-strong'
            }`}
            aria-current={currentPage === p ? 'page' : undefined}
          >
            {p}
          </Link>
        ))}

        {currentPage !== 1 && end < publishedPages && (
          <>
            {end < publishedPages - 1 && <span className="text-ink-muted px-1">...</span>}
            <Link
              href={pageUrl(publishedPages)}
              className={`px-3 py-1.5 rounded-control border border-hairline transition-colors ${
                currentPage === publishedPages
                  ? 'bg-ink border-ink text-page font-bold'
                  : 'bg-panel text-ink hover:border-hairline-strong'
              }`}
            >
              {publishedPages}
            </Link>
          </>
        )}
      </div>

      <div className="flex items-center space-x-2">
        {nextUrl ? (
          <Link
            href={nextUrl}
            className="px-3 py-1.5 rounded-control bg-panel border border-hairline text-ink font-bold hover:border-hairline-strong transition-colors"
            rel="next"
          >
            Next &rarr;
          </Link>
        ) : (
          <span className="px-3 py-1.5 rounded-control bg-panel border border-hairline text-ink-muted/40 cursor-not-allowed">
            Next &rarr;
          </span>
        )}
      </div>
    </nav>
  );
}
