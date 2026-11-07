'use client';

import type { ReactNode } from 'react';
import type { Entry } from '@hub/contracts';
import { LicenceBadge } from '../primitives/badge';
import { GradePill } from '../primitives/pill';
import { DownloadControl } from './download-control';
import { safeHttpUrl, stripInvisible } from '../../seo/hostile-text';
import { authorDisplayName } from '../../catalogue/author-display';

type ProvenanceCardProps = {
  entry: Entry;
  staticDownloadHref?: string;
  showMetrics?: boolean;
};

export function ProvenanceCard({ entry, staticDownloadHref, showMetrics = false }: ProvenanceCardProps) {
  const { source, rights } = entry;
  const author = authorDisplayName(source.author?.name);
  const sourceHref = safeExternalHref(source.permalink);
  const authorHref = safeExternalHref(source.author?.url);
  const licenceHref = safeExternalHref(rights.licenceUrl);

  return (
    <aside
      aria-label="Workflow provenance and trust"
      className="flex flex-col gap-4 rounded-panel border border-hairline bg-panel p-4 shadow-sm"
    >
      <div className="flex items-center justify-between border-b border-hairline pb-3">
        <h3 className="font-display text-base font-semibold text-ink">Provenance & Trust</h3>
        <GradePill grade={entry.security.grade} />
      </div>

      <dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-2 text-xs">
        <dt className="font-mono text-ink-faint">Source</dt>
        <dd className="truncate">
          {sourceHref ? (
            <a href={sourceHref} target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline">
              {source.kind === 'n8n_official' ? 'n8n.io' : (source.repo ?? 'GitHub')}
            </a>
          ) : (
            <span className="text-ink-muted">Unavailable</span>
          )}
        </dd>

        <dt className="font-mono text-ink-faint">Author</dt>
        <dd className="truncate text-ink">
          {authorHref ? (
            <a href={authorHref} target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline">
              {author}
            </a>
          ) : (
            <span>{author}</span>
          )}
        </dd>

        <dt className="font-mono text-ink-faint">Licence</dt>
        <dd>
          {licenceHref ? (
            <a href={licenceHref} target="_blank" rel="noopener noreferrer">
              <LicenceBadge licence={rights.licence} />
            </a>
          ) : (
            <LicenceBadge licence={rights.licence} />
          )}
        </dd>

        <dt className="font-mono text-ink-faint">Rights</dt>
        <dd className="truncate text-ink-muted" title={rights.reason}>
          {rights.reason}
        </dd>

        <dt className="font-mono text-ink-faint">Fetched</dt>
        <dd className="text-ink-muted">
          <time dateTime={source.fetchedAt}>{formatDate(source.fetchedAt)}</time>
        </dd>
      </dl>

      {showMetrics && (
        <div aria-label="Workflow metrics" className="grid grid-cols-2 gap-2 rounded-md border border-hairline bg-raised/50 p-2 font-mono text-2xs">
          <div>
            <span className="text-ink-faint">NODES: </span>
            <strong className="text-ink">{entry.structure.nodeCount}</strong>
          </div>
          <div>
            <span className="text-ink-faint">TRIGGER: </span>
            <strong className="text-ink truncate">{entry.structure.trigger || 'Manual'}</strong>
          </div>
          <div>
            <span className="text-ink-faint">CONNS: </span>
            <strong className="text-ink">{entry.structure.connectionCount}</strong>
          </div>
          <div>
            <span className="text-ink-faint">COMPLEXITY: </span>
            <strong className="text-ink">{entry.structure.complexity}</strong>
          </div>
        </div>
      )}

      <div className="border-t border-hairline pt-3">
        {entry.rights.status === 'redistributable' && !staticDownloadHref ? (
          <DownloadControl entry={entry} />
        ) : sourceHref || entry.rights.status === 'redistributable' ? (
          <a
            href={entry.rights.status === 'redistributable' ? staticDownloadHref! : sourceHref!}
            target={entry.rights.status === 'redistributable' ? undefined : '_blank'}
            rel={entry.rights.status === 'redistributable' ? undefined : 'noopener noreferrer'}
            className="flex min-h-10 w-full items-center justify-center rounded-md bg-accent px-4 font-mono text-xs font-semibold text-page hover:bg-accent/90"
          >
            {entry.rights.status === 'redistributable'
              ? staticDownloadHref ? 'Download via interactive view' : 'Download workflow'
              : entry.source.kind === 'n8n_official' ? 'View on n8n.io' : 'View on GitHub'}
          </a>
        ) : null}
      </div>
    </aside>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

function safeExternalHref(value: string | undefined | null): string | null {
  const cleaned = typeof value === 'string' ? stripInvisible(value).trim() : '';
  return cleaned && safeHttpUrl(cleaned, '') ? cleaned : null;
}
