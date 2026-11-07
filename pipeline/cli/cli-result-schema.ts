import { SUPPORTED_SCANNER_VERSIONS } from '../../packages/scanner-core/src/compat/v1-registry.js';
import type { CliSchemaError } from './cli-schema.js';

const DIAGNOSTIC_CODES = ['ANALYSIS_LIMIT_EXCEEDED', 'SOURCE_SPAN_UNAVAILABLE', 'DUPLICATE_JSON_KEY', 'MALFORMED_NODE_PARAMETERS', 'UNSUPPORTED_CODE_NODE_VARIANT', 'JAVASCRIPT_PARSE_FAILED', 'JAVASCRIPT_SOURCE_UNAVAILABLE', 'PYTHON_SOURCE_UNAVAILABLE', 'PYTHON_PARSE_FAILED', 'PYTHON_PARSER_UNAVAILABLE', 'EXPRESSION_PARSE_FAILED', 'POLICY_EXECUTION_FAILED', 'GRAPH_ANALYSIS_DEGRADED', 'DUPLICATE_FINDING_COLLAPSED', 'UNCLASSIFIED_CONNECTION_TYPE', 'MALFORMED_CONNECTION_INDEX', 'REQUIRED_STAGE_FAILURE'] as const;
const DIAGNOSTIC_CATEGORIES = ['LIMIT', 'SOURCE', 'PARSER', 'POLICY', 'GRAPH'] as const;
const BUSINESS_CATEGORIES = ['MANUAL_AUTOMATION', 'WEBHOOK_API', 'SCHEDULED_AUTOMATION', 'DATA_SYNC', 'NOTIFICATION', 'CUSTOM_LOGIC', 'GENERAL_AUTOMATION'] as const;
const INDETERMINATE_CODES = new Set(['MALFORMED_NODE_PARAMETERS', 'POLICY_EXECUTION_FAILED', 'REQUIRED_STAGE_FAILURE']);

export function validateRequiredScanResult(value: Record<string, unknown>, path: string, errors: CliSchemaError[]): void {
  exact(value.schemaVersion, 'scanner-result-v1', `${path}.schemaVersion`, errors);
  choice(value.scannerVersion, SUPPORTED_SCANNER_VERSIONS, `${path}.scannerVersion`, errors);
  choice(value.policyProfile, ['beta-default', 'beta-hardened'], `${path}.policyProfile`, errors);
  choice(value.analysisStatus, ['COMPLETE', 'DEGRADED', 'INDETERMINATE'], `${path}.analysisStatus`, errors);

  const diagnostics = array(value.analysisDiagnostics, `${path}.analysisDiagnostics`, errors);
  if (diagnostics) diagnostics.forEach((item, index) => validateDiagnostic(item, `${path}.analysisDiagnostics[${index}]`, errors));
  validateWorkflow(value.workflow, `${path}.workflow`, errors);
  validateFunctionSummary(value.functionSummary, `${path}.functionSummary`, errors);
  validateIntegrations(value.integrations, `${path}.integrations`, errors);
  const findings = array(value.findings, `${path}.findings`, errors);
  const status = value.analysisStatus;
  if (status === 'INDETERMINATE') {
    if (!diagnostics?.some((item) => record(item) && INDETERMINATE_CODES.has(String(item.code)))) add(errors, `${path}.analysisStatus`, 'VALUE', 'Indeterminate results require an indeterminate diagnostic.');
    for (const field of ['riskAssessment', 'humanSummary', 'summary']) if (value[field] !== undefined) add(errors, `${path}.${field}`, 'VALUE', 'Indeterminate results must omit completed assessment fields.');
  } else {
    if (status === 'COMPLETE' && diagnostics && diagnostics.length > 0) add(errors, `${path}.analysisDiagnostics`, 'VALUE', 'Complete results cannot contain diagnostics.');
    if (status === 'DEGRADED' && diagnostics?.length === 0) add(errors, `${path}.analysisDiagnostics`, 'VALUE', 'Degraded results require a diagnostic.');
    validateRisk(value.riskAssessment, `${path}.riskAssessment`, errors);
    validateHumanSummary(value.humanSummary, `${path}.humanSummary`, errors);
    const summary = validateResultSummary(value.summary, `${path}.summary`, errors);
    if (summary && findings) compareFindingCounts(findings, summary, `${path}.summary`, errors);
  }
}

