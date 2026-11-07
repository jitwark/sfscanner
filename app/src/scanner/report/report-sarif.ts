import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sarifHelpUriFor, sarifTagsFor } from '@hub/scanner-core/report/sarif-tags';
import { buildSarifV2 } from '@hub/scanner-core/report/sarif-v2/output';
import type { ScanWorkflowResult } from '../engine';
import type { ScannerReportModelV2 } from '../scanner-v2-presentation';
import type { AnalysisDiagnostic, CanonicalScanFinding, ScanSeverity } from '@hub/scanner-core/policy';
import { evidenceEntries, remediationSteps, safeReportText } from './report-safe-content';

const severityOrder: Record<ScanSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

// Tags come from scanner-core so this emitter and the CLI's cannot diverge; the
// browser report had them and the CLI did not, which meant a finding kept its
// CWE where a person reads it and lost it where a machine does.

function attachedV2(scan: ScanWorkflowResult): ScannerReportModelV2 | undefined {
  const candidate = scan as unknown as Partial<ScannerReportModelV2>;
  return candidate.v2?.schemaVersion === 'scanner-result-v2' ? candidate as ScannerReportModelV2 : undefined;
}

/**
 * An attached v2 scan exports through the shared core builder the CLI uses, so the
 * browser file reports the worker's real status, diagnostics, findings and
 * assessment instead of the compatibility projection (which forces INDETERMINATE
 * and invents POLICY_EXECUTION_FAILED because no capability emits the v1 risk
 * summary). The run properties the browser export has always carried are
 * populated from the same v2 authority: the admitted builder carries no
 * assessment field of its own.
 */
export function buildSarifReport(scan: ScanWorkflowResult): string {
  const model = attachedV2(scan);
  if (!model) return buildLegacySarifReport(scan);
  const log = buildSarifV2({ input: { label: 'workflow.json' }, result: model.v2 });
  const [run] = log.runs;
  const assessment = model.assessment;
  return JSON.stringify({
    ...log,
    runs: [{
      ...run,
      properties: {
        ...(typeof run?.properties === 'object' && run.properties !== null ? run.properties : {}),
        analysisStatus: model.v2.analysis.status,
        ...(assessment ? { riskGrade: assessment.grade } : {}),
      },
    }],
  }, null, 2);
}

function buildLegacySarifReport(scan: ScanWorkflowResult): string {
  const findings = [...scan.findings].sort(compareFindings);
  const rules = Array.from(new Map(findings.map((finding) => [finding.policyId, finding])))
    .sort(([left], [right]) => compareText(left, right))
    .map(([, finding]) => {
      const tags = sarifTagsFor(finding.policyId);
      return {
        id: finding.policyId,
        helpUri: sarifHelpUriFor(finding.policyId),
        shortDescription: { text: safeReportText(finding.title) },
        fullDescription: { text: safeReportText(finding.explanation) },
        help: { text: safeReportText(finding.remediation) },
        properties: { policyEffect: finding.policyEffect, ...(tags ? { tags } : {}) },
      };
    });
  const diagnostics = [...scan.analysisDiagnostics].sort(compareDiagnostics);
  const properties: Record<string, unknown> = {
    analysisStatus: scan.analysisStatus,
    diagnosticCodes: diagnostics.map((diagnostic) => diagnostic.code),
    findingCount: scan.findings.length,
    ...(scan.analysisStatus !== 'INDETERMINATE' && scan.riskAssessment
      ? { riskGrade: scan.riskAssessment.grade }
      : {}),
  };

  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'SecureFlow local scanner', version: scan.scannerVersion, rules } },
      properties,
      invocations: [{
        executionSuccessful: true,
        toolExecutionNotifications: diagnostics.map(toNotification),
      }],
      results: findings.map(toResult),
    }],
  }, null, 2);
}

function toResult(finding: CanonicalScanFinding) {
  const location = finding.location.nodeName ?? finding.location.nodeId ?? finding.location.path;
  return {
    ruleId: finding.policyId,
    level: levelFor(finding.severity),
    message: { text: messageFor(finding) },
    ...(location ? { locations: [{ logicalLocations: [{ name: safeReportText(location), kind: 'node' }] }] } : {}),
    properties: {
      policyEffect: finding.policyEffect,
      severity: finding.severity,
      confidence: finding.confidence,
    },
    fingerprints: { 'secureflow/finding': findingFingerprint(finding) },
  };
}

function toNotification(diagnostic: AnalysisDiagnostic) {
  return {
    descriptor: { id: diagnostic.code },
    message: { text: `Analysis diagnostic ${diagnostic.code} (${diagnostic.category}).` },
    properties: {
      category: diagnostic.category,
      ...(diagnostic.location ? { location: safeLocation(diagnostic.location) } : {}),
    },
  };
}

function messageFor(finding: CanonicalScanFinding): string {
  const message = safeReportText(finding.message);
  return finding.policyEffect === 'REPORT_ONLY'
    ? `Advisory finding — does not change the risk grade. ${message}`
    : message;
}

function findingFingerprint(finding: CanonicalScanFinding): string {
  const projection = {
    policyId: finding.policyId,
    title: finding.title,
    severity: finding.severity,
    effect: finding.policyEffect,
    location: finding.location,
    evidence: evidenceEntries(finding.evidence),
    message: finding.message,
    remediation: finding.remediation,
    remediationSteps: remediationSteps(finding),
  };
  return bytesToHex(sha256(new TextEncoder().encode(`secureflow-report-v1:${stableSerialize(projection)}`)));
}

function compareFindings(left: CanonicalScanFinding, right: CanonicalScanFinding): number {
  return compareValues([severityOrder[left.severity]], [severityOrder[right.severity]]) ||
    compareText(stableSerialize(left), stableSerialize(right));
}

function compareDiagnostics(left: AnalysisDiagnostic, right: AnalysisDiagnostic): number {
  return compareText(stableSerialize(left), stableSerialize(right));
}

function compareValues(left: Array<number | string>, right: Array<number | string>): number {
  for (const [index, value] of left.entries()) {
    const other = right[index];
    if (value === other) continue;
    if (typeof value === 'number' && typeof other === 'number') return value < other ? -1 : 1;
    return String(value) < String(other) ? -1 : 1;
  }
  return 0;
}

function levelFor(severity: ScanSeverity): 'error' | 'warning' | 'note' {
  return severity === 'CRITICAL' || severity === 'HIGH' ? 'error' : severity === 'INFO' ? 'note' : 'warning';
}

function safeLocation(location: NonNullable<AnalysisDiagnostic['location']>) {
  return {
    ...(location.nodeName ? { nodeName: safeReportText(location.nodeName, 160) } : {}),
    ...(location.nodeId ? { nodeId: safeReportText(location.nodeId, 160) } : {}),
    ...(location.path ? { path: safeReportText(location.path, 240) } : {}),
  };
}

function stableSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return String(value);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
