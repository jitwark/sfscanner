import { AlertCircle, AlertTriangle, Info, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ScanWorkflowResult } from '../engine';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';

/**
 * Required fields for a trustworthy user-facing decision and summary.
 *
 * An attached v2 scan decides with the worker's own status and assessment. Its
 * legacy projection is incomplete by construction (`workflow.risk-summary.v1`
 * has no producer), so consulting it here would mark every real COMPLETE or
 * graded DEGRADED envelope as indeterminate and withhold a grade the worker
 * actually returned. Detached scans keep the projection checks.
 */
export function isReportIncomplete(scan: ScanWorkflowResult): boolean {
  const candidate = scan as unknown as Partial<ScannerReportModelV2>;
  const analysis = candidate.v2?.analysis;
  if (candidate.v2?.schemaVersion === 'scanner-result-v2' && analysis) {
    return analysis.status === 'INDETERMINATE'
      || candidate.assessment === null
      || candidate.assessment === undefined;
  }
  return scan.analysisStatus === 'INDETERMINATE'
    || !scan.riskAssessment
    || !scan.humanSummary
    || !scan.summary;
}

export function GradePill({ grade }: { grade: string }) {
  const g = grade.toUpperCase();
  if (g === 'LOW') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-control border border-sev-low bg-raised px-2.5 py-1 text-xs font-semibold text-sev-low">
        <ShieldCheck className="h-3.5 w-3.5" />
        <span>LOW risk</span>
      </span>
    );
  }
  if (g === 'MEDIUM') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-control border border-sev-medium bg-raised px-2.5 py-1 text-xs font-semibold text-sev-medium">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>MEDIUM risk</span>
      </span>
    );
  }
  if (g === 'HIGH') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-control border border-sev-high bg-raised px-2.5 py-1 text-xs font-semibold text-sev-high">
        <AlertCircle className="h-3.5 w-3.5" />
        <span>HIGH risk</span>
      </span>
    );
  }
  if (g === 'CRITICAL') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-control border border-sev-critical bg-raised px-2.5 py-1 text-xs font-semibold text-sev-critical">
        <ShieldAlert className="h-3.5 w-3.5" />
        <span>CRITICAL risk</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-control border border-hairline bg-raised px-2.5 py-1 text-xs font-semibold text-ink-muted">
      <Info className="h-3.5 w-3.5" />
      <span>{grade} risk</span>
    </span>
  );
}

export function SeverityPill({ severity }: { severity: string }) {
  const s = severity.toUpperCase();
  if (s === 'CRITICAL') {
    return (
      <span className="inline-flex items-center gap-1 rounded-control border border-sev-critical bg-raised px-2 py-0.5 text-2xs font-semibold text-sev-critical">
        <ShieldAlert className="h-3 w-3" />
        <span>CRITICAL</span>
      </span>
    );
  }
  if (s === 'HIGH') {
    return (
      <span className="inline-flex items-center gap-1 rounded-control border border-sev-high bg-raised px-2 py-0.5 text-2xs font-semibold text-sev-high">
        <AlertCircle className="h-3 w-3" />
        <span>HIGH</span>
      </span>
    );
  }
  if (s === 'MEDIUM') {
    return (
      <span className="inline-flex items-center gap-1 rounded-control border border-sev-medium bg-raised px-2 py-0.5 text-2xs font-semibold text-sev-medium">
        <AlertTriangle className="h-3 w-3" />
        <span>MEDIUM</span>
      </span>
    );
  }
  if (s === 'LOW') {
    return (
      <span className="inline-flex items-center gap-1 rounded-control border border-sev-low bg-raised px-2 py-0.5 text-2xs font-semibold text-sev-low">
        <ShieldCheck className="h-3 w-3" />
        <span>LOW</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-control border border-hairline bg-raised px-2 py-0.5 text-2xs font-semibold text-ink-muted">
      <Info className="h-3 w-3" />
      <span>{severity}</span>
    </span>
  );
}

export function Metric({ severity, count }: { severity: string; count: number }) {
  const s = severity.toLowerCase();
  const textColour =
    s === 'critical'
      ? 'text-sev-critical'
      : s === 'high'
        ? 'text-sev-high'
        : s === 'medium'
          ? 'text-sev-medium'
          : s === 'low'
            ? 'text-sev-low'
            : 'text-ink-muted';

  return (
    <div className="rounded-control border border-hairline bg-raised/40 p-3">
      <p className={`font-mono text-xl font-bold ${textColour}`}>{count}</p>
      <p className="mt-0.5 font-mono text-2xs font-medium capitalize text-ink-muted">{severity}</p>
    </div>
  );
}

export function TextBlock({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h3 className="font-mono text-2xs font-semibold uppercase tracking-wider text-ink-muted">{title}</h3>
      <p className="mt-1 text-sm leading-6 text-ink">{text}</p>
    </div>
  );
}

export function ErrorBlock({ code, message }: { code: string; message: string }) {
  return (
    <div className="rounded-control border border-sev-critical bg-raised p-3 text-sm text-ink" role="alert">
      <span className="font-mono font-bold text-sev-critical">{code}:</span> {message}
    </div>
  );
}
