import type { ScanWorkflowResult } from '../engine';
import { redactEvidence, redactText } from '@hub/scanner-core/redaction';
import type { CanonicalScanFinding } from '@hub/scanner-core/policy';

export const MAX_REPORT_TEXT_CHARS = 320;
export const MAX_EVIDENCE_ENTRIES = 8;
export const MAX_REMEDIATION_STEPS = 5;
export const MAX_REMEDIATION_ACTIONS = 6;

// Evidence is an internal, open-ended record. Keep report presentation on a
// closed vocabulary so a future policy cannot accidentally make raw workflow
// JSON or source text visible by choosing a descriptive string key.
const SAFE_EVIDENCE_KEYS = new Set([
  'nodeType', 'present', 'parameterPath', 'secretKind', 'indicator', 'hasLiteralValue',
  'header', 'domain', 'nodePackage', 'authentication', 'member', 'start', 'end',
  'sink', 'referenceRoot', 'propertyPath', 'propertyPathComplete', 'taintLabels',
  'sourceNodeId', 'sourceNodeName', 'traceLength', 'tracePath', 'toolCount',
  'contextCount', 'humanGatePresent', 'humanGateDominates',
]);

export type ReportEvidenceEntry = {
  label: string;
  value: string;
};

export function safeReportText(value: string, max = MAX_REPORT_TEXT_CHARS): string {
  const redacted = redactText(value);
  return redacted.length <= max ? redacted : `${redacted.slice(0, Math.max(1, max - 1))}…`;
}

export function evidenceEntries(evidence: Record<string, unknown>): ReportEvidenceEntry[] {
  const redacted = redactEvidence(evidence) as Record<string, unknown>;
  return Object.entries(redacted)
    .filter(([key]) => SAFE_EVIDENCE_KEYS.has(key))
    .sort(([left], [right]) => compareText(left, right))
    .slice(0, MAX_EVIDENCE_ENTRIES)
    .map(([key, value]) => ({
      label: safeReportText(formatKey(key), 80),
      value: formatEvidenceValue(value),
    }));
}

export function remediationSteps(finding: CanonicalScanFinding): string[] {
  return uniqueSafeText(finding.remediationSteps, MAX_REMEDIATION_STEPS);
}

export function remediationActions(scan: ScanWorkflowResult): string[] {
  return uniqueSafeText([
    ...(scan.humanSummary?.recommendedActions ?? []),
    ...scan.findings.flatMap((finding) => [finding.remediation, ...finding.remediationSteps]),
  ], MAX_REMEDIATION_ACTIONS);
}

function uniqueSafeText(values: string[], max: number): string[] {
  return Array.from(new Set(values
    .filter((value) => value.trim().length > 0)
    .map((value) => safeReportText(value))))
    .slice(0, max);
}

function formatEvidenceValue(value: unknown): string {
  if (value === null) return 'Not present';
  if (typeof value === 'string') return safeReportText(value, MAX_REPORT_TEXT_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return 'Structured details withheld';
}

function formatKey(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
