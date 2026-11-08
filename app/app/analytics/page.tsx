import type { Metadata } from 'next';
import { readAnalyticsSync, readReleaseSnapshotSync } from '../../src/catalogue/analytics-node';
import { BarList, type BarRow } from '../../src/ui/analytics/bar-list';
import { FindingsSummary } from '../../src/ui/analytics/findings-summary';
import { Histogram } from '../../src/ui/analytics/histogram';
import { PolicyTable } from '../../src/ui/analytics/policy-table';
import { RiskMatrix } from '../../src/ui/analytics/risk-matrix';
import { StatTile } from '../../src/ui/analytics/stat-tile';
import { CompositionSections, SectionHeading } from '../../src/ui/analytics/composition-sections';
import { GRADE_LABEL, GRADE_ORDER, GRADE_TOKEN, COMPLEXITY_LABEL } from '../../src/ui/analytics/severity';
import { JsonLdScript, pageJsonLd } from '../../src/seo/json-ld';
import { canonicalAlternates } from '../../src/seo/page-meta';
import { isPreviewBuild } from '../../src/seo/robots';

export const metadata: Metadata = {
  title: 'Corpus analytics | n8n-secureflow',
  description: 'Measured composition of the n8n workflow catalogue: grades, triggers, capabilities and provenance.',
  ...(isPreviewBuild() ? {} : { alternates: canonicalAlternates('/analytics/') }),
};

const SNAPSHOT_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export default function AnalyticsPage() {
  const analytics = readAnalyticsSync();
  const release = readReleaseSnapshotSync();
  const { total, searchable, rights, grades, triggers, complexity, capabilities } = analytics;
  const { findings, scanCoverage } = analytics;
  const share = (value: number) => (total > 0 ? (value / total) * 100 : 0);

  const gradeRows: BarRow[] = GRADE_ORDER.map((grade) => ({
    label: GRADE_LABEL[grade],
    count: grades[grade] ?? 0,
    color: GRADE_TOKEN[grade],
  }));

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 pb-10">
      <JsonLdScript
        data={pageJsonLd({
          name: 'Corpus analytics',
          path: '/analytics/',
          description: 'Measured composition of the n8n workflow catalogue.',
        })}
      />

      <header className="border-b border-hairline pb-5">
        <p className="font-mono text-2xs uppercase tracking-[0.16em] text-ink-faint">Corpus analytics</p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink md:text-4xl">
          What is actually in the catalogue
        </h1>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-2xs text-ink-faint">
          <span>{total.toLocaleString('en-US')} workflows</span>
          <span>
            snapshot <time dateTime={release.generatedAt}>{SNAPSHOT_DATE.format(new Date(release.generatedAt))}</time>
          </span>
        </div>
      </header>

      <section aria-label="Catalogue totals" className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Workflows" value={total} emphasis />
        <StatTile
          label="Searchable"
          value={searchable}
          share={share(searchable)}
          detail={`${share(searchable).toFixed(1)}% of catalogue`}
        />
        <StatTile
          label="AI-powered"
          value={capabilities.hasAI}
          share={share(capabilities.hasAI)}
          detail={`${share(capabilities.hasAI).toFixed(1)}% of catalogue`}
        />
        <StatTile
          label="With findings"
          value={findings.workflowsWithFindings}
          share={share(findings.workflowsWithFindings)}
          detail={`${share(findings.workflowsWithFindings).toFixed(1)}% of catalogue`}
        />
      </section>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-panel border border-hairline bg-raised/40 px-4 py-2.5 font-mono text-2xs text-ink-faint">
        <span className="text-ink-muted">{rights.linkOnly.toLocaleString('en-US')} link-only</span>
        <span className="text-ink-muted">{rights.redistributable.toLocaleString('en-US')} redistributable</span>
        <span>No workflow bodies redistributed</span>
      </div>

      <section aria-labelledby="shape-heading" className="flex flex-col gap-4">
        <SectionHeading id="shape-heading" title="Shape" aside={`${total.toLocaleString('en-US')} workflows`} />
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
          <Histogram
            title="Workflow size"
            bins={analytics.nodeCountBins}
            median={analytics.nodeCountMedian}
          />
          <BarList
            title="Triggers"
            total={total}
            rows={triggers.map((row) => ({ label: row.label, count: row.count }))}
          />
          <BarList
            title="Complexity"
            total={total}
            sort={false}
            rows={(['simple', 'medium', 'complex'] as const).map((band) => ({
              label: COMPLEXITY_LABEL[band],
              count: complexity[band],
            }))}
          />
          <BarList
            title="Capabilities"
            total={total}
            rows={[
              { label: 'Code', count: capabilities.hasCode },
              { label: 'AI', count: capabilities.hasAI },
              { label: 'Webhook', count: capabilities.hasWebhook },
            ]}
          />
        </div>
      </section>

      <section aria-labelledby="security-heading" className="flex flex-col gap-4">
        <SectionHeading
          id="security-heading"
          title="Security"
          aside={`${findings.totalOccurrences.toLocaleString('en-US')} findings · ${findings.policies.length.toLocaleString('en-US')} rules`}
        />
        <PolicyTable policies={findings.policies} denominator={total} />
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
          <FindingsSummary findings={findings} total={total} completed={scanCoverage.completed} />
          <RiskMatrix cells={analytics.gradeByComplexity.cells} max={analytics.gradeByComplexity.max} />
        </div>
        <BarList title="Security grades" sort={false} total={total} rows={gradeRows} />
      </section>

      <CompositionSections analytics={analytics} />
    </div>
  );
}
