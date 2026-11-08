import type { Entry, SvgPreviewArtifact } from '@hub/contracts';
import { READINESS_UNSCANNED_DISCLAIMER } from '@hub/contracts';
import { Breadcrumbs } from '../breadcrumbs';
import { LicenceBadge } from '../primitives/badge';
import { GradePill } from '../primitives/pill';
import { ProvenanceCard } from './provenance-card';
import { CompactVectorDiagram } from './compact-vector-diagram';
import { FindingsSummary } from './findings-summary';
import { Duplicates } from './duplicates';
import { RelatedLinks, type RelatedLink } from './related-links';
import { AboutSection } from './about-section';
import { detailHref, interactiveHref as buildInteractiveHref } from '../../catalogue/detail-href';
import { sitePath } from '../site-url.mjs';
import { analysisStatusLabel } from '../../scanner/analysis-language';

export type { RelatedLink };

export function DetailLean({
  entry,
  related = [],
  preview = null,
}: {
  entry: Entry;
  related?: readonly RelatedLink[];
  preview?: SvgPreviewArtifact | null;
}) {
  const interactiveHref = sitePath(buildInteractiveHref(entry.id, related.map((item) => item.id)));
  const sourceLabel = entry.source.kind === 'n8n_official' ? 'n8n.io' : entry.source.repo ?? 'GitHub';
  const analysisLabel = analysisStatusLabel(entry.security.analysisStatus);

  return (
    <article data-layout="workbench" className="mx-auto flex w-full min-w-0 flex-col gap-6 pb-8">
      <div className="flex flex-col gap-3 border-b border-hairline pb-4">
        <Breadcrumbs items={defaultBreadcrumbs(entry)} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 font-mono text-2xs text-ink-muted">
              <span className="rounded-md border border-hairline bg-raised px-2 py-0.5">{sourceLabel}</span>
              <LicenceBadge licence={entry.rights.licence ?? 'Link only'} />
              <GradePill grade={entry.security.grade} />
              {analysisLabel ? <span className="rounded-md border border-hairline bg-raised px-2 py-0.5">{analysisLabel}</span> : null}
              <span>ID: {entry.id.slice(0, 8)}</span>
              {entry.rights.reason && <span className="text-ink-faint">({entry.rights.reason})</span>}
            </div>
            <h1 className="my-3 pt-1 break-words font-display text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-3xl">
              {entry.title}
            </h1>
            {entry.summary && (
              <p className="max-w-[68ch] text-base leading-7 text-ink-muted">{entry.summary}</p>
            )}
          </div>
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div id="about" className="rounded-panel border border-hairline bg-panel p-5">
          <AboutSection entry={entry} />
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <div id="provenance">
            <ProvenanceCard entry={entry} showMetrics={true} />
          </div>

          <section id="workflow-canvas" aria-labelledby="canvas-heading" className="rounded-panel border border-hairline bg-panel p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between border-b border-hairline pb-2">
              <h2 id="canvas-heading" className="font-display text-base font-semibold text-ink">
                Workflow canvas
              </h2>
              <span className="font-mono text-2xs text-ink-muted">Vector Preview</span>
            </div>
            <CompactVectorDiagram
              preview={preview}
              title={entry.title}
              showNodeList={false}
              // Nothing on this page hydrates, so a dialog whose state lives in
              // React could never open. The toolbar controls the static script
              // does own — zoom, reset, SVG download — stay.
              expandable={false}
            />
            {/*
              This region's handoff to the interactive view. `#before-you-run`
              tells the reader the pre-run checks live there and
              `FindingsSummary` sends them there for the rest of the report, so
              the canvas cannot dead-end behind its own pan/zoom toolbar.

              The copy no longer sells "pan, zoom" as what the click adds — the
              static script delivers those here now. It names the explorable
              chart, the readiness detail, and the findings the summary
              truncates, which is what the interactive view actually has.

              A redesign once deleted this anchor and broke the detail journeys
              in `app/e2e/` that locate it, so the anchor text stays exactly the
              accessible name they use; the sentence sits outside it.
            */}
            <p className="mt-3 text-sm text-ink-muted">
              <a href={interactiveHref} className="font-medium text-accent-text underline">Open the interactive view</a>
              {' '}for the interactive canvas, the pre-run checks, and every finding in full.
            </p>
          </section>

          <FindingsSummary entry={entry} interactiveHref={interactiveHref} />
        </div>
      </div>

      <div className="w-full">
        <LeanReadinessNotice entry={entry} />
      </div>

      <Duplicates entry={entry} />

      {related.length > 0 && (
        <RelatedLinks links={related} />
      )}
    </article>
  );
}

