import type { EntrySecurity, PublicFinding, Severity } from '@hub/contracts';
import { analysisPresentation, type AnalysisTone } from '../../scanner/analysis-language';

const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

const SEVERITY_CLASS: Record<Severity, string> = {
  CRITICAL: 'border-sev-critical/50 bg-sev-critical/10 text-sev-critical',
  HIGH: 'border-sev-high/50 bg-sev-high/10 text-sev-high',
  MEDIUM: 'border-sev-medium/50 bg-sev-medium/10 text-sev-medium',
  LOW: 'border-sev-low/50 bg-sev-low/10 text-sev-low',
  INFO: 'border-hairline bg-raised text-ink-muted',
};

export type StatusToneClasses = {
  panel: string;
  label: string;
};

const STATUS_TONE_CLASS: Record<AnalysisTone, StatusToneClasses> = {
  complete: { panel: 'border-sev-low/40 bg-sev-low/5', label: 'text-sev-low' },
  neutral: { panel: 'border-hairline bg-raised/50', label: 'text-ink-muted' },
  caution: { panel: 'border-sev-medium/50 bg-sev-medium/10', label: 'text-sev-medium' },
  warning: { panel: 'border-sev-high/50 bg-sev-high/10', label: 'text-sev-high' },
};

export type SecuritySummaryModel = {
  grade: EntrySecurity['grade'];
  knownGrade: boolean;
  score: number;
  scoreAvailable: boolean;
  scoreLabel: string;
  gradeAriaLabel: string;
  statusLabel: string;
  statusMessage: string;
  statusTone: AnalysisTone;
  meaning: string;
  nextStep: string;
  findings: PublicFinding[];
  priorityFindings: PublicFinding[];
  remainingFindings: PublicFinding[];
  totalFindings: number;
  counts: EntrySecurity['counts'];
  noResultCode: string | null;
};

export function severityTag(severity: Severity): { label: Severity; className: string } {
  return { label: severity, className: SEVERITY_CLASS[severity] };
}

export function statusToneClasses(tone: AnalysisTone): StatusToneClasses {
  return STATUS_TONE_CLASS[tone];
}

export function securitySummary(security: EntrySecurity): SecuritySummaryModel {
  const findings = [...security.findings].sort((left, right) => (
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
  ));
  const priorityFindings = findings.slice(0, 3);
  const knownGrade = security.grade !== 'UNKNOWN';
  const scoreAvailable = knownGrade && !security.noResult && !security.stampReason && security.analysisStatus !== 'INDETERMINATE';
  const presentation = analysisPresentation({
    status: security.analysisStatus,
    assessment: knownGrade ? 'present' : 'unavailable',
    evidenceComplete: false,
    diagnostics: (security.analysisDiagnosticCodes ?? []).map((code) => ({ code })),
  });
  const noResultCode = security.noResult ? security.noResultCode ?? null : null;
  const statusLabel = security.noResult || security.stampReason ? 'Assessment unavailable' : presentation.label;
  const statusMessage = security.noResult
    ? `${presentation.summary} The scanner returned no result${noResultCode ? ` (${noResultCode})` : ''}.`
    : security.stampReason === 'source_unavailable'
      ? `${presentation.summary} The source workflow could not be re-acquired for a current scan.`
      : presentation.summary;
  const statusTone = security.noResult || security.stampReason ? 'warning' : presentation.tone;

  return {
    grade: security.grade,
    knownGrade,
    score: security.score,
    scoreAvailable,
    scoreLabel: scoreAvailable ? `${security.score}/100` : 'No score available',
    gradeAriaLabel: scoreAvailable
      ? `Scanner grade ${security.grade}, score ${security.score} out of 100`
      : `Scanner grade ${security.grade}, no score available`,
    statusLabel,
    statusMessage,
    statusTone,
    meaning: summaryMeaning(security, findings.length),
    nextStep: summaryNextStep(security, priorityFindings, presentation.label),
    findings,
    priorityFindings,
    remainingFindings: findings.slice(priorityFindings.length),
    totalFindings: findings.length,
    counts: security.counts,
    noResultCode,
  };
}

function summaryMeaning(security: EntrySecurity, totalFindings: number): string {
  if (security.noResult) {
    return 'No result was returned, so there is no evidence-backed risk decision for this workflow.';
  }
  if (security.grade === 'UNKNOWN') {
    return 'No grade is available. The findings below are review prompts, not a clean result or a safety verdict.';
  }
  if (security.counts.critical > 0) {
    return 'Critical issues were reported. Resolve them before running this workflow.';
  }
  if (security.counts.high > 0) {
    return 'High-impact issues were reported. Review and resolve them before running this workflow.';
  }
  if (security.counts.medium > 0) {
    return 'This workflow has review items. Address the highest-priority item before relying on it.';
  }
  if (totalFindings > 0) {
    return 'No high-impact issue was reported, but the lower-severity findings still need review.';
  }
  if (security.grade !== 'LOW') {
    return 'The scanner assigned a review grade, but no individual findings were published. Treat the grade as a prompt for manual review.';
  }
  return 'No findings were reported by this scan. That is not proof of safety or of complete runtime coverage.';
}

function summaryNextStep(
  security: EntrySecurity,
  priorityFindings: PublicFinding[],
  analysisLabel: string,
): string {
  if (priorityFindings[0]) return priorityFindings[0].fix;
  if (security.noResult) {
    return 'Resolve the reported scanner limitation or review the workflow manually before importing it.';
  }
  if (security.stampReason === 'source_unavailable') {
    return 'Re-acquire the source workflow and run a fresh scan before relying on this summary.';
  }
  if (security.grade === 'UNKNOWN') {
    return 'Review the upstream workflow and obtain a fresh assessment before relying on it.';
  }
  if (analysisLabel !== 'Analysis complete') {
    return 'Review the unassessed behavior manually; an empty finding list does not prove safety.';
  }
  return 'Review credentials, permissions, and downstream write actions before importing this workflow.';
}
