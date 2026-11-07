import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '../../src/ui/breadcrumbs';
import { getHubIndex } from '../../src/catalogue/hub-index';
import { MAX_STATIC_HUBS_PER_KIND, libraryTagHref, publishedHubsForKind } from '../../src/catalogue/hub-route';
import { hubMeta } from '../../src/seo/page-meta';
import { JsonLdScript, pageJsonLd } from '../../src/seo/json-ld';

export async function generateMetadata(): Promise<Metadata> {
  return hubMeta('tag', 'index', 1);
}

/**
 * Index of the top tag hubs, ranked by workflow count.
 *
 * This page exists so that each published tag hub is reachable from the
 * homepage in two clicks. Without it the deeper tag hubs are only linked from
 * workflow pages, which puts them past the crawl budget and out of the link
 * graph.
 *
 * It used to render `hubs.length` -- always MAX_STATIC_HUBS_PER_KIND, because
 * `hubs` is already the capped, published slice -- as if that were the true
 * tag count, under an "All workflow tags" headline. The full qualifying index
 * (111 tags at last count) is larger than a static export can publish per hub
 * kind; see AUDIT-HUB-001.
 */
export default function TagsIndexPage() {
  const hubIndex = getHubIndex();
  const hubs = publishedHubsForKind(hubIndex, 'tag').sort((a, b) => a.title.localeCompare(b.title));
  const totalQualifying = Object.keys(hubIndex.tags).length;
  const description = `Top ${MAX_STATIC_HUBS_PER_KIND} of ${totalQualifying} tags that appear in at least three workflows, ranked by workflow count.`;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <JsonLdScript
        data={pageJsonLd({
          name: 'Tags',
          path: '/tags/',
          description,
          collection: true,
          items: hubs.map((hub) => ({ name: hub.title, path: `/tags/${hub.slug}/` })),
        })}
      />
      <header className="space-y-3">
        <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Tags' }]} />
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-ink">
          Popular Tags
        </h1>
        <p className="text-sm md:text-base text-ink-muted max-w-2xl">
          {description} The number beside each tag is how many workflows carry it.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {hubs.map((hub) => (
          <div key={hub.slug} className="p-4 rounded-lg bg-panel border border-hairline space-y-3">
            <Link href={libraryTagHref(hub.slug)} className="flex items-center justify-between group">
              <span className="font-medium text-ink group-hover:text-accent-text transition-colors">
                {hub.title}
              </span>
              <span className="text-xs font-mono text-ink-muted">{hub.totalEntries}</span>
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
