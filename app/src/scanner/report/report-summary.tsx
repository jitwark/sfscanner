import type { RefObject } from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, RotateCcw } from 'lucide-react';
import type { ScanWorkflowResult } from '../engine';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { GradePill, isReportIncomplete, Metric, TextBlock } from './report-blocks';
import { CornerSquare } from '../../ui/primitives/corner-square';

type ReportSummaryProps = {
  scan: ScanWorkflowResult;
  outcomeHeadingRef?: RefObject<HTMLHeadingElement | null>;
  onRetry?: () => void;
};
function v2Model(scan: ScanWorkflowResult): ScannerReportModelV2 | undefined {
  const candidate = scan as unknown as Partial<ScannerReportModelV2>;
  return candidate.v2?.schemaVersion === 'scanner-result-v2' ? candidate as ScannerReportModelV2 : undefined;
}
function CoverageDetails({ model }: { model: ScannerReportModelV2 }) {
  const { analysis, limits } = model.v2;
  const message = model.assessment === null
    ? 'Assessment unavailable because coverage is insufficient.'
    : analysis.status === 'DEGRADED'
      ? 'Some evidence may be omitted; review the limits before relying on this report.'
      : 'Coverage details for the risk assessment.';

  return (
    <div className="mt-5 border-t border-hairline pt-4">
      <h3 className="font-display text-base font-semibold text-ink">Analysis coverage</h3>
      <p className="mt-1 text-sm leading-6 text-ink-muted">{message}</p>
      <ul aria-label="Analysis capability coverage" className="mt-3 space-y-2">
        {analysis.capabilities.map((capability) => (
          <li key={capability.id} className="flex flex-col gap-1 rounded-control border border-hairline bg-raised/40 p-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <span className="font-mono font-semibold text-ink">{capability.id}</span>
            <span className="text-ink-muted">
              {capability.status} · {capability.analyzed}/{capability.seen} analyzed · {capability.skipped} skipped · {capability.omitted} omitted
            </span>
          </li>
        ))}
      </ul>
      {limits.usage.length > 0 ? <ul aria-label="Analysis limit usage" className="mt-2 space-y-2">
        {limits.usage.map((limit) => (
          <li key={limit.id} className="rounded-control border border-hairline bg-raised/40 p-3 text-sm text-ink-muted">
            <span className="font-mono font-semibold text-ink">{limit.id}</span>: {limit.examined}/{limit.maximum} examined · {limit.omitted} omitted{limit.exhausted ? ' · limit exhausted' : ''}
          </li>
        ))}
      </ul> : null}
      {analysis.diagnostics.length > 0 ? <ul aria-label="Analysis diagnostics" className="mt-2 flex flex-wrap gap-2">
        {analysis.diagnostics.map((diagnostic) => (
          <li key={diagnostic.id} className="rounded-full border border-sev-medium bg-raised px-2.5 py-1 font-mono text-2xs text-sev-medium">
            Notice: {diagnostic.code} · {diagnostic.aggregateEffect}
          </li>
        ))}
      </ul> : null}
    </div>
  );
}


export function ReportSummary({ scan, outcomeHeadingRef, onRetry }: ReportSummaryProps) {
  const model = v2Model(scan);
  const status: ScanWorkflowResult['analysisStatus'] = model?.v2.analysis.status ?? scan.analysisStatus;
  const assessment = model?.assessment ?? scan.riskAssessment;
  const assessmentMissing = model ? model.assessment === null : false;
  const incomplete = isReportIncomplete(scan) || status === 'INDETERMINATE' || assessmentMissing;
  const statusLabel = model && status === 'INDETERMINATE'
    ? 'Analysis indeterminate'
    : model && assessmentMissing
      ? 'Assessment unavailable'
      : incomplete && status !== 'INDETERMINATE'
        ? 'Analysis incomplete'
        : status === 'DEGRADED'
          ? 'Analysis degraded'
          : status === 'INDETERMINATE'
            ? 'Analysis indeterminate'
            : 'Analysis complete';
  const statusClass = incomplete
    ? 'bg-raised text-sev-high border-sev-high'
    : status === 'DEGRADED'
      ? 'bg-raised text-sev-medium border-sev-medium'
      : 'bg-raised text-sev-low border-sev-low';
  const StatusIcon = incomplete
    ? CircleHelp
    : status === 'DEGRADED'
      ? AlertTriangle
      : CheckCircle2;

  return (
    <section className="relative rounded-panel border border-hairline bg-panel p-4 sm:p-5">
      <CornerSquare position="top-left" size="sm" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between pl-2">
        <div>
          <h2 ref={outcomeHeadingRef} tabIndex={-1} className="font-sans text-lg font-bold text-ink focus:outline-none">
            Analyst summary
          </h2>
          <p className="mt-1 font-mono text-xs text-ink-muted">
            {scan.workflow.name ?? 'Untitled workflow'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-control border px-2.5 py-1 font-mono text-2xs font-bold uppercase tracking-wider ${statusClass}`}
            aria-label={`Analysis status: ${statusLabel}`}
          >
            <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {statusLabel}
          </span>
          {incomplete ? null : <GradePill grade={assessment!.grade} />}
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-5">
        {incomplete ? (
          <div>
            <p className="font-sans text-xl font-bold leading-7 text-ink">
              {assessmentMissing ? 'Risk assessment unavailable.' : 'Analysis could not be completed.'}
            </p>
            <p className="mt-2 text-sm leading-6 text-ink-muted">
              {assessmentMissing
                ? 'The scanner did not produce a risk assessment from sufficient coverage, so no risk grade or summary is shown. Review the coverage details below.'
                : 'A required analysis stage did not finish, so no risk grade or summary is shown for this scan. Review the coverage notices below before relying on it.'}
            </p>
            {onRetry ? <button type="button" onClick={onRetry} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-control border border-sev-high bg-raised px-3 font-mono text-xs font-semibold text-ink transition-colors hover:bg-accent-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border active:translate-y-px">
              <RotateCcw className="h-4 w-4" aria-hidden="true" /><span>Retry deep scan</span>
            </button> : null}
          </div>
        ) : <>
          <div>
            <p className="font-sans text-xl font-bold leading-7 text-ink">{scan.humanSummary!.headline}</p>
            <p className="mt-2 text-sm leading-6 text-ink-muted">{scan.humanSummary!.verdict}</p>
          </div>

          <div className="grid gap-2 border-y border-hairline py-4 grid-cols-2 sm:grid-cols-5">
            {Object.entries(scan.summary!).map(([severity, count]) => (
              <Metric key={severity} severity={severity} count={count} />
            ))}
          </div>

          <TextBlock title="What it does" text={scan.humanSummary!.plainLanguageOverview} />
          <TextBlock title="Risk in plain language" text={scan.humanSummary!.riskNarrative} />
        </>}
      </div>
      {model ? <CoverageDetails model={model} /> : null}
    </section>
  );
}
