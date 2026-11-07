import type { ReactNode } from 'react';
import type { Entry } from '@hub/contracts';
import { safeHttpUrl, stripInvisible } from '../../seo/hostile-text';
import { LicenceBadge } from '../primitives/badge';
import { authorDisplayName } from '../../catalogue/author-display';

type ProvenanceProps = { entry: Entry };

export function Provenance({ entry }: ProvenanceProps) {
  const { source, rights } = entry;
  const author = authorDisplayName(source.author?.name);
  const sourceHref = safeExternalHref(source.permalink);
  const authorHref = safeExternalHref(source.author?.url);
  const licenceHref = safeExternalHref(rights.licenceUrl);
  // P5.3: stars, repository path, and commit are canonical release/audit
  // evidence (still on `entry.source`, still in the release manifest) but are
  // not published on the public detail page. This is a presentation redaction
  // only — do not remove these fields from `EntrySource` to "fix" this.
  return (
    <aside aria-labelledby="provenance-heading" className="min-w-0 space-y-4 rounded-panel border border-hairline bg-panel p-4">
      <h2 id="provenance-heading" className="font-display text-xl font-semibold text-ink">Provenance</h2>
      <dl className="space-y-3 text-sm">
        <ProvenanceRow label="Source">
          {sourceHref ? <a href={sourceHref} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center break-all text-accent-text hover:underline">{source.kind === 'n8n_official' ? 'n8n.io' : (source.repo ?? 'GitHub')}</a> : <span>Source link unavailable</span>}
        </ProvenanceRow>
        <ProvenanceRow label="Source type"><span>{source.kind === 'n8n_official' ? 'Official n8n template' : 'GitHub repository'}</span></ProvenanceRow>
        <ProvenanceRow label="Author">{authorHref ? <a href={authorHref} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center break-words text-accent-text hover:underline">{author}</a> : <span>{author}</span>}</ProvenanceRow>
        <ProvenanceRow label="Fetched"><time dateTime={source.fetchedAt}>{formatDate(source.fetchedAt)}</time></ProvenanceRow>
        <ProvenanceRow label="Licence">
          {licenceHref ? <a href={licenceHref} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center break-words hover:text-accent-text"><LicenceBadge licence={rights.licence} className="break-words" /></a> : <LicenceBadge licence={rights.licence} className="break-words" />}
        </ProvenanceRow>
        <ProvenanceRow label="Rights"><span className="break-words">{rights.reason}</span></ProvenanceRow>
      </dl>
    </aside>
  );
}

function ProvenanceRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid grid-cols-[5rem_1fr] gap-2"><dt className="font-mono text-xs text-ink-faint">{label}</dt><dd className="min-w-0 text-ink">{children}</dd></div>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

function safeExternalHref(value: string | undefined | null): string | null {
  const cleaned = typeof value === 'string' ? stripInvisible(value).trim() : '';
  return cleaned && safeHttpUrl(cleaned, '') ? cleaned : null;
}
