'use client';

import { useState } from 'react';
import { CircleCheck, MapPin } from 'lucide-react';
import type { ScanWorkflowResult } from '../engine';
import type { CanonicalScanFinding, PolicyEffect, ScanSeverity } from '@hub/scanner-core/policy';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import { FindingDetails } from './finding-details';
import { isReportIncomplete, SeverityPill } from './report-blocks';
import { location, pluralize } from './report-formatting';
import { safeReportText } from './report-safe-content';
import { ReportTrust, scannerRuleReferenceHref } from './report-trust';

type ReportFindingsProps = { scan: ScanWorkflowResult };
type FindingSeverityFilter = ScanSeverity | 'ALL';
type FindingEffectFilter = PolicyEffect | 'ALL';
type FindingFilters = { severity: FindingSeverityFilter; effect: FindingEffectFilter };
type FilterUpdate = FindingFilters | ((current: FindingFilters) => FindingFilters);
function v2Model(scan: ScanWorkflowResult): ScannerReportModelV2 | undefined {
  const candidate = scan as unknown as Partial<ScannerReportModelV2>;
  return candidate.v2?.schemaVersion === 'scanner-result-v2' ? candidate as ScannerReportModelV2 : undefined;
}
const DEFAULT_FILTERS: FindingFilters = { severity: 'ALL', effect: 'ALL' };
const SEVERITIES: ScanSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const FINDING_PAGE_SIZE = 20;
const advisoryExplanation =
  'Advisory findings are informational. They do not change the risk grade, and their rules are still being calibrated.';

