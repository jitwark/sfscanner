import type { Entry } from '@hub/contracts';
import { Breadcrumbs, type BreadcrumbItem } from '../breadcrumbs';
import { LicenceBadge } from '../primitives/badge';
import { GradePill } from '../primitives/pill';
import { DownloadControl } from './download-control';
import { safeHttpUrl, stripInvisible } from '../../seo/hostile-text';
import { detailHref } from '../../catalogue/detail-href';
import { analysisStatusLabel } from '../../scanner/analysis-language';

type DetailHeaderProps = {
  entry: Entry;
  breadcrumbs?: BreadcrumbItem[];
  /**
   * Rendered into a page that will never hydrate, so `DownloadControl` — which
   * fetches a byte range and builds a Blob — would be a button that does
   * nothing. Send the reader to the interactive view instead.
   */
  staticDownloadHref?: string;
};

export function DetailHeader({ entry, breadcrumbs, staticDownloadHref }: DetailHeaderProps) {
  const sourceLabel = entry.source.kind === 'n8n_official' ? 'n8n.io' : entry.source.repo ?? 'GitHub';
  const sourceHref = safeExternalHref(entry.source.permalink);
  const analysisLabel = analysisStatusLabel(entry.security.analysisStatus);
  return (
    <header className="min-w-0 space-y-5">
      <Breadcrumbs items={breadcrumbs ?? defaultBreadcrumbs(entry)} className="rounded-control" />
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-ink-muted">
        {sourceHref ? (
          <a href={sourceHref} className="max-w-full truncate rounded-control border border-hairline bg-raised px-2.5 py-1 hover:text-accent-text">
            {sourceLabel}
          </a>
        ) : (
          <span className="max-w-full truncate rounded-control border border-hairline bg-raised px-2.5 py-1">
            {sourceLabel}
          </span>
        )}
        <LicenceBadge licence={entry.rights.licence ?? 'Link only'} />
        <GradePill grade={entry.security.grade} />
        {analysisLabel ? <span className="rounded-control border border-hairline bg-raised px-2.5 py-0.5">{analysisLabel}</span> : null}
      </div>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between pt-2">
        <div className="min-w-0 max-w-4xl space-y-3">
          <h1 className="break-words text-balance font-sans text-[clamp(2rem,5vw,3.375rem)] font-bold tracking-[-0.02em] text-ink my-4 py-1">
            {entry.title}
          </h1>
          <p className="max-w-[68ch] text-pretty text-base leading-7 text-ink-muted">{entry.summary}</p>
        </div>
        <div className="shrink-0">
          {entry.rights.status === 'redistributable' && !staticDownloadHref ? (
            <DownloadControl entry={entry} />
          ) : sourceHref || entry.rights.status === 'redistributable' ? (
            <a
              href={entry.rights.status === 'redistributable' ? staticDownloadHref! : sourceHref!}
              target={entry.rights.status === 'redistributable' ? undefined : '_blank'}
              rel={entry.rights.status === 'redistributable' ? undefined : 'noopener noreferrer'}
              className="inline-flex min-h-11 items-center rounded-control bg-accent px-5 font-mono text-sm font-bold text-accent-ink hover:brightness-95 active:brightness-90 focus-visible:outline-2 focus-visible:outline-accent-border"
            >
              {entry.rights.status === 'redistributable'
                ? staticDownloadHref
                  ? 'Open interactive view to download'
                  : 'Download workflow'
                : entry.source.kind === 'n8n_official' ? 'View on n8n.io' : 'View on GitHub'}
            </a>
          ) : (
            <p role="status" className="max-w-56 text-right text-sm leading-6 text-ink-muted">
              Source link unavailable.
            </p>
          )}
        </div>
      </div>
      {entry.rights.status === 'link_only' && (
        <p className="border-l-2 border-accent-border pl-3 text-sm text-ink-muted">
          <strong className="font-medium text-ink">Link only.</strong> {entry.rights.reason}
        </p>
      )}
    </header>
  );
}

function safeExternalHref(value: string | undefined | null): string | null {
  const cleaned = typeof value === 'string' ? stripInvisible(value).trim() : '';
  return cleaned && safeHttpUrl(cleaned, '') ? cleaned : null;
}

function defaultBreadcrumbs(entry: Entry): BreadcrumbItem[] {
  const primary = entry.structure.integrations[0] ?? 'Workflows';
  const slug = primary.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return [
    { label: 'Home', href: '/' },
    { label: 'Integrations', href: '/integrations/' },
    // A filtered library view, not a hub page. A hub only exists for an
    // integration with enough published entries behind it, so this crumb was a
    // 404 on every workflow whose primary integration has no hub — and widening
    // search past the rights gate made many more of those reachable. The filter
    // exists for every value by construction.
    { label: primary, href: `/library/?integration=${encodeURIComponent(slug)}` },
    { label: entry.title, href: detailHref(entry) },
  ];
}
