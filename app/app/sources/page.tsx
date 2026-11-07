import type { Metadata } from 'next';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SourceDef } from '@hub/contracts';
import { Breadcrumbs } from '@/src/ui/breadcrumbs';
import { Panel } from '@/src/ui/primitives/panel';
import { LicenceBadge } from '@/src/ui/primitives/badge';
import { JsonLdScript, pageJsonLd } from '../../src/seo/json-ld';
import { canonicalAlternates } from '../../src/seo/page-meta';
import { isPreviewBuild } from '../../src/seo/robots';

type StatsData = {
  redistributableCount: number;
  linkOnlyCount: number;
  totalEntries: number;
};

const sourcesData = JSON.parse(
  readFileSync(path.resolve(process.cwd(), '../pipeline/sources.json'), 'utf8'),
) as SourceDef[];
const statsData = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'public/data/stats.json'), 'utf8'),
) as StatsData;

export const metadata: Metadata = {
  ...(isPreviewBuild() ? {} : { alternates: canonicalAlternates('/sources/') }),
  title: 'Sources · n8n-secureflow',
  description: 'Registry of open GitHub repositories and official sources indexed by n8n-secureflow.',
};

export default function SourcesPage() {
  const breadcrumbItems = [
    { label: 'Home', href: '/' },
    { label: 'Sources', href: '/sources/' },
  ];

  return (
    <div className="space-y-8">
      <JsonLdScript data={pageJsonLd({ name: 'Sources', path: '/sources/', description: 'Every repository and library indexed by n8n-secureflow, with its licence and redistribution status.', collection: true, })} />
      <Breadcrumbs items={breadcrumbItems} />

      <header className="space-y-3">
        <h1 className="text-3xl font-display font-semibold text-ink">Registered Sources</h1>
        <p className="text-lg text-ink-muted leading-relaxed max-w-3xl">
          The hub indexes workflows from hand-reviewed open GitHub repositories and official template APIs. Each source is evaluated for licence compatibility and redistribution rights.
        </p>
        <p className="text-sm text-ink-muted leading-relaxed max-w-3xl">
          This page counts sources <em>registered</em> for acquisition. Not every registered source
          contributes entries to the current corpus, so the homepage&rsquo;s source figure — which
          counts origins actually present in the catalogue — can be lower.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Panel className="space-y-1">
          <span className="text-xs font-mono text-ink-muted uppercase tracking-wider">Registered Sources</span>
          <p className="text-2xl font-mono font-semibold text-ink">{sourcesData.length}</p>
        </Panel>

        <Panel className="space-y-1">
          <span className="text-xs font-mono text-ink-muted uppercase tracking-wider">Redistributable Entries</span>
          <p className="text-2xl font-mono font-semibold text-accent-text">
            {(statsData.redistributableCount || 0).toLocaleString('en-US')}
          </p>
        </Panel>

        <Panel className="space-y-1">
          <span className="text-xs font-mono text-ink-muted uppercase tracking-wider">Link-Only Entries</span>
          <p className="text-2xl font-mono font-semibold text-ink-muted">
            {(statsData.linkOnlyCount || 0).toLocaleString('en-US')}
          </p>
        </Panel>
      </div>

      <div className="overflow-x-auto border border-hairline rounded-panel bg-panel">
        <table className="w-full text-left border-collapse text-sm">
          <thead>
            <tr className="border-b border-hairline bg-raised/50 text-xs font-mono text-ink-muted uppercase">
              <th className="py-3 px-4">Source / Repo</th>
              <th className="py-3 px-4">Kind</th>
              <th className="py-3 px-4">Licence</th>
              <th className="py-3 px-4">Status</th>
              <th className="py-3 px-4">Reviewed</th>
              <th className="py-3 px-4">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {sourcesData.map((src) => {
              const repoName = src.repo || src.key;
              const repoUrl = src.repo ? `https://github.com/${src.repo}` : 'https://n8n.io/workflows';

              return (
                <tr key={src.key} className="hover:bg-raised/30 transition-colors">
                  <td className="py-3 px-4 font-mono font-medium text-ink">
                    <a
                      href={repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      // A link that IS the cell content, not one inside a
                      // sentence, so the WCAG 2.5.8 inline exemption does not
                      // apply and it needs the 24px floor of its own.
                      className="inline-flex min-h-6 items-center transition-colors hover:text-accent-text"
                    >
                      {repoName}
                    </a>
                  </td>
                  <td className="py-3 px-4 font-mono text-xs text-ink-muted">{src.kind}</td>
                  <td className="py-3 px-4">
                    <LicenceBadge licence={src.expectedLicence} />
                  </td>
                  <td className="py-3 px-4 font-mono text-xs">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-sev-low/10 text-sev-low border border-sev-low/20">
                      {src.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 font-mono text-xs text-ink-muted">{src.reviewedAt}</td>
                  <td className="py-3 px-4 text-xs text-ink-muted max-w-xs truncate" title={src.note}>
                    {src.note}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
