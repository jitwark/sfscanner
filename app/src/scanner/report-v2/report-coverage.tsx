import { AlertTriangle, CircleHelp, ShieldCheck } from 'lucide-react';
import type { RefObject } from 'react';
import type { AnalysisDiagnosticV2 } from '@hub/contracts/scanner-v2-result';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { scanAnalysisPresentation } from '../analysis-language';
import { safeReportText } from '../report/report-safe-content';

type ReportCoverageProps = { model: ScannerReportModelV2; outcomeHeadingRef?: RefObject<HTMLHeadingElement | null> };

/** Fixed prose for every capability status; never sourced from the model. */
const CAPABILITY_STATUS_EXPLANATIONS: Readonly<Record<string, string>> = {
  COMPLETED: 'This capability completed its bounded review.',
  SKIPPED: 'This capability was skipped, so its evidence is missing from this report.',
  DEGRADED: 'This capability ran with bounded omissions, so its evidence is incomplete.',
  FAILED: 'This capability failed, so its evidence is unavailable.',
};

/** Fixed prose for every registered diagnostic code; an unknown code gets the fallback below. */
const DIAGNOSTIC_EXPLANATIONS: Readonly<Record<string, string>> = {
  SOURCE_SPAN_UNAVAILABLE: 'A source span could not be retained, so a location is reported without positions.',
  DUPLICATE_FINDING_COLLAPSED: 'A duplicate finding was collapsed into a single record.',
  UNCLASSIFIED_CONNECTION_TYPE: 'A connection type was not classified, so part of the graph may be missing.',
  DUPLICATE_METADATA_KEY: 'A duplicate metadata key was ignored.',
  OPTIONAL_LIMIT_EXCEEDED: 'An optional analysis bound was reached, so some evidence was omitted and the affected capability is degraded.',
  UNSUPPORTED_CODE_NODE_VARIANT: 'A code node variant is unsupported, so its source was not analyzed.',
  JAVASCRIPT_PARSE_FAILED: 'JavaScript source could not be parsed, so its evidence is unavailable.',
  JAVASCRIPT_SOURCE_UNAVAILABLE: 'JavaScript source was unavailable, so it was not analyzed.',
  PYTHON_SOURCE_UNAVAILABLE: 'Python source was unavailable, so it was not analyzed.',
  PYTHON_PARSE_FAILED: 'Python source could not be parsed, so its evidence is unavailable.',
  PYTHON_PARSER_UNAVAILABLE: 'The Python parser was unavailable, so Python source was not analyzed.',
  EXPRESSION_PARSE_FAILED: 'An expression could not be parsed, so it was not analyzed.',
  GRAPH_ENTRY_UNRESOLVED: 'A workflow entry point could not be resolved, so reachable evidence may be incomplete.',
  GRAPH_WORK_LIMIT_EXCEEDED: 'The graph analysis work bound was reached, so some traversal was omitted.',
  GRAPH_ANALYSIS_DEGRADED: 'Graph analysis completed with bounded omissions.',
  SEMANTIC_CATALOGUE_MISS: 'A node has no semantic catalogue entry, so its behavior was not fully modeled.',
  GENERIC_NODE_UNMODELED_CAPABILITY: 'A node was modeled generically, so some capability detail is unknown.',
  POLICY_EXECUTION_FAILED: 'A policy could not execute, so its findings are unavailable.',
  DEPENDENCY_UNAVAILABLE: 'A required dependency was unavailable, so the affected check could not run.',
  UNKNOWN_REPORT_ONLY_RULE: 'A report-only rule was unknown and was not evaluated.',
  REQUIRED_LIMIT_EXCEEDED: 'A required analysis bound was reached, so required evidence is missing.',
  DUPLICATE_SECURITY_KEY: 'A duplicate security metadata key was ignored.',
  MALFORMED_NODE_PARAMETERS: 'Node parameters were malformed, so configuration evidence may be incomplete.',
  MALFORMED_CONNECTION_INDEX: 'A connection index was malformed, so part of the graph may be missing.',
  REQUIRED_CAPABILITY_FAILED: 'A required capability failed, so its evidence is unavailable.',
  UNKNOWN_SCORING_RULE: 'A scoring rule was unknown, so the assessment could not be completed.',
  COMPATIBILITY_PROJECTION_LOSS: 'V1 compatibility projection dropped evidence; the v2 result remains authoritative.',
  REQUIRED_STAGE_FAILURE: 'A required analysis stage failed, so required evidence is missing.',
};

