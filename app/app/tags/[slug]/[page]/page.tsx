import type { Metadata } from 'next';
import { getHubIndex } from '../../../../src/catalogue/hub-index';
import { libraryTagHref } from '../../../../src/catalogue/hub-route';
import { sitePath } from '../../../../src/ui/site-url.mjs';
import { robotsMetadata } from '../../../../src/seo/robots';

export const dynamicParams = false;

type Params = Promise<{ slug: string; page: string }>;

/**
 * Legacy pagination stub. Deep tag pages were folded into /library's
 * client-side browsing; these paths exist only so old links land somewhere
 * useful. They render a meta-refresh hop to the library URL and are noindex:
 * they hold no content, so the SEO gate exempts them from h1/JSON-LD/canonical.
 */
/**
 * How deep the stubs go.
 *
 * This was 25. When publication stopped asking about redistribution rights the
 * hubs went from 287 entries to 12,923, every tag gained pages, and the stub
 * count went from ~52 to 982 — 5,892 files and 74 MB of export for pages that
 * hold no content and are noindex by design. A deep-linked page 19 of a tag was
 * never plausible; a bookmarked page 2 or 3 is.
 */
const STUB_PAGE_DEPTH = 5;

export function generateStaticParams() {
  return Object.entries(getHubIndex().tags).flatMap(([slug, hub]) =>
    Array.from({ length: Math.max(0, Math.min(hub.totalPages, STUB_PAGE_DEPTH) - 1) }, (_, index) => ({
      slug,
      page: String(index + 2),
    })),
  );
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, page } = await params;
  const target = sitePath(`${libraryTagHref(slug)}&page=${page}`);
  return {
    title: 'Redirecting…',
    robots: robotsMetadata(false),
    other: { 'meta-refresh': `3;url=${target}` },
  };
}

export default async function LegacyTagPage({ params }: { params: Params }) {
  const { slug, page } = await params;
  const target = sitePath(`${libraryTagHref(slug)}&page=${page}`);
  return (
    <div className="mx-auto max-w-3xl text-center text-ink-muted">
      <h1 className="font-display text-2xl font-semibold text-ink">Moving you there…</h1>
      <p className="mt-3">
        This listing moved. Continue to{' '}
        <a href={target} className="text-accent-text underline">
          {slug.replace(/-/g, ' ')} workflows in the library
        </a>
        .
      </p>
      <noscript>
        <a href={target}>Continue</a>
      </noscript>
      <meta httpEquiv="refresh" content={`3;url=${target}`} />
    </div>
  );
}