function validateDiagnostic(value: unknown, path: string, errors: CliSchemaError[]): void {
  const raw = requiredRecord(value, path, errors); if (!raw) return;
  keys(raw, ['code', 'category', 'location'], path, errors);
  choice(raw.code, DIAGNOSTIC_CODES, `${path}.code`, errors); choice(raw.category, DIAGNOSTIC_CATEGORIES, `${path}.category`, errors);
  if (raw.location !== undefined) validateLocation(raw.location, `${path}.location`, errors);
}

function validateWorkflow(value: unknown, path: string, errors: CliSchemaError[]): void {
  const raw = requiredRecord(value, path, errors); if (!raw) return;
  keys(raw, ['name', 'nodeCount', 'rawNodeCount', 'annotationNodeCount', 'triggerCount', 'actionCount', 'integrationCount', 'connectionCount', 'payloadBytes', 'complexity', 'isSubWorkflow'], path, errors);
  if (raw.name !== null) text(raw.name, `${path}.name`, errors);
  for (const field of ['nodeCount', 'rawNodeCount', 'annotationNodeCount', 'triggerCount', 'actionCount', 'integrationCount', 'connectionCount', 'payloadBytes']) integer(raw[field], `${path}.${field}`, errors);
  choice(raw.complexity, ['LOW', 'MEDIUM', 'HIGH'], `${path}.complexity`, errors); booleanValue(raw.isSubWorkflow, `${path}.isSubWorkflow`, errors);
}

function validateFunctionSummary(value: unknown, path: string, errors: CliSchemaError[]): void {
  const raw = requiredRecord(value, path, errors); if (!raw) return;
  keys(raw, ['basicPurpose', 'triggerDescription', 'dataFlowSummary', 'businessCategory', 'confidence'], path, errors);
  for (const field of ['basicPurpose', 'triggerDescription', 'dataFlowSummary']) text(raw[field], `${path}.${field}`, errors);
  choice(raw.businessCategory, BUSINESS_CATEGORIES, `${path}.businessCategory`, errors); choice(raw.confidence, ['LOW', 'MEDIUM', 'HIGH'], `${path}.confidence`, errors);
}

function validateIntegrations(value: unknown, path: string, errors: CliSchemaError[]): void {
  const items = array(value, path, errors); if (!items) return;
  items.forEach((item, index) => {
    const itemPath = `${path}[${index}]`; const raw = requiredRecord(item, itemPath, errors); if (!raw) return;
    keys(raw, ['service', 'nodeTypes', 'nodeCount', 'usage', 'riskNotes'], itemPath, errors); text(raw.service, `${itemPath}.service`, errors); text(raw.usage, `${itemPath}.usage`, errors);
    strings(raw.nodeTypes, `${itemPath}.nodeTypes`, errors); integer(raw.nodeCount, `${itemPath}.nodeCount`, errors); strings(raw.riskNotes, `${itemPath}.riskNotes`, errors);
  });
}

function validateRisk(value: unknown, path: string, errors: CliSchemaError[]): void {
  const raw = requiredRecord(value, path, errors); if (!raw) return;
  keys(raw, ['score', 'grade', 'topRisks', 'dataExposure', 'complexityDrivers'], path, errors); integer(raw.score, `${path}.score`, errors, 100); choice(raw.grade, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], `${path}.grade`, errors); text(raw.dataExposure, `${path}.dataExposure`, errors); strings(raw.topRisks, `${path}.topRisks`, errors); strings(raw.complexityDrivers, `${path}.complexityDrivers`, errors);
}

function validateHumanSummary(value: unknown, path: string, errors: CliSchemaError[]): void {
  const raw = requiredRecord(value, path, errors); if (!raw) return;
  keys(raw, ['headline', 'verdict', 'plainLanguageOverview', 'riskNarrative', 'recommendedActions', 'findingHighlights'], path, errors);
  for (const field of ['headline', 'verdict', 'plainLanguageOverview', 'riskNarrative']) text(raw[field], `${path}.${field}`, errors);
  strings(raw.recommendedActions, `${path}.recommendedActions`, errors); strings(raw.findingHighlights, `${path}.findingHighlights`, errors);
}

