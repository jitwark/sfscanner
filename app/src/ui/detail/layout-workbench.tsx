'use client';

import type { Entry, SvgPreviewArtifact } from '@hub/contracts';
import { Breadcrumbs } from '../breadcrumbs';
import { LicenceBadge } from '../primitives/badge';
import { GradePill } from '../primitives/pill';
import { RelatedRail } from '../related-rail';
import { ReadinessSignals } from './readiness-signals';
import { Findings } from './findings';
import { Duplicates } from './duplicates';
import { AboutSection } from './about-section';
import { ProvenanceCard } from './provenance-card';
import { CompactVectorDiagram } from './compact-vector-diagram';
import { detailHref } from '../../catalogue/detail-href';

type LayoutWorkbenchProps = {
  entry: Entry;
  preview?: SvgPreviewArtifact | null;
  related?: Entry[];
  staticDownloadHref?: string;
};

export function LayoutWorkbench({ entry, preview = null, related = [], staticDownloadHref }: LayoutWorkbenchProps) {
  const sourceLabel = entry.source.kind === 'n8n_official' ? 'n8n.io' : entry.source.repo ?? 'GitHub';

  return (
    <div data-layout="workbench" className="mx-auto flex w-full min-w-0 flex-col gap-6">
      {/* Studio Header Bar */}
      <div className="flex flex-col gap-3 border-b border-hairline pb-4">
        <Breadcrumbs items={defaultBreadcrumbs(entry)} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 font-mono text-2xs text-ink-muted">
              <span className="rounded-md border border-hairline bg-raised px-2 py-0.5">{sourceLabel}</span>
              <LicenceBadge licence={entry.rights.licence ?? 'Link only'} />
              <GradePill grade={entry.security.grade} />
              <span>ID: {entry.id.slice(0, 8)}</span>
              {entry.rights.reason && <span className="text-ink-faint">({entry.rights.reason})</span>}
            </div>
            <h1 className="break-words font-display text-2xl sm:text-3xl font-semibold tracking-[-0.02em] text-ink my-3 pt-1">
              {entry.title}
            </h1>
            {entry.summary && (
              <p className="max-w-[68ch] text-base leading-7 text-ink-muted">{entry.summary}</p>
            )}
          </div>
        </div>
      </div>

      {/* Dual-Column Grid: Left (About Section - wider) | Right (Provenance Card + Workflow Canvas + Security Findings) */}
      <div className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        {/* Left: About Section */}
        <div id="about" className="rounded-panel border border-hairline bg-panel p-5">
          <AboutSection entry={entry} />
        </div>

        {/* Right: Provenance Card on top, Workflow Canvas directly below, Security Findings below Canvas */}
        <div className="flex min-w-0 flex-col gap-6">
          <div id="provenance">
            <ProvenanceCard entry={entry} staticDownloadHref={staticDownloadHref} showMetrics={true} />
          </div>

          <section id="workflow-canvas" aria-labelledby="canvas-heading" className="rounded-panel border border-hairline bg-panel p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between border-b border-hairline pb-2">
              <h2 id="canvas-heading" className="font-display text-base font-semibold text-ink">
                Workflow canvas
              </h2>
              <span className="font-mono text-2xs text-ink-muted">Vector Preview</span>
            </div>
            <CompactVectorDiagram preview={preview} title={entry.title} />
          </section>

          <div id="security" className="rounded-panel border border-hairline bg-panel p-5">
            <Findings entry={entry} />
          </div>
        </div>
      </div>

      {/* Pre-flight Inspection: Before you run as full width */}
      <div id="before-you-run" className="w-full">
        <ReadinessSignals entry={entry} />
      </div>

      <Duplicates entry={entry} />

      {/* Related Workflows */}
      {related.length > 0 && (
        <section aria-labelledby="related-heading" className="rounded-panel border border-hairline bg-panel p-4 sm:p-5">
          <h2 id="related-heading" className="mb-3 font-display text-base font-semibold text-ink">
            Related workflows
          </h2>
          <RelatedRail entry={entry} related={related} />
        </section>
      )}
    </div>
  );
}

function defaultBreadcrumbs(entry: Entry) {
  const primary = entry.structure.integrations[0] ?? 'Workflows';
  const slug = primary.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return [
    { label: 'Home', href: '/' },
    { label: 'Integrations', href: '/integrations/' },
    { label: primary, href: `/library/?integration=${encodeURIComponent(slug)}` },
    { label: entry.title, href: detailHref(entry) },
  ];
}