const UNKNOWN_DIAGNOSTIC_EXPLANATION = 'No static explanation is registered for this code; treat the reported counts as the only description of the omission.';
const UNKNOWN_STATUS_EXPLANATION = 'No static explanation is registered for this capability status.';
const LIMIT_EXPLANATION = 'Omitted evidence is not a clean result; review this bound before relying on the report.';
const LIMIT_EXHAUSTED_EXPLANATION = 'This bound was exhausted, so further evidence was not reviewed.';
const NOT_LINKED_NOTE = 'Not linked to a capability row; the explanation above describes only the registered code.';

function boundsLabel(diagnostic: AnalysisDiagnosticV2): string {
  return [
    diagnostic.observed === undefined ? undefined : `observed ${diagnostic.observed}`,
    diagnostic.maximum === undefined ? undefined : `maximum ${diagnostic.maximum}`,
    diagnostic.omitted === undefined ? undefined : `omitted ${diagnostic.omitted}`,
  ].filter((part): part is string => part !== undefined).join(' · ');
}

function DiagnosticExplanation({ diagnostic }: { diagnostic: AnalysisDiagnosticV2 }) {
  const bounds = boundsLabel(diagnostic);
  return <>
    <p className="font-mono text-2xs text-ink">{safeReportText(diagnostic.code, 100)} · {safeReportText(diagnostic.aggregateEffect, 40)}</p>
    {bounds === '' ? null : <p className="mt-1 font-mono text-2xs text-ink-muted">{bounds}</p>}
    <p className="mt-1 text-xs leading-5 text-ink-muted">Explanation: {DIAGNOSTIC_EXPLANATIONS[diagnostic.code] ?? UNKNOWN_DIAGNOSTIC_EXPLANATION}</p>
  </>;
}