function validateResultSummary(value: unknown, path: string, errors: CliSchemaError[]): Record<string, unknown> | null {
  const raw = requiredRecord(value, path, errors); if (!raw) return null;
  keys(raw, ['critical', 'high', 'medium', 'low', 'info'], path, errors);
  for (const field of ['critical', 'high', 'medium', 'low', 'info']) integer(raw[field], `${path}.${field}`, errors, 5_000);
  return raw;
}

function compareFindingCounts(findings: unknown[], summary: Record<string, unknown>, path: string, errors: CliSchemaError[]): void {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) if (record(finding) && typeof finding.severity === 'string' && counts[finding.severity.toLowerCase()] !== undefined) counts[finding.severity.toLowerCase()]! += 1;
  for (const [field, count] of Object.entries(counts)) if (summary[field] !== count) add(errors, `${path}.${field}`, 'COUNT', `Expected ${count}.`);
}

function validateLocation(value: unknown, path: string, errors: CliSchemaError[]): void {
  const raw = requiredRecord(value, path, errors); if (!raw) return;
  keys(raw, ['nodeId', 'nodeName', 'path', 'sourceSpan'], path, errors);
  for (const field of ['nodeId', 'nodeName', 'path']) if (raw[field] !== undefined) text(raw[field], `${path}.${field}`, errors);
  if (raw.sourceSpan !== undefined) validateSpan(raw.sourceSpan, `${path}.sourceSpan`, errors);
}

function validateSpan(value: unknown, path: string, errors: CliSchemaError[]): void {
  const raw = requiredRecord(value, path, errors); if (!raw) return;
  keys(raw, ['start', 'end'], path, errors); validatePosition(raw.start, `${path}.start`, errors); validatePosition(raw.end, `${path}.end`, errors);
}

function validatePosition(value: unknown, path: string, errors: CliSchemaError[]): void {
  const raw = requiredRecord(value, path, errors); if (!raw) return;
  keys(raw, ['line', 'column', 'offset'], path, errors); integer(raw.line, `${path}.line`, errors, 1); integer(raw.column, `${path}.column`, errors, 1); integer(raw.offset, `${path}.offset`, errors);
}

function requiredRecord(value: unknown, path: string, errors: CliSchemaError[]): Record<string, unknown> | null { if (!record(value)) { add(errors, path, 'TYPE', 'Expected an object.'); return null; } return value; }
function array(value: unknown, path: string, errors: CliSchemaError[]): unknown[] | null { if (!Array.isArray(value)) { add(errors, path, 'TYPE', 'Expected an array.'); return null; } return value; }
function strings(value: unknown, path: string, errors: CliSchemaError[]): void { const items = array(value, path, errors); if (items) items.forEach((item, index) => text(item, `${path}[${index}]`, errors)); }
function text(value: unknown, path: string, errors: CliSchemaError[]): void { if (typeof value !== 'string' || value.length === 0) add(errors, path, typeof value === 'string' ? 'VALUE' : 'TYPE', 'Expected a non-empty string.'); }
function integer(value: unknown, path: string, errors: CliSchemaError[], maximum = Number.MAX_SAFE_INTEGER): void { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) add(errors, path, 'VALUE', 'Expected a non-negative safe integer.'); }
function booleanValue(value: unknown, path: string, errors: CliSchemaError[]): void { if (typeof value !== 'boolean') add(errors, path, 'TYPE', 'Expected a boolean.'); }
function exact(value: unknown, expected: string, path: string, errors: CliSchemaError[]): void { if (value !== expected) add(errors, path, typeof value === 'string' ? 'VALUE' : 'TYPE', `Expected ${expected}.`); }
function choice(value: unknown, values: readonly string[], path: string, errors: CliSchemaError[]): void { if (!values.includes(value as string)) add(errors, path, typeof value === 'string' ? 'VALUE' : 'TYPE', `Expected one of ${values.join(', ')}.`); }
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string, errors: CliSchemaError[]): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) add(errors, `${path}.${key}`, 'UNKNOWN', 'Field is not part of this contract.'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) && !Object.keys(value as object).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key)); }
function add(errors: CliSchemaError[], path: string, code: CliSchemaError['code'], message: string): void { errors.push({ path, code, message }); }
