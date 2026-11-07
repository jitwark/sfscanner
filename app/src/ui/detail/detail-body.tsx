'use client';

import { useEffect, useState } from 'react';
import type { Entry, SvgPreviewArtifact } from '@hub/contracts';
import { RelatedRail } from '../related-rail';
import { DetailHeader } from './header';
import { MetricStrip } from './metric-strip';
import { Findings } from './findings';
import { Provenance } from './provenance';
import { Duplicates } from './duplicates';
import { ChartLoader } from './chart-loader';
import { ReadinessSignals } from './readiness-signals';
import { DescriptionProvenance, isDescriptionContentPublishable } from './description-provenance';
import { DescriptionSections } from './description-sections';
import { SectionRail, type DetailSection } from './section-rail';
import { LayoutWorkbench } from './layout-workbench';

export type WorkflowLayoutMode = 'workbench' | 'default';

type DetailBodyProps = {
  entry: Entry;
  preview?: SvgPreviewArtifact | null;
  loadPreview?: boolean;
  related?: Entry[];
  staticDownloadHref?: string;
  initialLayout?: WorkflowLayoutMode;
};

export function DetailBody({
  entry,
  preview = null,
  loadPreview = false,
  related = [],
  staticDownloadHref,
  initialLayout = 'default',
}: DetailBodyProps) {
  const [layout, setLayout] = useState<WorkflowLayoutMode>(initialLayout);
  useEffect(() => {
    // Apply URL-selected layouts after the static initial tree hydrates.
    // React's hydration contract: https://react.dev/reference/react-dom/client/hydrateRoot
    const applyLayoutFromUrl = () => {
      const mode = new URLSearchParams(window.location.search).get('layout');
      setLayout(mode === 'workbench' || mode === 'default' ? mode : initialLayout);
    };
    applyLayoutFromUrl();
    window.addEventListener('popstate', applyLayoutFromUrl);
    return () => window.removeEventListener('popstate', applyLayoutFromUrl);
  }, [initialLayout]);

  if (layout === 'workbench') {
    return (
      <article className="mx-auto flex w-full min-w-0 flex-col gap-6 pb-8">
        <LayoutWorkbench
          entry={entry}
          preview={preview}
          related={related}
          staticDownloadHref={staticDownloadHref}
        />
      </article>
    );
  }

  const publishStructuredDescription = Boolean(entry.descriptionContent) && isDescriptionContentPublishable(entry);
  const publishPlainDescription = entry.descriptionSource === 'upstream';
  const sections: DetailSection[] = [
    { id: 'before-you-run', label: 'Before you run' },
    { id: 'workflow-canvas', label: 'Canvas' },
    { id: 'security', label: 'Security', count: entry.security.findings.length },
    { id: 'about', label: 'About' },
    { id: 'provenance', label: 'Provenance' },
  ];

  return (
    <article className="mx-auto flex w-full min-w-0 flex-col gap-6 pb-8">
      <DetailHeader entry={entry} />
      <MetricStrip entry={entry} />
      <div className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[9rem_minmax(0,1fr)] lg:gap-8">
        <SectionRail sections={sections} />
        <div className="grid min-w-0 grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
          <div id="before-you-run" className="min-w-0 scroll-mt-24 lg:col-span-2">
            <ReadinessSignals entry={entry} />
          </div>
          <section
            id="workflow-canvas"
            aria-labelledby="chart-heading"
            className="min-w-0 scroll-mt-24 space-y-3 rounded-panel border border-hairline bg-panel p-4 sm:p-6 lg:col-span-2"
          >
            <h2 id="chart-heading" className="font-display text-2xl font-semibold text-ink">
              Workflow canvas
            </h2>
            <ChartLoader entry={entry} preview={preview} loadPreview={loadPreview} />
          </section>
          <div id="security" className="scroll-mt-24 rounded-panel border border-hairline bg-panel p-4 sm:p-6 lg:col-span-2">
            <Findings entry={entry} />
          </div>
          <section
            id="about"
            aria-labelledby="description-heading"
            className="min-w-0 scroll-mt-24 rounded-panel border border-hairline bg-panel p-4 sm:p-6 lg:col-span-2"
          >
            <div className="max-w-[68ch] space-y-3">
              <h2 id="description-heading" className="font-display text-2xl font-semibold text-ink">
                About this workflow
              </h2>
              <DescriptionProvenance
                descriptionSource={entry.descriptionSource}
                descriptionProvenance={entry.descriptionProvenance}
              />
              {publishStructuredDescription && entry.descriptionContent ? (
                <DescriptionSections content={entry.descriptionContent} />
              ) : publishPlainDescription ? (
                <div className="whitespace-pre-line text-pretty text-base leading-7 text-ink-muted">
                  {entry.description}
                </div>
              ) : (
                <p role="status" className="rounded-control border border-hairline bg-raised p-4 text-sm leading-6 text-ink-muted">
                  A publishable description is not available for this workflow. Unverified or fallback prose is not displayed.
                </p>
              )}
            </div>
          </section>
          <div id="provenance" className="scroll-mt-24 lg:col-span-2">
            <Provenance entry={entry} />
          </div>
          <Duplicates entry={entry} />
          <div className="min-w-0">
            <RelatedRail entry={entry} related={related} />
          </div>
        </div>
      </div>
    </article>
  );
}
