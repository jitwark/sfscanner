import type { SubjectV2 } from '@hub/contracts/scanner-v2-source';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { safeReportText } from '../report/report-safe-content';
import { sourceSpanLabel } from './report-evidence';

type ReportTraceProps = { model: ScannerReportModelV2 };

function subjectLabel(subject: SubjectV2): string {
  if (subject.kind === 'WORKFLOW') return 'Workflow subject';
  if (subject.kind === 'NODE') return `Node subject (ordinal ${subject.node.ordinal})`;
  if (subject.kind === 'EDGE') return `Edge subject (ordinal ${subject.edge.ordinal})`;
  return 'Source subject';
}

export function ReportTrace({ model }: ReportTraceProps) {
  const traces = model.v2.traces;

  return (
    <section aria-labelledby="scanner-v2-trace-heading" className="rounded-panel border border-hairline bg-panel p-4 sm:p-5">
      <h2 id="scanner-v2-trace-heading" className="font-display text-lg font-semibold text-ink">Verified traces</h2>
      <p className="mt-1 text-sm leading-6 text-ink-muted">Trace steps are metadata-only references. Raw workflow values, source payloads, and trace identifiers are withheld.</p>
      {traces.length === 0 ? <p className="mt-4 rounded-control border border-hairline bg-raised/40 p-3 text-sm text-ink-muted" role="note">No verified trace was returned. Trace evidence is absent or not applicable.</p> : <div className="mt-4 space-y-4">
        {traces.map((trace) => <article key={trace.traceId} className="rounded-control border border-hairline bg-raised/40 p-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-display text-base font-semibold text-ink">{safeReportText(trace.kind, 80)} trace</h3>
            <span className="font-mono text-xs text-ink-muted">{trace.steps.length} verified {trace.steps.length === 1 ? 'step' : 'steps'}</span>
          </div>
          {trace.steps.length > 0 ? <ol aria-label={`${trace.kind} trace steps`} className="mt-3 divide-y divide-hairline">
            {trace.steps.map((step) => <li key={`${trace.traceId}-${step.ordinal}`} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono font-semibold text-ink">Step {step.ordinal + 1} · {safeReportText(step.kind, 80)}</span>
                <span className="text-ink-muted">{subjectLabel(step.subject)}</span>
              </div>
              <p className="mt-1 text-xs leading-5 text-ink-muted">{sourceSpanLabel(step.subject)}</p>
              <p className="mt-1 text-xs leading-5 text-ink-muted">{step.factRefs.length} registered fact reference{step.factRefs.length === 1 ? '' : 's'}; fact values withheld.</p>
            </li>)}
          </ol> : <p className="mt-3 text-sm text-ink-muted" role="note">No verified steps were returned for this trace.</p>}
        </article>)}
      </div>}
    </section>
  );
}
