import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { safeReportText } from '../report/report-safe-content';
import { AdvisoryFactDetails, ReportAdvisoryStatus } from './report-advisory';

type ReportApplicabilityProps = { model: ScannerReportModelV2 };

type Applicability = ScannerReportModelV2['v2']['findings'][number]['applicability'];

function rationale(applicability: Applicability): string {
  if (applicability === 'APPLICABLE') return 'Known prerequisites match this target context.';
  if (applicability === 'NOT_APPLICABLE') return 'A known prerequisite excludes this target context.';
  return 'No applicability claim is made because a prerequisite or advisory authority is unknown.';
}

function unknownTargetFields(model: ScannerReportModelV2): string[] {
  const target = model.v2.target;
  const unknown: string[] = [];
  if (target.n8nVersion === undefined) unknown.push('n8nVersion');
  if (target.edition === 'UNKNOWN') unknown.push('edition');
  if (target.deployment === 'UNKNOWN') unknown.push('deployment');
  if (target.role === 'UNKNOWN') unknown.push('role');
  if (target.taskRunner === 'UNKNOWN') unknown.push('taskRunner');
  target.configuration.forEach((item) => {
    if (item.state === 'UNKNOWN') unknown.push(`configuration:${item.key}`);
  });
  return unknown;
}

export function ReportApplicability({ model }: ReportApplicabilityProps) {
  const findings = model.v2.findings;
  const advisoryFacts = model.v2.facts.filter((fact) => fact.kind === 'advisory.applicability.v3');
  const unknown = unknownTargetFields(model);
  const targetMessage = unknown.length > 0
    ? `Target context is partial. Unknown fields: ${unknown.map((field) => safeReportText(field, 120)).join(', ')}. Missing context stays UNKNOWN; it is not inferred from workflow data.`
    : 'Target context fields were supplied. This describes the declared context only and does not prove runtime configuration.';

  return (
    <section aria-labelledby="scanner-v2-applicability-heading" className="rounded-panel border border-hairline bg-panel p-4 sm:p-5">
      <h2 id="scanner-v2-applicability-heading" className="font-display text-lg font-semibold text-ink">Applicability and target context</h2>
      <p className="mt-1 text-sm leading-6 text-ink-muted">Applicability is evaluated only against explicit target facts and admitted advisory metadata. It is not a statement about runtime behavior.</p>

      <div className="mt-4 rounded-control border border-hairline bg-raised/40 p-3 text-sm leading-6 text-ink">
        <span className="font-semibold">{targetMessage}</span>
      </div>

      <ReportAdvisoryStatus facts={model.v2.facts} />

      {findings.length > 0 && <div className="mt-4 divide-y divide-hairline">
        {findings.map((finding) => <article key={finding.findingId} className="py-4 first:pt-0 last:pb-0">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <h3 className="font-display text-base font-semibold text-ink">{safeReportText(finding.ruleId, 140)}</h3>
            <span className="self-start rounded-control border border-hairline bg-raised px-2.5 py-1 font-mono text-2xs font-semibold text-ink">Applicability: {finding.applicability}</span>
          </div>
          <p className="mt-2 text-sm leading-6 text-ink-muted">{rationale(finding.applicability)}</p>
        </article>)}
      </div>}

      <div className="mt-5 border-t border-hairline pt-4">
        <h3 className="font-mono text-2xs font-semibold uppercase tracking-wider text-ink-muted">Advisory applicability rationale</h3>
        {advisoryFacts.length > 0 ? <ul aria-label="Advisory applicability evidence" className="mt-3 space-y-2">
          {advisoryFacts.map((fact) => <li key={fact.factId} className="rounded-control border border-hairline bg-raised/40 p-3">
            <AdvisoryFactDetails fact={fact} />
          </li>)}
        </ul> : <p className="mt-3 text-sm text-ink-muted">No advisory applicability rows are available. Read the advisory status and package coverage above before drawing a conclusion.</p>}
      </div>
    </section>
  );
}
