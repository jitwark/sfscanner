import { record } from '@hub/contracts/artifact-validation';
import { parseScannerResultSchemaVersion } from '@hub/contracts';
import { SCANNER_VERSION } from '@hub/scanner-core/scanner-version';
import {
  isAnalysisDiagnosticCategoryValue,
  isAnalysisDiagnosticCodeValue,
} from '@hub/scanner-core/policy';
import { classifyAnalysisStatus } from '@hub/scanner-core/result/analysis-completeness';
import type { ScanWorkflowResult } from './engine';

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
const GRADES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const COMPLEXITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
const BUSINESS_CATEGORIES = ['MANUAL_AUTOMATION', 'WEBHOOK_API', 'SCHEDULED_AUTOMATION', 'DATA_SYNC', 'NOTIFICATION', 'CUSTOM_LOGIC', 'GENERAL_AUTOMATION'] as const;
const CONFIDENCE = ['LOW', 'MEDIUM', 'HIGH'] as const;
const MAX_ITEMS = 5_000;
const MAX_STRING = 262_144;
const MAX_NUMBER = 10_000_000;

function object(value: unknown): Record<string, unknown> | null { return record(value); }
function string(value: unknown, max = MAX_STRING): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function optionalString(value: unknown, max = MAX_STRING): boolean { return value === undefined || string(value, max); }
function integer(value: unknown, max = MAX_NUMBER): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max; }
function choice(value: unknown, values: readonly string[]): boolean { return typeof value === 'string' && values.includes(value); }
function strings(value: unknown, max = MAX_ITEMS): value is string[] { return Array.isArray(value) && value.length <= max && value.every((item) => string(item, 4_096)); }
function validScannerResultSchema(value: unknown): boolean {
  try { parseScannerResultSchemaVersion(value); return true; } catch { return false; }
}

function safeValue(value: unknown, depth = 0): boolean {
  if (depth > 32 || value === null || typeof value === 'boolean' || typeof value === 'number') return value === null || typeof value !== 'number' || Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_STRING;
  if (Array.isArray(value)) return value.length <= MAX_ITEMS && value.every((item) => safeValue(item, depth + 1));
  const raw = object(value);
  return raw !== null && Object.keys(raw).length <= MAX_ITEMS && Object.values(raw).every((item) => safeValue(item, depth + 1));
}

