import type { Metadata } from 'next';
import { allEntries, indexableSlugs } from '../../src/catalogue/prerender-list';
import { buildLibraryProjection, libraryTotal } from '../../src/catalogue/library-projection';
import { hubMeta } from '../../src/seo/page-meta';
import { LibraryClient } from '../../src/ui/library-client';
import type { FacetCounts } from '../../src/search/facet-bitset';
import { JsonLdScript, pageJsonLd } from '../../src/seo/json-ld';
import { readManifestSync } from '../../src/catalogue/manifest-node';
import { searchReleaseIdentityFromManifest } from '../../src/search/fetch-index';
import { Breadcrumbs } from '../../src/ui/breadcrumbs';

export async function generateMetadata(): Promise<Metadata> {
  return hubMeta('library', 'library', 1, libraryTotal(allEntries()));
}

export default function LibraryPage() {
  const entries = allEntries();
  const prerendered = new Set(indexableSlugs());
  const projection = buildLibraryProjection(entries, prerendered);
  const releaseIdentity = searchReleaseIdentityFromManifest(readManifestSync());
  const firstPage = projection.items.slice(0, 24);
  return (
    <div className="flex flex-col gap-6">
      <JsonLdScript data={pageJsonLd({ name: 'Library', path: '/library/', description: 'Search the catalogue of n8n workflows by task, integration, trigger, complexity, and security grade.', collection: true, })} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Library' }]} className="rounded-control" />
      <header className="flex flex-col gap-2 border-b border-hairline pb-5">
        <p className="font-mono text-2xs uppercase tracking-[0.16em] text-accent-text font-bold">Community catalogue</p>
        <h1 className="font-sans text-3xl font-bold tracking-tight text-ink md:text-4xl">Find a workflow that fits</h1>
        <p className="max-w-[68ch] text-sm leading-6 text-ink-muted">
          Search {projection.total.toLocaleString()} workflows by what they do, which services they
          connect and how they run. Every result carries its security grade and its licence status,
          so you know what you are importing before you import it.
        </p>
      </header>
      <LibraryClient initialItems={firstPage} initialCounts={projection.facets.counts as FacetCounts} totalCount={projection.total} initialReleaseIdentity={releaseIdentity} />
    </div>
  );
}
