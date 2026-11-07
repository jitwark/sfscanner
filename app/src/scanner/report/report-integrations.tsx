import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { ScanWorkflowResult } from '../engine';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { isReportIncomplete } from './report-blocks';
import { anatomy, pluralize } from './report-formatting';

type ReportIntegrationsProps = { scan: ScanWorkflowResult };
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
        {analysis.capabilities.map((capability) => <li key={capability.id} className="flex flex-col gap-1 rounded-control border border-hairline bg-raised/40 p-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <span className="font-mono font-semibold text-ink">{capability.id}</span>
          <span className="text-ink-muted">
            {capability.status} · {capability.analyzed}/{capability.seen} analyzed · {capability.skipped} skipped · {capability.omitted} omitted
          </span>
        </li>)}
      </ul>
      {limits.usage.length > 0 ? <ul aria-label="Analysis limit usage" className="mt-2 space-y-2">
        {limits.usage.map((limit) => <li key={limit.id} className="rounded-control border border-hairline bg-raised/40 p-3 text-sm text-ink-muted">
          <span className="font-mono font-semibold text-ink">{limit.id}</span>: {limit.examined}/{limit.maximum} examined · {limit.omitted} omitted{limit.exhausted ? ' · limit exhausted' : ''}
        </li>)}
      </ul> : null}
      {analysis.diagnostics.length > 0 ? <ul aria-label="Analysis diagnostics" className="mt-2 flex flex-wrap gap-2">
        {analysis.diagnostics.map((diagnostic) => <li key={diagnostic.id} className="rounded-full border border-sev-medium bg-raised px-2.5 py-1 font-mono text-2xs text-sev-medium">
          Notice: {diagnostic.code} · {diagnostic.aggregateEffect}
        </li>)}
      </ul> : null}
    </div>
  );
}


export function ReportIntegrations({ scan }: ReportIntegrationsProps) {
  const model = v2Model(scan);
  const status = model?.v2.analysis.status ?? scan.analysisStatus;
  const assessmentMissing = model?.assessment === null;
  const incomplete = isReportIncomplete(scan) || status === 'INDETERMINATE' || assessmentMissing;
  const complete = status === 'COMPLETE' && !incomplete;

  return (
    <section className="rounded-panel border border-hairline bg-panel p-4 sm:p-5">
      <h2 className="font-display text-lg font-semibold text-ink">Readiness and integrations</h2>
      <div className="mt-3 flex items-start gap-2 rounded-control border border-hairline bg-raised/40 p-3 text-sm text-ink">
        {complete
          ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-sev-low" aria-hidden="true" />
          : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-sev-medium" aria-hidden="true" />}
        <p>
          <span className="font-semibold">{complete ? 'Full local analysis completed.' : 'Analysis has coverage limits.'}</span>{' '}
          {incomplete ? 'Required report data was unavailable, so no risk decision is shown.' : null}{' '}
          Confirm credentials, write actions, destination hosts, and node settings in n8n before import.
        </p>
      </div>

      {model ? <CoverageDetails model={model} /> : !complete && scan.analysisDiagnostics.length > 0 ? <ul className="mt-3 flex flex-wrap gap-2" aria-label="Analysis coverage notices">
        {scan.analysisDiagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${index}`} className="rounded-full border border-sev-medium bg-raised px-2.5 py-1 font-mono text-2xs text-sev-medium">
          Notice: {diagnostic.code}
        </li>)}
      </ul> : null}

      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4 lg:grid-cols-7">
        {anatomy(scan).map(([label, value]) => <div key={label} className="border-t border-hairline pt-3">
          <p className="font-mono text-sm font-semibold text-ink">{value}</p>
          <p className="mt-1 font-mono text-2xs font-medium text-ink-muted">{label}</p>
        </div>)}
      </div>

      {scan.integrations.length > 0 ? <div className="mt-5 border-t border-hairline pt-4">
        <h3 className="font-display text-base font-semibold text-ink">Integrations used</h3>
        <div className="mt-3 divide-y divide-hairline">
          {scan.integrations.map((integration) => <article key={integration.service} className="py-3 first:pt-0 last:pb-0">
            <div className="flex items-center justify-between gap-2">
              <h4 className="font-display text-sm font-semibold text-ink">{integration.service}</h4>
              <span className="font-mono text-xs text-ink-muted">{integration.nodeCount} {pluralize('node', integration.nodeCount)}</span>
            </div>
            <p className="mt-1 text-sm leading-6 text-ink-muted">{integration.usage}</p>
            {integration.riskNotes.length > 0 ? <p className="mt-1 flex items-start gap-1.5 font-mono text-xs font-medium text-sev-medium">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>Review: {integration.riskNotes.join(' ')}</span>
            </p> : null}
          </article>)}
        </div>
      </div> : <p className="mt-4 text-sm text-ink-muted">No third-party integrations were identified.</p>}
    </section>
  );
}