function validPosition(value: unknown): boolean {
  const raw = object(value); return raw !== null && integer(raw.line, MAX_NUMBER) && integer(raw.column, MAX_NUMBER) && integer(raw.offset, MAX_NUMBER);
}
function validLocation(value: unknown): boolean {
  const raw = object(value); if (!raw) return false;
  return optionalString(raw.nodeId, 512) && optionalString(raw.nodeName, 512) && optionalString(raw.path, 4_096) &&
    (raw.sourceSpan === undefined || (object(raw.sourceSpan) !== null && validPosition(object(raw.sourceSpan)!.start) && validPosition(object(raw.sourceSpan)!.end)));
}
function validDiagnostic(value: unknown): boolean {
  const raw = object(value); return raw !== null && isAnalysisDiagnosticCodeValue(raw.code) && isAnalysisDiagnosticCategoryValue(raw.category) && (raw.location === undefined || validLocation(raw.location));
}
function validFinding(value: unknown): boolean {
  const raw = object(value); return raw !== null && string(raw.policyId, 512) && string(raw.title) && choice(raw.severity, SEVERITIES) && validLocation(raw.location) && object(raw.evidence) !== null && safeValue(raw.evidence) &&
    string(raw.message) && string(raw.explanation) && string(raw.whyItMatters) && string(raw.possibleImpact) && string(raw.remediation) && strings(raw.remediationSteps, 100) && choice(raw.confidence, CONFIDENCE) && choice(raw.policyEffect, ['LEGACY_SCORE', 'REPORT_ONLY']);
}
function validWorkflow(value: unknown): boolean {
  const raw = object(value); return raw !== null && (raw.name === null || string(raw.name, 4_096)) && integer(raw.nodeCount) && integer(raw.rawNodeCount) && integer(raw.annotationNodeCount) && integer(raw.triggerCount) && integer(raw.actionCount) && integer(raw.integrationCount) && integer(raw.connectionCount) && integer(raw.payloadBytes, 50_000_000) && choice(raw.complexity, COMPLEXITIES) && typeof raw.isSubWorkflow === 'boolean';
}
function validFunctionSummary(value: unknown): boolean {
  const raw = object(value); return raw !== null && string(raw.basicPurpose) && string(raw.triggerDescription) && string(raw.dataFlowSummary) && choice(raw.businessCategory, BUSINESS_CATEGORIES) && choice(raw.confidence, CONFIDENCE);
}
function validIntegration(value: unknown): boolean {
  const raw = object(value); return raw !== null && string(raw.service, 512) && strings(raw.nodeTypes, 100) && integer(raw.nodeCount) && string(raw.usage) && strings(raw.riskNotes, 100);
}
function validRisk(value: unknown): boolean {
  const raw = object(value); return raw !== null && integer(raw.score, 100) && choice(raw.grade, GRADES) && strings(raw.topRisks, 100) && string(raw.dataExposure) && strings(raw.complexityDrivers, 100);
}
function validHumanSummary(value: unknown): boolean {
  const raw = object(value); return raw !== null && string(raw.headline) && string(raw.verdict) && string(raw.plainLanguageOverview) && string(raw.riskNarrative) && strings(raw.recommendedActions, 100) && strings(raw.findingHighlights, 100);
}
function validSummary(value: unknown): boolean {
  const raw = object(value); return raw !== null && integer(raw.critical, MAX_ITEMS) && integer(raw.high, MAX_ITEMS) && integer(raw.medium, MAX_ITEMS) && integer(raw.low, MAX_ITEMS) && integer(raw.info, MAX_ITEMS);
}

function summaryMatchesFindings(value: Record<string, unknown>): boolean {
  const findings = value.findings; const summary = object(value.summary);
  if (!Array.isArray(findings) || !summary) return false;
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) { const severity = object(finding)?.severity; if (typeof severity !== 'string') return false; counts[severity.toLowerCase() as keyof typeof counts] += 1; }
  return Object.entries(counts).every(([key, count]) => summary[key] === count);
}

/** Validates the structured result crossing from the scanner worker to the UI. */
export function parseScanWorkflowResult(value: unknown): ScanWorkflowResult | null {
  const raw = object(value); if (!raw || !validScannerResultSchema(raw.schemaVersion) || raw.scannerVersion !== SCANNER_VERSION || !choice(raw.policyProfile, ['beta-default', 'beta-hardened']) || !choice(raw.analysisStatus, ['COMPLETE', 'DEGRADED', 'INDETERMINATE'])) return null;
  if (!Array.isArray(raw.analysisDiagnostics) || raw.analysisDiagnostics.length > MAX_ITEMS || !raw.analysisDiagnostics.every(validDiagnostic) || !validWorkflow(raw.workflow) || !validFunctionSummary(raw.functionSummary) || !Array.isArray(raw.integrations) || raw.integrations.length > MAX_ITEMS || !raw.integrations.every(validIntegration) || !Array.isArray(raw.findings) || raw.findings.length > MAX_ITEMS || !raw.findings.every(validFinding)) return null;
  if (raw.riskAssessment !== undefined && !validRisk(raw.riskAssessment)) return null;
  if (raw.humanSummary !== undefined && !validHumanSummary(raw.humanSummary)) return null;
  if (raw.summary !== undefined && (!validSummary(raw.summary) || !summaryMatchesFindings(raw))) return null;
  if (raw.analysisStatus === 'INDETERMINATE' && (raw.riskAssessment !== undefined || raw.humanSummary !== undefined || raw.summary !== undefined)) return null;
  if (raw.analysisStatus !== 'INDETERMINATE' && (raw.riskAssessment === undefined || raw.humanSummary === undefined || raw.summary === undefined)) return null;
  if (classifyAnalysisStatus(raw.analysisDiagnostics as never[]) !== raw.analysisStatus) return null;
  return raw as unknown as ScanWorkflowResult;
}
