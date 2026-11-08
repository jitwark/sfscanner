import Link from 'next/link';
import type { Route } from 'next';

export type BreadcrumbItem = {
  label: string;
  /** Omitted on the trailing crumb, which is the current page. */
  href?: string;
};

export type BreadcrumbsProps = {
  items: BreadcrumbItem[];
  className?: string;
};

/**
 * The one breadcrumb trail.
 *
 * `hub-header.tsx` carried a second implementation that did not wrap, did not
 * truncate, and had the same sub-24px targets — so a fix applied here silently
 * missed every hub, tag, trigger and integration page. Both now render this.
 *
 * `next/link` rather than a raw anchor: a full page load re-downloads the
 * catalogue data the visitor already has. Link resolves the configured
 * basePath itself, so hrefs here are un-prefixed.
 */
export function Breadcrumbs({ items, className = '' }: BreadcrumbsProps) {
  if (!items || items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumbs" className={`min-w-0 border-b border-hairline bg-raised py-3 px-4 sm:px-6 font-mono text-2xs uppercase tracking-wider ${className}`}>
      <ol className="flex min-w-0 flex-wrap items-center gap-2 text-ink-muted">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;

          return (
            <li
              key={`${item.href ?? item.label}-${index}`}
              className={`flex items-center gap-2 ${isLast ? 'min-w-28 sm:min-w-40 max-w-full flex-1' : 'min-w-0 max-w-28 sm:max-w-40'}`}
            >
              {index > 0 && <span className="select-none text-ink-muted/60" aria-hidden="true">›</span>}
              {isLast || !item.href ? (
                <span className="flex min-h-6 min-w-0 items-center break-words font-bold text-ink" aria-current="page">
                  <span className="sr-only">Current page: </span>
                  {item.label}
                </span>
              ) : (
                <Link
                  href={item.href as Route}
                  prefetch={false}
                  className="flex min-h-6 min-w-0 items-center truncate transition-colors duration-120 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent-border"
                >
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
