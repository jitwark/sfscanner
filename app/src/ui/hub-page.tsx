import type { Entry } from '@hub/contracts';
import { hubJsonLd, JsonLdScript } from '../seo/json-ld';
import type { HubInfo, HubKind } from '../catalogue/hub-types';
import { HubGrid } from './hub-grid';
import { HubHeader } from './hub-header';
import { HubPagination } from './hub-pagination';
import { isIndexable } from '../seo/page-meta';
import { MAX_STATIC_HUB_PAGES } from '../catalogue/hub-route';

export type HubPageProps = {
  kind: HubKind;
  hub: HubInfo;
  entries: Entry[];
  basePath: string;
  page: number;
  showPagination?: boolean;
};

function collectionLabel(kind: HubKind): string {
  if (kind === 'integration') return 'Integrations';
  if (kind === 'tag') return 'Tags';
  if (kind === 'trigger') return 'Triggers';
  return 'Security';
}

export function HubPage({
  kind,
  hub,
  entries,
  basePath,
  page,
  showPagination = true,
}: HubPageProps) {
  const label = collectionLabel(kind);
  const collectionHref = kind === 'integration' ? '/integrations/' : undefined;
  const breadcrumbs = [
    { label: 'Home', href: '/' },
    ...(collectionHref ? [{ label, href: collectionHref }] : [{ label }]),
    { label: hub.title },
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <HubHeader
        title={hub.title}
        count={hub.totalEntries}
        introCopy={hub.introCopy}
        breadcrumbs={breadcrumbs}
      />
      <JsonLdScript
        data={hubJsonLd(
          kind,
          hub.slug,
          entries.map((entry) => ({ title: entry.title, slug: entry.slug, isIndexable: isIndexable(entry) })),
          page,
        )}
      />
      <HubGrid entries={entries} />
      {hub.totalPages > MAX_STATIC_HUB_PAGES && (
        <p className="mt-6 rounded-lg border border-hairline bg-panel px-4 py-3 text-sm text-ink-muted">
          Showing {entries.length} of {hub.totalEntries} quality-ranked workflows on this static page. The full catalogue is available through library search.
        </p>
      )}
      {showPagination && (
        <HubPagination basePath={basePath} currentPage={page} totalPages={Math.min(hub.totalPages, MAX_STATIC_HUB_PAGES)} />
      )}
    </div>
  );
}