/**
 * Neither branch of this notice is a live region, because neither is ever
 * dynamic: this is the lean page, rendered once by `renderToStaticMarkup` into
 * one file with no React on it, so both sentences are present before load
 * completes and neither ever changes afterwards.
 *
 * `status` announces *changes* to a region — MDN's `status` role is "a live
 * region containing advisory information ... meant to inform users of dynamic
 * updates that have occurred in other areas of the current web page", and live
 * regions are announced only on update — so on static copy it promised an
 * announcement that can never happen.
 *
 * `alert` is the same claim at assertive priority, and MDN's `alert` role is
 * explicit that it "is for content that is dynamically displayed, not for
 * content that appears on page load ... if a page loads with multiple visible
 * alerts scattered throughout, the alert role should not be used, as the
 * messages were not dynamically triggered"; the WAI-ARIA APG alert pattern
 * agrees that "screen readers do not inform users of alerts that are present on
 * the page before page load completes". The counter-evidence is MDN's live
 * region guide, which notes assistive technologies give `alert` special
 * handling and often announce it even when it is in the initial markup — an
 * inconsistent, interrupting announcement of information that is important but
 * not time-sensitive, which is worse than the plain text every reader gets in
 * reading order.
 *
 * The same two sentences keep `role="alert"` in `readiness-signals.tsx`, which
 * renders on surfaces React does build after load, where the announcement is
 * real. Here the visible copy and its reading order are unchanged.
 *
 * The section is also the owner of `#before-you-run`. It used to be emitted
 * twice — once on this section and once on the layout wrapper above it — and a
 * duplicated id is resolved by the browser over the whole document, so the
 * anchor and the `aria-labelledby` target pointed at whichever copy came first.
 * The id belongs here: this is the labelled landmark and the anchor already
 * carries the scroll margin that keeps the sticky header off it.
 */
function LeanReadinessNotice({ entry }: { entry: Entry }) {
  const partial = entry.structure.partial === true;
  const isUnscanned = entry.readiness?.analysis === 'unscanned';
  const incomplete = partial || !entry.readiness || isUnscanned;
  return (
    <section id="before-you-run" aria-labelledby="before-you-run-heading" className="scroll-mt-24 space-y-3 rounded-panel border border-hairline bg-panel p-4 sm:p-6">
      <h2 id="before-you-run-heading" className="font-display text-xl font-semibold text-ink">Before you run</h2>
      {incomplete ? (
        <div className="rounded-control border border-sev-medium bg-sev-medium/10 px-3 py-2 text-sm leading-6 text-sev-medium">
          {isUnscanned
            ? `${READINESS_UNSCANNED_DISCLAIMER}${partial ? ' This metadata-only entry also has only partial structure data.' : ''}`
            : partial
              ? 'Workflow body is unavailable. This metadata-only entry has only partial structure data; do not treat it as ready to run. Review the upstream workflow before importing.'
              : 'No pre-run readiness report is published for this entry. It is not ready to run based on the published data; review the upstream workflow before importing.'}
        </div>
      ) : (
        <p className="rounded-control border border-hairline bg-raised p-3 text-sm leading-6 text-ink-muted">
          Detailed deterministic pre-run checks are available in the interactive view. Review them before importing.
        </p>
      )}
    </section>
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