export function ReportCoverage({ model, outcomeHeadingRef }: ReportCoverageProps) {
  const { analysis, limits } = model.v2;
  const presentation = scanAnalysisPresentation(model);
  const statusTone = presentation.tone === 'complete'
    ? 'border-sev-low bg-raised text-sev-low'
    : presentation.tone === 'neutral'
      ? 'border-hairline bg-raised text-ink-muted'
      : presentation.tone === 'caution'
        ? 'border-sev-medium bg-raised text-sev-medium'
        : 'border-sev-high bg-raised text-sev-high';
  const messageTone = presentation.tone === 'complete'
    ? 'border-hairline bg-raised/40'
    : presentation.tone === 'neutral'
      ? 'border-hairline bg-raised/40'
      : presentation.tone === 'caution'
        ? 'border-sev-medium bg-raised/50'
        : 'border-sev-high bg-raised/50';
  const StatusIcon = presentation.tone === 'complete'
    ? ShieldCheck
    : presentation.tone === 'neutral'
      ? CircleHelp
      : AlertTriangle;
  const omissions = limits.usage.reduce((total, limit) => total + limit.omitted, 0) + model.v2.stats.omittedFindings;
  const diagnosticsById = new Map(analysis.diagnostics.map((diagnostic) => [diagnostic.id, diagnostic]));
  const referencedIds = new Set(analysis.capabilities.flatMap((capability) => capability.diagnosticIds));
  const unlinked = analysis.diagnostics.filter((diagnostic) => !referencedIds.has(diagnostic.id));

  return (
    <section aria-labelledby="scanner-v2-coverage-heading" className="rounded-panel border border-hairline bg-panel p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 ref={outcomeHeadingRef} tabIndex={outcomeHeadingRef ? -1 : undefined} id="scanner-v2-coverage-heading" className="font-display text-lg font-semibold text-ink focus:outline-none">Analysis coverage</h2>
          <p className="mt-1 text-sm leading-6 text-ink-muted">Execution coverage is evidence about what the scanner examined, not proof that unexamined behavior is safe.</p>
        </div>
        <span role="status" className={`inline-flex items-center gap-1.5 self-start rounded-control border px-2.5 py-1 font-mono text-2xs font-bold uppercase tracking-wider ${statusTone}`} aria-label={`Analysis status: ${presentation.label}`}>
          <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {presentation.label}
        </span>
      </div>

      <div className={`mt-4 rounded-control border p-3 text-sm leading-6 text-ink ${messageTone}`} role={presentation.tone === 'warning' ? 'alert' : presentation.label === 'Analysis complete' ? undefined : 'note'}>
        {presentation.message}
      </div>

      <div className="mt-5">
        <h3 className="font-mono text-2xs font-semibold uppercase tracking-wider text-ink-muted">Capability execution</h3>
        {analysis.capabilities.length > 0 ? <ul aria-label="Analysis capability coverage" className="mt-3 space-y-2">
          {analysis.capabilities.map((capability) => {
            const referenced = capability.diagnosticIds
              .map((id) => diagnosticsById.get(id))
              .filter((diagnostic): diagnostic is AnalysisDiagnosticV2 => diagnostic !== undefined);
            return <li key={capability.id} className="rounded-control border border-hairline bg-raised/40 p-3 text-sm">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <span className="font-mono font-semibold text-ink">{safeReportText(capability.id, 100)}{capability.required ? ' · required' : ' · optional'}</span>
                <span className="text-ink-muted">{safeReportText(capability.status, 40)} · {capability.analyzed}/{capability.seen} analyzed · {capability.skipped} skipped · {capability.omitted} omitted</span>
              </div>
              <p className="mt-2 text-xs leading-5 text-ink-muted">{CAPABILITY_STATUS_EXPLANATIONS[capability.status] ?? UNKNOWN_STATUS_EXPLANATION}</p>
              {referenced.length > 0 ? <ul aria-label={`Referenced diagnostics for ${safeReportText(capability.id, 100)}`} className="mt-2 space-y-2">
                {referenced.map((diagnostic) => <li key={diagnostic.id} className="rounded-control border border-hairline bg-panel p-2">
                  <DiagnosticExplanation diagnostic={diagnostic} />
                </li>)}
              </ul> : null}
            </li>;
          })}
        </ul> : <p className="mt-3 rounded-control border border-hairline bg-raised/40 p-3 text-sm text-ink-muted" role="note">No capability executions were returned.</p>}
      </div>

      <div className="mt-5 border-t border-hairline pt-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-mono text-2xs font-semibold uppercase tracking-wider text-ink-muted">Bounded omissions and limits</h3>
          <span className="font-mono text-xs text-ink-muted">{omissions} omitted</span>
        </div>
        {limits.usage.length > 0 ? <ul aria-label="Analysis limit usage" className="mt-3 space-y-2">
          {limits.usage.map((limit) => <li key={limit.id} className="rounded-control border border-hairline bg-raised/40 p-3 text-sm">
            <p className="text-ink-muted"><span className="font-mono font-semibold text-ink">{safeReportText(limit.id, 100)}</span>: {limit.examined}/{limit.maximum} examined · {limit.omitted} omitted{limit.exhausted ? ' · limit exhausted' : ''}</p>
            <p className="mt-1 text-xs leading-5 text-ink-muted">{LIMIT_EXPLANATION}{limit.exhausted ? ` ${LIMIT_EXHAUSTED_EXPLANATION}` : ''}</p>
          </li>)}
        </ul> : <p className="mt-3 text-sm text-ink-muted">No scanner limit rows were returned.</p>}
        {omissions === 0 ? <p className="mt-3 flex items-start gap-2 text-sm text-ink-muted" role="note"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-sev-low" aria-hidden="true" />No bounded omissions were reported by the result.</p> : <p className="mt-3 flex items-start gap-2 text-sm text-sev-medium" role="note"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />Omitted evidence is not a clean result; review the affected limits before relying on the report.</p>}
      </div>

      <div className="mt-5 border-t border-hairline pt-4">
        <h3 className="font-mono text-2xs font-semibold uppercase tracking-wider text-ink-muted">Coverage diagnostics</h3>
        {unlinked.length > 0 ? <ul aria-label="Analysis diagnostics" className="mt-3 space-y-2">
          {unlinked.map((diagnostic) => <li key={diagnostic.id} className="rounded-control border border-sev-medium bg-raised p-2">
            <DiagnosticExplanation diagnostic={diagnostic} />
            <p className="mt-1 text-xs leading-5 text-ink-muted">{NOT_LINKED_NOTE}</p>
          </li>)}
        </ul> : <p className="mt-3 text-sm text-ink-muted">No unlinked coverage diagnostics were returned.</p>}
      </div>
    </section>
  );
}
