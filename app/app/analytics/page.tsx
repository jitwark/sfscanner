import type { Metadata } from 'next';
import { readAnalyticsSync, readReleaseSnapshotSync } from '../../src/catalogue/analytics-node';
import { BarList, type BarRow } from '../../src/ui/analytics/bar-list';
import { FindingsSummary } from '../../src/ui/analytics/findings-summary';
import { Histogram } from '../../src/ui/analytics/histogram';
import { PolicyTable } from '../../src/ui/analytics/policy-table';
import { RiskMatrix } from '../../src/ui/analytics/risk-matrix';
import { StatTile } from '../../src/ui/analytics/stat-tile';
import { CompositionSections, SectionHeading } from '../../src/ui/analytics/composition-sections';
import { NodeCoveragePanel } from '../../src/ui/analytics/node-coverage';
import { ScanCoveragePanel } from '../../src/ui/analytics/scan-coverage';
import { corpusCoverageLabel } from '../../src/scanner/analysis-language';
import { GRADE_LABEL, GRADE_ORDER, GRADE_TOKEN, COMPLEXITY_LABEL } from '../../src/ui/analytics/severity';
import { JsonLdScript, pageJsonLd } from '../../src/seo/json-ld';
import { canonicalAlternates } from '../../src/seo/page-meta';
import { isPreviewBuild } from '../../src/seo/robots';

export const metadata: Metadata = {
  title: 'Corpus analytics | n8n-secureflow',
  description:
    'What the v2 scanner finds across the n8n workflow catalogue: scan coverage, modelled node types, triggers, complexity and provenance.',
  ...(isPreviewBuild() ? {} : { alternates: canonicalAlternates('/analytics/') }),
};

