import type { Metadata } from 'next';
import { getHubIndex } from '../../../src/catalogue/hub-index';
import { libraryTagHref, publishedHubsForKind } from '../../../src/catalogue/hub-route';
import { sitePath } from '../../../src/ui/site-url.mjs';
import { robotsMetadata } from '../../../src/seo/robots';

export const dynamicParams = false;

type Params = Promise<{ slug: string }>;

/**
 * Legacy tag landing stub. Tag browsing lives in /library; these paths exist
 * so old links land somewhere useful. They render a meta-refresh hop to the
 * library URL and are noindex: they hold no content, so the SEO gate exempts
 * them from h1/JSON-LD/canonical.
 */
export function generateStaticParams() {
  return publishedHubsForKind(getHubIndex(), 'tag').map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const target = sitePath(libraryTagHref(slug));
  return {
    title: 'Redirecting…',
    robots: robotsMetadata(false),
    other: { 'meta-refresh': `3;url=${target}` },
  };
}

export default async function TagPage({ params }: { params: Params }) {
  const { slug } = await params;
  const target = sitePath(libraryTagHref(slug));
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
      <meta httpEquiv="refresh" content={`3;url=${target}`} />
    </div>
  );
}