export function ReportFindings({ scan }: ReportFindingsProps) {
  const [filterState, setFilterState] = useState(() => ({ scan, filters: DEFAULT_FILTERS }));
  const [paginationState, setPaginationState] = useState(() => ({ scan, limit: FINDING_PAGE_SIZE }));
  const filters = filterState.scan === scan ? filterState.filters : DEFAULT_FILTERS;
  const displayLimit = paginationState.scan === scan ? paginationState.limit : FINDING_PAGE_SIZE;
  const model = v2Model(scan);
  const setFilters = (update: FilterUpdate) => {
    setPaginationState({ scan, limit: FINDING_PAGE_SIZE });
    setFilterState((current) => {
      const previous = current.scan === scan ? current.filters : DEFAULT_FILTERS;
      return { scan, filters: typeof update === 'function' ? update(previous) : update };
    });
  };

  const isPriority = (finding: CanonicalScanFinding) => finding.severity === 'CRITICAL' || finding.severity === 'HIGH';
  const priority = scan.findings.filter(isPriority);
  const other = scan.findings.filter((finding) => !isPriority(finding)).filter((finding) => {
    const severityMatches = filters.severity === 'ALL' || finding.severity === filters.severity;
    const effectMatches = filters.effect === 'ALL' || finding.policyEffect === filters.effect;
    return severityMatches && effectMatches;
  });
  const matchingFindings = [...priority, ...other];
  const visiblePriority = priority.slice(0, displayLimit);
  const visibleOther = other.slice(0, Math.max(displayLimit - visiblePriority.length, 0));
  const visibleFindings = [...visiblePriority, ...visibleOther];
  const remainingFindings = matchingFindings.length - visibleFindings.length;
  const nodes = affectedNodes(matchingFindings);
  const filtersActive = filters.severity !== 'ALL' || filters.effect !== 'ALL';
  const emptyScan = scan.findings.length === 0;
  const noMatches = !emptyScan && filtersActive && other.length === 0;
  const statusText = emptyScan
    ? emptyFindingsStatus(scan)
      : noMatches
      ? `No findings match these filters. ${priority.length > 0 ? `${priority.length} priority ${priority.length === 1 ? 'finding remains' : 'findings remain'} visible.` : 'Clear filters to review the scan results.'}${remainingFindings > 0 ? ` ${remainingFindings} more ${pluralize('finding', remainingFindings)} available; select Show more findings.` : ''}`
      : `Showing ${visibleFindings.length} of ${scan.findings.length} findings${filtersActive ? ' with filters applied; priority findings remain visible' : ''}.${remainingFindings > 0 ? ` ${remainingFindings} more ${pluralize('finding', remainingFindings)} available; select Show more findings.` : ''}`;

  return <>
    <section aria-labelledby="scanner-findings-heading" className="rounded-panel border border-hairline bg-panel p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 id="scanner-findings-heading" className="font-display text-lg font-semibold text-ink">Critical and high findings</h2>
        <p className="font-mono text-xs text-ink-muted">{priority.length} priority</p>
      </div>
      {priority.length > 0 ? <div className="mt-4 divide-y divide-hairline">
        {visiblePriority.map((finding, index) => <FindingCard key={`${finding.policyId}-${index}`} finding={finding} model={model} />)}
      </div> : !filtersActive ? <p className="mt-3 flex items-start gap-2 text-sm text-ink-muted">
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-sev-low" aria-hidden="true" />
        <span>{noPriorityFindingsMessage(scan)}</span>
      </p> : null}
      <p id="scanner-findings-status" className="mt-3 text-xs text-ink-muted" role="status" aria-live="polite">{statusText}</p>

      {!emptyScan ? <div className="mt-4 border-t border-hairline pt-4">
        <h3 className="font-display text-base font-semibold text-ink">Filter other findings</h3>
        <p className="mt-1 text-xs leading-5 text-ink-muted">Priority findings stay visible. These filters narrow the remaining findings.</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="finding-severity-filter" className="font-mono text-2xs font-semibold uppercase tracking-wider text-ink-muted">Severity</label>
            <select id="finding-severity-filter" aria-label="Filter findings by severity" value={filters.severity}
              onChange={(event) => setFilters((current) => ({ ...current, severity: event.target.value as FindingSeverityFilter }))}
              className="mt-1 block min-h-11 rounded-control border border-hairline bg-raised px-3 text-sm text-ink">
              <option value="ALL">All severities</option>
              {SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="finding-effect-filter" className="font-mono text-2xs font-semibold uppercase tracking-wider text-ink-muted">Effect</label>
            <select id="finding-effect-filter" aria-label="Filter findings by effect" value={filters.effect}
              onChange={(event) => setFilters((current) => ({ ...current, effect: event.target.value as FindingEffectFilter }))}
              className="mt-1 block min-h-11 rounded-control border border-hairline bg-raised px-3 text-sm text-ink">
              <option value="ALL">All effects</option>
              <option value="LEGACY_SCORE">Changes risk grade</option>
              <option value="REPORT_ONLY">Report-only</option>
            </select>
          </div>
          <button type="button" onClick={() => setFilters(DEFAULT_FILTERS)} disabled={!filtersActive}
            aria-label="Clear finding filters"
            className="inline-flex min-h-11 items-center rounded-control border border-hairline bg-raised px-3 font-mono text-xs font-semibold text-ink transition-all hover:border-accent-border hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-40">
            Clear filters
          </button>
        </div>
      </div> : null}

      {emptyScan ? <p className="mt-4 rounded-control border border-accent-border/30 bg-accent-dim p-3 text-sm leading-6 text-ink" role="note">
        {emptyFindingsMessage(scan)}
      </p> : noMatches ? <p className="mt-4 rounded-control border border-accent-border/30 bg-accent-dim p-3 text-sm leading-6 text-ink" role="note">
        No filterable findings match these filters. The scan did return findings; priority findings remain visible while you review the filterable findings.
      </p> : null}

      {visibleOther.length > 0 ? <div className="mt-5 border-t border-hairline pt-4">
        <h3 className="font-display text-base font-semibold text-ink">Other findings</h3>
        {visibleOther.some((finding) => finding.policyEffect === 'REPORT_ONLY') ? <p className="mt-2 text-xs leading-5 text-accent-text" role="note">{advisoryExplanation}</p> : null}
        <div className="mt-3 divide-y divide-hairline">
          {visibleOther.map((finding, index) => <FindingCard key={`${finding.policyId}-${index}`} finding={finding} model={model} />)}
        </div>
      </div> : null}
      {remainingFindings > 0 ? <button type="button" aria-describedby="scanner-findings-status" onClick={() => setPaginationState((current) => ({
        scan, limit: (current.scan === scan ? current.limit : FINDING_PAGE_SIZE) + FINDING_PAGE_SIZE,
      }))} className="mt-5 min-h-11 rounded-control border border-hairline bg-raised px-3 font-mono text-xs font-semibold text-ink hover:border-accent-border hover:bg-accent-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-border">
        Show more findings ({Math.min(FINDING_PAGE_SIZE, remainingFindings)})
      </button> : null}
    </section>

    <ReportTrust scan={scan} />

    <section aria-labelledby="affected-nodes-heading" className="rounded-panel border border-hairline bg-panel p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 id="affected-nodes-heading" className="font-display text-lg font-semibold text-ink">Affected nodes</h2>
        <p className="font-mono text-xs text-ink-muted">{nodes.length} {pluralize('node', nodes.length)}</p>
      </div>
      {nodes.length > 0 ? <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {nodes.map((node) => <li key={node} className="flex items-start gap-2 rounded-control border border-hairline bg-raised/40 p-3 text-sm text-ink">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-accent-text" aria-hidden="true" /><span className="break-all">{node}</span>
        </li>)}
      </ul> : <p className="mt-3 text-sm text-ink-muted">No finding was tied to a specific node.</p>}
    </section>
  </>;
}
function reportStatus(scan: ScanWorkflowResult): ScanWorkflowResult['analysisStatus'] {
  const model = v2Model(scan);
  return model?.v2.analysis?.status ?? scan.analysisStatus;
}
function hasIncompleteCoverage(scan: ScanWorkflowResult): boolean {
  return reportStatus(scan) !== 'COMPLETE' || isReportIncomplete(scan);
}

function emptyFindingsStatus(scan: ScanWorkflowResult): string {
  if (reportStatus(scan) === 'INDETERMINATE') return 'Analysis did not complete; no findings can be treated as conclusive.';
  if (hasIncompleteCoverage(scan)) return 'Analysis coverage is incomplete; no findings can be treated as conclusive.';
  return 'No findings were returned for this scan.';
}

function emptyFindingsMessage(scan: ScanWorkflowResult): string {
  if (reportStatus(scan) === 'INDETERMINATE') {
    return 'No findings were returned because the required analysis did not complete. This empty result is not conclusive. Review coverage notices before relying on it.';
  }
  if (hasIncompleteCoverage(scan)) {
    return 'No findings were returned. Analysis coverage is incomplete, so this empty result is not conclusive. Review coverage notices before relying on it.';
  }
  return 'No findings were returned for this scan. The workflow was analyzed, but no reportable findings were produced.';
}

function noPriorityFindingsMessage(scan: ScanWorkflowResult): string {
  if (hasIncompleteCoverage(scan)) {
    return 'No critical or high findings were identified in the findings returned so far. Analysis coverage is incomplete; review coverage notices before relying on this result.';
  }
  return 'No critical or high findings were returned. Review every node and credential boundary before import.';
}

function FindingCard({ finding, model }: { finding: CanonicalScanFinding; model?: ScannerReportModelV2 }) {
  const v2Finding = model?.v2.findings.find((item) => item.ruleId === finding.policyId && item.severity === finding.severity && item.confidence === finding.confidence && (item.effect === 'SCORING') === (finding.policyEffect === 'LEGACY_SCORE')) ?? model?.v2.findings.find(({ ruleId }) => ruleId === finding.policyId);
  const traceCount = model && v2Finding ? v2Finding.traceRefs.filter((ref) => model.v2.traces.some((trace) => trace.traceId === ref)).length : 0;
  // No configured reference means the policy id is text, not a dead anchor.
  const ruleHref = scannerRuleReferenceHref();
  return <article className="py-4 first:pt-0 last:pb-0">
    <div className="flex flex-wrap items-center gap-2">
      <SeverityPill severity={finding.severity} />
      {finding.policyEffect === 'REPORT_ONLY' ? <span className="font-mono text-2xs font-semibold text-accent-text">Advisory finding — did not change risk grade</span> : null}
    </div>
    <h3 className="mt-2 font-display text-base font-semibold text-ink">{safeReportText(finding.title, 180)}</h3>
    <p className="mt-1 font-mono text-xs text-ink-muted">
      {ruleHref ? (
        <a href={ruleHref} target="_blank" rel="noopener noreferrer"
          aria-label={`Open generated scanner rule reference for ${safeReportText(finding.policyId, 120)}`}
          className="text-accent-text underline underline-offset-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-border">
          {safeReportText(finding.policyId, 120)}
        </a>
      ) : (
        <span className="text-accent-text">{safeReportText(finding.policyId, 120)}</span>
      )}{safeReportText(location(finding.location), 180)}
    </p>
    <p className="mt-3 text-sm leading-6 text-ink">{safeReportText(finding.message)}</p>
    <p className="mt-2 text-sm leading-6 text-ink">{safeReportText(finding.explanation)}</p>
    {v2Finding ? <p className="mt-3 text-xs leading-5 text-ink-muted" aria-label="V2 finding evidence">
      Applicability: {v2Finding.applicability} · Evidence class: {v2Finding.evidenceClass} · Effect: {v2Finding.effect}{v2Finding.effect === 'REPORT_ONLY' ? ' (does not change risk grade)' : ''} · Trace references: {v2Finding.traceRefs.length} total; {traceCount} available · Trace labels: {v2Finding.traceRefs.map((ref) => model?.v2.traces.find((trace) => trace.traceId === ref)?.kind).filter(Boolean).join(', ') || 'none'}
    </p> : null}
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <SafeTextBlock title="Why it matters" text={finding.whyItMatters} />
      <SafeTextBlock title="Possible impact" text={finding.possibleImpact} />
    </div>
    <FindingDetails finding={finding} />
  </article>;
}
function SafeTextBlock({ title, text }: { title: string; text: string }) {
  return <div><h4 className="font-mono text-2xs font-semibold uppercase tracking-wider text-ink-muted">{title}</h4><p className="mt-1 text-sm leading-6 text-ink">{safeReportText(text)}</p></div>;
}
function affectedNodes(findings: CanonicalScanFinding[]): string[] {
  return Array.from(new Set(findings.map((finding) => safeReportText(finding.location.nodeName ?? finding.location.nodeId ?? 'Workflow-level finding', 180))));
}