export default function AnalyticsPage() {
  const analytics = readAnalyticsSync();
  const release = readReleaseSnapshotSync();
  const { total, searchable, rights, grades, triggers, complexity, capabilities } = analytics;
  const { findings, scanCoverage, v2Evidence, nodeCoverage } = analytics;
  const share = (value: number) => (total > 0 ? (value / total) * 100 : 0);

  const gradeRows: BarRow[] = GRADE_ORDER.map((grade) => ({
    label: GRADE_LABEL[grade],
    count: grades[grade] ?? 0,
    color: GRADE_TOKEN[grade],
  }));

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-10 pb-10">
      <JsonLdScript
        data={pageJsonLd({
          name: 'Corpus analytics',
          path: '/analytics/',
          description: 'Measured composition of the n8n workflow catalogue.',
        })}
      />

      <header className="max-w-3xl border-b border-hairline pb-6">
        <p className="font-mono text-2xs uppercase tracking-[0.16em] text-ink-faint">Corpus analytics</p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink md:text-4xl">
          What is actually in the catalogue
        </h1>
        <p className="mt-3 text-base leading-7 text-ink-muted">
          Every figure below is derived from the packaged corpus in a single pass at build time —
          not sampled, not estimated, not carried over from a previous release. A security result
          counts only when an admitted v2 receipt matches the full engine, profile, ruleset and
          semantics identity against the exact body digest; anything else is reported as unknown
          rather than carried forward. Scan coverage describes body and analysis evidence. Nothing
          here is a safety guarantee, and node coverage is catalogue coverage, not security accuracy.
        </p>
      </header>

      {/* Tier 1: Executive KPI Summary */}
      <section aria-label="Catalogue totals" className="grid grid-cols-1 min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Workflows" value={total} detail="Canonical entries after de-duplication." emphasis />
        <StatTile
          label="Searchable"
          value={searchable}
          share={share(searchable)}
          detail={`${share(searchable).toFixed(1)}% of the catalogue is in the search index today.`}
        />
        <StatTile
          label="AI-Powered"
          value={capabilities.hasAI}
          share={share(capabilities.hasAI)}
          detail={`${share(capabilities.hasAI).toFixed(1)}% of workflows use AI agents, LLMs, or LangChain nodes.`}
        />
        <StatTile
          label="Current v2 results"
          value={scanCoverage.scanned}
          share={share(scanCoverage.scanned)}
          detail={`${v2Evidence.inventory.available.toLocaleString('en-US')} inputs were attempted under the admitted v2 identity: ${scanCoverage.scanned.toLocaleString('en-US')} produced an authentic native result (${scanCoverage.completed.toLocaleString('en-US')} ${corpusCoverageLabel('completed').toLowerCase()}, ${scanCoverage.degraded.toLocaleString('en-US')} ${corpusCoverageLabel('degraded').toLowerCase()}, ${scanCoverage.indeterminate.toLocaleString('en-US')} ${corpusCoverageLabel('indeterminate').toLowerCase()}). ${scanCoverage.noResult.toLocaleString('en-US')} ${scanCoverage.noResult === 1 ? 'was' : 'were'} refused without a result and publish no grade; ${scanCoverage.noBody.toLocaleString('en-US')} have no input; ${scanCoverage.sourceUnavailable.toLocaleString('en-US')} are owner-ruled source-unavailable and ${scanCoverage.historical.toLocaleString('en-US')} carry only a retired-engine verdict.`}
        />
      </section>

      {/* Tier 1b: Provenance & Attribution Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-hairline bg-raised/40 px-4 py-3 text-xs text-ink-muted">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent shrink-0" aria-hidden="true" />
          <span>
            <strong className="text-ink">Ethical Link-Only Posture:</strong> {rights.linkOnly.toLocaleString('en-US')} entries are published link-only: the body is never redistributed, and this site serves metadata plus a reference to where the workflow came from. ({rights.redistributable} redistributable bodies).
          </span>
        </div>
        <span className="font-mono text-2xs uppercase tracking-wider text-ink-faint">Attribution Guaranteed</span>
      </div>

      {/* Tier 2: Ecosystem Shape & Automation Architecture */}
      <section aria-labelledby="shape-heading" className="flex flex-col gap-4">
        <SectionHeading id="shape-heading" title="Shape of the corpus" />
        <div className="grid grid-cols-1 min-w-0 gap-4 lg:grid-cols-2">
          <Histogram
            title="How big workflows get"
            description="Working nodes per workflow. Sticky notes and placeholders are excluded, so this is the number you would actually maintain."
            bins={analytics.nodeCountBins}
            median={analytics.nodeCountMedian}
          />
          <BarList
            title="How workflows start"
            description="The trigger node that begins each workflow."
            total={total}
            rows={triggers.map((row) => ({ label: row.label, count: row.count }))}
          />
          <BarList
            title="Complexity"
            description="Banded by node count and branching."
            total={total}
            sort={false}
            rows={(['simple', 'medium', 'complex'] as const).map((band) => ({
              label: COMPLEXITY_LABEL[band],
              count: complexity[band],
            }))}
          />
          <BarList
            title="Capabilities"
            description="Workflows containing each capability. These overlap — one workflow can have all three."
            total={total}
            rows={[
              { label: 'Runs code', count: capabilities.hasCode },
              { label: 'Uses AI', count: capabilities.hasAI },
              { label: 'Exposes a webhook', count: capabilities.hasWebhook },
            ]}
          />
        </div>
      </section>

      {/* Tier 3: Security Posture & Vulnerabilities */}
      <section aria-labelledby="security-heading" className="flex flex-col gap-4">
        <SectionHeading
          id="security-heading"
          title="Security"
          aside={`${findings.totalOccurrences.toLocaleString('en-US')} findings · ${findings.policies.length} rules firing`}
        />
        <PolicyTable policies={findings.policies} denominator={total} />
        <div className="grid grid-cols-1 min-w-0 gap-4 lg:grid-cols-2">
          <FindingsSummary findings={findings} total={total} completed={scanCoverage.completed} />
          <RiskMatrix cells={analytics.gradeByComplexity.cells} max={analytics.gradeByComplexity.max} />
        </div>
        <BarList
          title="Security grade"
          description="The worst finding in each workflow. Ordered by severity, not by size — Unknown means not gradeable, not safe."
          sort={false}
          total={total}
          rows={gradeRows}
        />
      </section>

      {/* Tier 4: Node Semantics Coverage */}
      <NodeCoveragePanel
        nodeCoverage={nodeCoverage}
        readableInputs={v2Evidence.inventory.available}
        refused={v2Evidence.states.noResult}
      />

      {/* Tier 5: Scan Evidence & Cryptographic Verification */}
      <ScanCoveragePanel coverage={scanCoverage} evidence={v2Evidence} release={release} />

      <CompositionSections analytics={analytics} />
    </div>
  );
}
