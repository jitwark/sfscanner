import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '../../src/ui/breadcrumbs';
import { getHubIndex } from '../../src/catalogue/hub-index';
import { MAX_STATIC_HUBS_PER_KIND, pageNumbers, publishedHubsForKind } from '../../src/catalogue/hub-route';
import { hubMeta } from '../../src/seo/page-meta';
import { JsonLdScript, pageJsonLd } from '../../src/seo/json-ld';

export async function generateMetadata(): Promise<Metadata> {
  return hubMeta('integration', 'index', 1);
}

export default function IntegrationsIndexPage() {
  const hubIndex = getHubIndex();
  const hubs = publishedHubsForKind(hubIndex, 'integration').sort((a, b) => a.title.localeCompare(b.title));
  // The full qualifying set is far larger than what a static export can
  // publish per hub kind (see MAX_STATIC_HUBS_PER_KIND) -- 516 integrations
  // at last count. Naming that gap here, rather than the "All"/"Every"
  // wording this page used to carry, is AUDIT-HUB-001's fix.
  const totalQualifying = Object.keys(hubIndex.integrations).length;
  const description = `Top ${MAX_STATIC_HUBS_PER_KIND} of ${totalQualifying} integrations that appear in at least three workflows, ranked by workflow count.`;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <JsonLdScript
        data={pageJsonLd({
          name: 'Integrations',
          path: '/integrations/',
          description,
          collection: true,
          items: hubs.map((hub) => ({ name: hub.title, path: `/integrations/${hub.slug}/` })),
        })}
      />
      <header className="space-y-3">
        <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Integrations' }]} />
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-ink">
          Popular Integrations
        </h1>
        <p className="text-sm md:text-base text-ink-muted max-w-2xl">
          {description} The number beside each name is how many workflows use it.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {hubs.map((hub) => (
          <div
            key={hub.slug}
            className="p-4 rounded-lg bg-panel border border-hairline space-y-3"
          >
            <Link
              href={`/integrations/${hub.slug}/`}
              className="flex items-center justify-between group"
            >
              <span className="font-medium text-ink group-hover:text-accent-text transition-colors">
                {hub.title}
              </span>
              <span className="text-xs font-mono text-ink-muted">
                {hub.totalEntries}
              </span>
            </Link>
            {hub.totalPages > 1 && (
              <nav aria-label={`${hub.title} pages`} className="flex flex-wrap gap-1">
                {pageNumbers(hub).map((page) => (
                  <Link
                    key={page}
                    href={
                      page === 1
                        ? `/integrations/${hub.slug}/`
                        : `/integrations/${hub.slug}/${page}/`
                    }
                    className="rounded border border-hairline px-2 py-1 text-xs text-ink-muted hover:border-accent-border hover:text-accent-text"
                  >
                    {page}
                  </Link>
                ))}
              </nav>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
