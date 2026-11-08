import type { ScanWorkflowResult } from '../engine';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { scanAnalysisPresentation } from '../analysis-language';
import { GradePill, isReportIncomplete } from './report-blocks';
import { remediationActions } from './report-safe-content';
import { CornerSquare } from '../../ui/primitives/corner-square';

function v2Model(scan: ScanWorkflowResult): ScannerReportModelV2 | undefined {
  const candidate = scan as unknown as Partial<ScannerReportModelV2>;
  return candidate.v2?.schemaVersion === 'scanner-result-v2' ? candidate as ScannerReportModelV2 : undefined;
}

function countLabel(value: number, singular: string): string {
  return `${value} ${value === 1 ? singular : `${singular}s`}`;
}
type ReportDecisionProps = { scan: ScanWorkflowResult };

/** Keeps the first decision and action visible before the detailed report sections. */
export function ReportDecision({ scan }: ReportDecisionProps) {
  const model = v2Model(scan);
  const presentation = scanAnalysisPresentation(scan);
  const assessment = model?.assessment ?? scan.riskAssessment;
  const gradeAvailable = presentation.assessmentAvailable && !isReportIncomplete(scan);
  const incomplete = !gradeAvailable;
  const showLimits = Boolean(model && model.v2.limits.usage.length > 0
    && (presentation.label === 'Partial analysis' || !presentation.assessmentAvailable));
  const firstAction = remediationActions(scan)[0];

  return (
    <section aria-labelledby="scanner-decision-heading" className="relative rounded-panel border border-accent-border/40 bg-accent-dim p-4 sm:p-5">
      <CornerSquare position="top-left" size="sm" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between pl-2">
        <div>
          <h2 id="scanner-decision-heading" className="font-sans text-lg font-bold text-ink">Decision and next step</h2>
          <p className="mt-1 text-sm leading-6 text-ink-muted">
            {incomplete
              ? presentation.message
              : `${presentation.label}. This is an advisory decision from the local scanner, not proof of safe execution.${presentation.label === 'Analysis complete' ? '' : ` ${presentation.summary}`}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {incomplete ? <span className="rounded-control border border-sev-high bg-raised px-2.5 py-1 font-mono text-2xs font-semibold text-sev-high">No grade</span> : <GradePill grade={assessment!.grade} />}
          {model && !incomplete ? <span aria-label={`Risk score: ${assessment!.score} out of 100`} className="rounded-control border border-hairline bg-raised px-2.5 py-1 font-mono text-2xs font-semibold text-ink-muted">{assessment!.score}/100</span> : null}
        </div>
      </div>
      {model && !incomplete ? <p className="mt-4 border-t border-accent-border/25 pt-3 text-sm leading-6 text-ink-muted">
        Assessment basis: {countLabel(model.assessment!.basisFindingIds.length, 'scoring finding')}; {countLabel(model.assessment!.excludedReportOnlyFindingIds.length, 'report-only evidence item')} excluded from scoring; {countLabel(model.assessment!.excludedNotApplicableFindingIds.length, 'not-applicable finding')} excluded; {countLabel(model.assessment!.excludedUncertainFindingIds.length, 'uncertain finding')} excluded.
      </p> : null}
      {showLimits && model ? <div className="mt-4 border-t border-accent-border/25 pt-3">
        <p className="text-sm font-semibold text-ink">{presentation.assessmentAvailable ? 'Analysis limits are recorded.' : 'Coverage is insufficient for a risk decision.'}</p>
        <ul aria-label="Decision coverage limits" className="mt-2 space-y-1 text-sm text-ink-muted">
          {model.v2.limits.usage.map((limit) => <li key={limit.id}>
            <span className="font-mono text-ink">{limit.id}</span>: {limit.examined}/{limit.maximum} examined · {limit.omitted} omitted{limit.exhausted ? ' · limit exhausted' : ''}
          </li>)}
        </ul>
      </div> : null}
      {firstAction && (!model || gradeAvailable) ? <p className="mt-4 border-t border-accent-border/25 pt-3 text-sm leading-6 text-ink"><span className="font-semibold">Recommended next step:</span> {firstAction}</p> : null}
      <a href="#scanner-findings-heading" className="mt-3 inline-flex min-h-11 items-center rounded-control px-2 text-sm font-semibold text-accent-text underline underline-offset-2 hover:text-ink focus-visible:outline focus-visible:ring-2 focus-visible:ring-accent-border">Review findings</a>
    </section>
  );
}
