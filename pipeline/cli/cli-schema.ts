import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { validateRequiredScanResult } from './cli-result-schema.js';
const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
const LEVELS = ['error', 'warning', 'note'] as const;
const ERROR_KINDS = ['input', 'internal', 'cancelled'] as const;
const FINDING_KEYS = ['policyId', 'title', 'severity', 'location', 'evidence', 'message', 'explanation', 'whyItMatters', 'possibleImpact', 'remediation', 'remediationSteps', 'confidence', 'policyEffect'];
const SCAN_RESULT_KEYS = ['schemaVersion', 'scannerVersion', 'policyProfile', 'analysisStatus', 'analysisDiagnostics', 'workflow', 'functionSummary', 'integrations', 'findings', 'riskAssessment', 'humanSummary', 'summary'];
export type CliSchemaError = { path: string; code: 'TYPE' | 'VALUE' | 'COUNT' | 'ORDER' | 'REFERENCE' | 'UNKNOWN'; message: string };
export type CliSchemaValidation = { ok: true } | { ok: false; errors: CliSchemaError[] };
export function validateCliJsonDocument(value: unknown): CliSchemaValidation {
  const errors: CliSchemaError[] = [];
  if (!record(value)) return invalid(errors, '$', 'TYPE', 'Document must be an object.');
  keys(value, ['schemaVersion', 'results', 'summary'], '$', errors);
  if (value.schemaVersion !== 'scanner-cli-v1') add(errors, 'schemaVersion', 'VALUE', 'Expected scanner-cli-v1.');
  const results = value.results;
  if (!Array.isArray(results)) add(errors, 'results', 'TYPE', 'Results must be an array.');
  else {
    let previousInput: string | undefined;
    results.forEach((item, index) => {
      validateItem(item, `results[${index}]`, errors);
      if (record(item) && typeof item.input === 'string') {
        if (previousInput !== undefined && compareCanonicalStrings(previousInput, item.input) > 0) add(errors, 'results', 'ORDER', 'Results must be canonically sorted by input.');
        previousInput = item.input;
      }
    });
  }
  const summary = value.summary;
  if (!record(summary)) add(errors, 'summary', 'TYPE', 'Summary must be an object.');
  else validateSummary(summary, results, errors);
  return finish(errors);
}
export function validateSarifDocument(value: unknown): CliSchemaValidation {
  const errors: CliSchemaError[] = [];
  if (!record(value)) return invalid(errors, '$', 'TYPE', 'SARIF document must be an object.');
  keys(value, ['$schema', 'version', 'runs'], '$', errors);
  if (value.version !== '2.1.0') add(errors, 'version', 'VALUE', 'Expected SARIF version 2.1.0.');
  if (value.$schema !== SARIF_SCHEMA) add(errors, '$schema', 'VALUE', 'Expected the SARIF 2.1.0 schema URI.');
  if (!Array.isArray(value.runs) || value.runs.length === 0) add(errors, 'runs', 'VALUE', 'SARIF must contain at least one run.');
  else value.runs.forEach((run, index) => validateRun(run, `runs[${index}]`, errors));
  return finish(errors);
}
function validateItem(value: unknown, path: string, errors: CliSchemaError[]): void {
  if (!record(value)) return add(errors, path, 'TYPE', 'Result item must be an object.');
  keys(value, ['input', 'ok', 'result', 'error'], path, errors);
  text(value.input, `${path}.input`, errors, true);
  if (value.ok === true) {
    if (value.error !== undefined) add(errors, `${path}.error`, 'UNKNOWN', 'Successful items cannot contain error.');
    if (!record(value.result)) return add(errors, `${path}.result`, 'TYPE', 'Successful items need a result object.');
    validateScanResult(value.result, `${path}.result`, errors);
    if (!Array.isArray(value.result.findings)) add(errors, `${path}.result.findings`, 'TYPE', 'Result findings must be an array.');
    else value.result.findings.forEach((finding, index) => validateFinding(finding, `${path}.result.findings[${index}]`, errors));
  } else if (value.ok === false) {
    if (value.result !== undefined) add(errors, `${path}.result`, 'UNKNOWN', 'Failed items cannot contain result.');
    validateError(value.error, `${path}.error`, errors);
  } else add(errors, `${path}.ok`, 'TYPE', 'Result item ok must be boolean.');
}
function validateScanResult(value: Record<string, unknown>, path: string, errors: CliSchemaError[]): void {
  keys(value, SCAN_RESULT_KEYS, path, errors);
  validateRequiredScanResult(value, path, errors);
}
function validateSummary(summary: Record<string, unknown>, results: unknown, errors: CliSchemaError[]): void {
  const fields = ['total', 'completed', 'inputErrors', 'internalErrors', 'cancelled', 'findings'];
  keys(summary, fields, 'summary', errors);
  fields.forEach((field) => integer(summary[field], `summary.${field}`, errors));
  if (!Array.isArray(results)) return;
  const expected = {
    total: results.length,
    completed: results.filter((item) => record(item) && item.ok === true).length,
    inputErrors: results.filter((item) => hasKind(item, 'input')).length,
    internalErrors: results.filter((item) => hasKind(item, 'internal')).length,
    cancelled: results.filter((item) => hasKind(item, 'cancelled')).length,
    findings: results.reduce((count, item) => count + (record(item) && item.ok === true && record(item.result) && Array.isArray(item.result.findings) ? item.result.findings.length : 0), 0),
  };
  fields.forEach((field) => { if (summary[field] !== expected[field as keyof typeof expected]) add(errors, `summary.${field}`, 'COUNT', `Expected ${expected[field as keyof typeof expected]}.`); });
}
function validateFinding(value: unknown, path: string, errors: CliSchemaError[]): void {
  if (!record(value)) return add(errors, path, 'TYPE', 'Finding must be an object.');
  keys(value, FINDING_KEYS, path, errors);
  for (const field of ['policyId', 'title', 'message', 'explanation', 'whyItMatters', 'possibleImpact', 'remediation']) text(value[field], `${path}.${field}`, errors, true);
  choice(value.severity, SEVERITIES, `${path}.severity`, errors);
  choice(value.confidence, ['LOW', 'MEDIUM', 'HIGH'], `${path}.confidence`, errors);
  choice(value.policyEffect, ['LEGACY_SCORE', 'REPORT_ONLY'], `${path}.policyEffect`, errors);
  if (!record(value.evidence)) add(errors, `${path}.evidence`, 'TYPE', 'Evidence must be an object.');
  if (!Array.isArray(value.remediationSteps)) add(errors, `${path}.remediationSteps`, 'TYPE', 'Remediation steps must be an array.');
  else value.remediationSteps.forEach((step, index) => text(step, `${path}.remediationSteps[${index}]`, errors, false));
  validateLocation(value.location, `${path}.location`, errors);
}
function validateLocation(value: unknown, path: string, errors: CliSchemaError[]): void {
  if (!record(value)) return add(errors, path, 'TYPE', 'Location must be an object.');
  keys(value, ['nodeId', 'nodeName', 'path', 'sourceSpan'], path, errors);
  for (const field of ['nodeId', 'nodeName', 'path']) if (value[field] !== undefined) text(value[field], `${path}.${field}`, errors, false);
  if (value.sourceSpan !== undefined) validateSpan(value.sourceSpan, `${path}.sourceSpan`, errors);
}
function validateSpan(value: unknown, path: string, errors: CliSchemaError[]): void {
  if (!record(value)) return add(errors, path, 'TYPE', 'Source span must be an object.');
  keys(value, ['start', 'end'], path, errors);
  validatePosition(value.start, `${path}.start`, errors);
  validatePosition(value.end, `${path}.end`, errors);
  if (record(value.start) && record(value.end) && integerValue(value.start.offset) && integerValue(value.end.offset) && (value.end.offset < value.start.offset || (integerValue(value.start.line) && integerValue(value.end.line) && value.end.line < value.start.line) || (value.end.line === value.start.line && integerValue(value.start.column) && integerValue(value.end.column) && value.end.column < value.start.column))) add(errors, `${path}.end`, 'VALUE', 'End position cannot precede start position.');
}
function validatePosition(value: unknown, path: string, errors: CliSchemaError[]): void {
  if (!record(value)) return add(errors, path, 'TYPE', 'Source position must be an object.');
  keys(value, ['line', 'column', 'offset'], path, errors);
  integer(value.line, `${path}.line`, errors, 1);
  integer(value.column, `${path}.column`, errors, 1);
  integer(value.offset, `${path}.offset`, errors, 0);
}
function validateError(value: unknown, path: string, errors: CliSchemaError[]): void {
  if (!record(value)) return add(errors, path, 'TYPE', 'Error item needs an error object.');
  keys(value, ['kind', 'code', 'message'], path, errors);
  choice(value.kind, ERROR_KINDS, `${path}.kind`, errors);
  text(value.code, `${path}.code`, errors, true);
  text(value.message, `${path}.message`, errors, true);
}
function validateRun(value: unknown, path: string, errors: CliSchemaError[]): void {
  if (!record(value)) return add(errors, path, 'TYPE', 'SARIF run must be an object.');
  keys(value, ['tool', 'results', 'invocations'], path, errors);
  const driver = record(value.tool) && record(value.tool.driver) ? value.tool.driver : undefined;
  if (!driver) add(errors, `${path}.tool.driver`, 'TYPE', 'Run tool.driver is required.');
  else validateDriver(driver, `${path}.tool.driver`, errors);
  if (!Array.isArray(value.results)) add(errors, `${path}.results`, 'TYPE', 'Run results must be an array.');
  else value.results.forEach((result, index) => validateSarifResult(result, `${path}.results[${index}]`, driver, errors));
  if (!Array.isArray(value.invocations)) add(errors, `${path}.invocations`, 'TYPE', 'Run invocations must be an array.');
  else value.invocations.forEach((invocation, index) => validateInvocation(invocation, `${path}.invocations[${index}]`, errors));
}
function validateDriver(value: Record<string, unknown>, path: string, errors: CliSchemaError[]): void {
  keys(value, ['name', 'version', 'informationUri', 'rules'], path, errors);
  text(value.name, `${path}.name`, errors, true); text(value.version, `${path}.version`, errors, true);
  if (value.informationUri !== undefined) text(value.informationUri, `${path}.informationUri`, errors, true);
  if (!Array.isArray(value.rules)) return add(errors, `${path}.rules`, 'TYPE', 'Driver rules must be an array.');
  let previous: string | undefined; const ids = new Set<string>();
  value.rules.forEach((rule, index) => {
    const rulePath = `${path}.rules[${index}]`;
    if (!record(rule)) return add(errors, rulePath, 'TYPE', 'Rule must be an object.');
    keys(rule, ['id', 'shortDescription'], rulePath, errors); text(rule.id, `${rulePath}.id`, errors, true);
    if (typeof rule.id === 'string') { if (ids.has(rule.id)) add(errors, `${rulePath}.id`, 'VALUE', 'Rule IDs must be unique.'); if (previous !== undefined && compareCanonicalStrings(previous, rule.id) > 0) add(errors, `${path}.rules`, 'ORDER', 'Rule IDs must be canonically sorted.'); previous = rule.id; ids.add(rule.id); }
    if (!record(rule.shortDescription)) add(errors, `${rulePath}.shortDescription`, 'TYPE', 'Rule shortDescription is required.'); else { keys(rule.shortDescription, ['text'], `${rulePath}.shortDescription`, errors); text(rule.shortDescription.text, `${rulePath}.shortDescription.text`, errors, true); }
  });
}
function validateSarifResult(value: unknown, path: string, driver: Record<string, unknown> | undefined, errors: CliSchemaError[]): void {
  if (!record(value)) return add(errors, path, 'TYPE', 'SARIF result must be an object.');
  keys(value, ['ruleId', 'level', 'message', 'locations'], path, errors);
  text(value.ruleId, `${path}.ruleId`, errors, true);
  if (typeof value.ruleId === 'string' && record(driver) && Array.isArray(driver.rules) && !driver.rules.some((rule) => record(rule) && rule.id === value.ruleId)) add(errors, `${path}.ruleId`, 'REFERENCE', 'Result ruleId must be declared by the tool.');
  choice(value.level, LEVELS, `${path}.level`, errors);
  if (!record(value.message)) add(errors, `${path}.message`, 'TYPE', 'Result message is required.'); else { keys(value.message, ['text'], `${path}.message`, errors); text(value.message.text, `${path}.message.text`, errors, true); }
  if (value.locations !== undefined) { if (!Array.isArray(value.locations) || value.locations.length !== 1) add(errors, `${path}.locations`, 'VALUE', 'A result location must contain exactly one source location.'); else validateSarifLocation(value.locations[0], `${path}.locations[0]`, errors); }
}
function validateSarifLocation(value: unknown, path: string, errors: CliSchemaError[]): void {
  if (!record(value) || !record(value.physicalLocation)) return add(errors, path, 'TYPE', 'SARIF location needs physicalLocation.');
  keys(value, ['physicalLocation'], path, errors); const physical = value.physicalLocation;
  keys(physical, ['artifactLocation', 'region'], `${path}.physicalLocation`, errors);
  if (!record(physical.artifactLocation)) add(errors, `${path}.physicalLocation.artifactLocation`, 'TYPE', 'Artifact location is required.'); else { keys(physical.artifactLocation, ['uri'], `${path}.physicalLocation.artifactLocation`, errors); text(physical.artifactLocation.uri, `${path}.physicalLocation.artifactLocation.uri`, errors, true); }
  if (!record(physical.region)) add(errors, `${path}.physicalLocation.region`, 'TYPE', 'Source region is required.'); else { const region = physical.region; keys(region, ['startLine', 'startColumn', 'endLine', 'endColumn', 'charOffset', 'charLength'], `${path}.physicalLocation.region`, errors); for (const field of ['startLine', 'startColumn', 'endLine', 'endColumn']) integer(region[field], `${path}.physicalLocation.region.${field}`, errors, 1); for (const field of ['charOffset', 'charLength']) integer(region[field], `${path}.physicalLocation.region.${field}`, errors, 0); if (regionEndPrecedesStart(region)) add(errors, `${path}.physicalLocation.region`, 'VALUE', 'Region end cannot precede region start.'); }
}
function regionEndPrecedesStart(region: Record<string, unknown>): boolean {
  return integerValue(region.startLine) && integerValue(region.startColumn) && integerValue(region.endLine) && integerValue(region.endColumn) &&
    (region.endLine < region.startLine || (region.endLine === region.startLine && region.endColumn < region.startColumn));
}
function validateInvocation(value: unknown, path: string, errors: CliSchemaError[]): void {
  if (!record(value)) return add(errors, path, 'TYPE', 'SARIF invocation must be an object.');
  keys(value, ['executionSuccessful', 'toolExecutionNotifications'], path, errors);
  if (typeof value.executionSuccessful !== 'boolean') add(errors, `${path}.executionSuccessful`, 'TYPE', 'executionSuccessful must be boolean.');
  if (!Array.isArray(value.toolExecutionNotifications)) return add(errors, `${path}.toolExecutionNotifications`, 'TYPE', 'Tool execution notifications must be an array.');
  if (value.executionSuccessful === true && value.toolExecutionNotifications.length > 0) add(errors, `${path}.executionSuccessful`, 'VALUE', 'A successful invocation cannot carry diagnostics.');
  let previous: string | undefined;
  value.toolExecutionNotifications.forEach((notification, index) => {
    const itemPath = `${path}.toolExecutionNotifications[${index}]`;
    if (!record(notification)) return add(errors, itemPath, 'TYPE', 'Notification must be an object.');
    keys(notification, ['descriptor', 'message', 'properties'], itemPath, errors);
    if (!record(notification.descriptor)) add(errors, `${itemPath}.descriptor`, 'TYPE', 'Notification descriptor is required.'); else { keys(notification.descriptor, ['id'], `${itemPath}.descriptor`, errors); text(notification.descriptor.id, `${itemPath}.descriptor.id`, errors, true); }
    if (!record(notification.message)) add(errors, `${itemPath}.message`, 'TYPE', 'Notification message is required.'); else { keys(notification.message, ['text'], `${itemPath}.message`, errors); text(notification.message.text, `${itemPath}.message.text`, errors, true); }
    if (!record(notification.properties)) add(errors, `${itemPath}.properties`, 'TYPE', 'Notification properties are required.'); else { keys(notification.properties, ['input', 'kind', 'code'], `${itemPath}.properties`, errors); text(notification.properties.input, `${itemPath}.properties.input`, errors, true); choice(notification.properties.kind, ERROR_KINDS, `${itemPath}.properties.kind`, errors); text(notification.properties.code, `${itemPath}.properties.code`, errors, true); }
    const current = record(notification.properties) ? `${String(notification.properties.input)}\0${String(notification.properties.kind)}\0${String(notification.properties.code)}\0${record(notification.message) ? String(notification.message.text) : ''}` : '';
    if (previous !== undefined && compareCanonicalStrings(previous, current) > 0) add(errors, `${path}.toolExecutionNotifications`, 'ORDER', 'Notifications must be canonically sorted.'); previous = current;
  });
}
function hasKind(value: unknown, kind: string): boolean { return record(value) && value.ok === false && record(value.error) && value.error.kind === kind; }
function record(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) && !Object.keys(value as object).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key)); }
function text(value: unknown, path: string, errors: CliSchemaError[], nonEmpty: boolean): void { if (typeof value !== 'string' || (nonEmpty && value.length === 0)) add(errors, path, typeof value === 'string' ? 'VALUE' : 'TYPE', 'Expected a string.'); }
function integer(value: unknown, path: string, errors: CliSchemaError[], minimum = 0): void { if (!integerValue(value) || value < minimum) add(errors, path, 'VALUE', `Expected an integer >= ${minimum}.`); }
function integerValue(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value); }
function choice(value: unknown, values: readonly string[], path: string, errors: CliSchemaError[]): void { if (!values.includes(value as string)) add(errors, path, 'VALUE', `Expected one of ${values.join(', ')}.`); }
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string, errors: CliSchemaError[]): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) add(errors, `${path}.${key}`, 'UNKNOWN', 'Field is not part of this contract.'); }
function add(errors: CliSchemaError[], path: string, code: CliSchemaError['code'], message: string): void { errors.push({ path, code, message }); }
function invalid(errors: CliSchemaError[], path: string, code: CliSchemaError['code'], message: string): CliSchemaValidation { add(errors, path, code, message); return { ok: false, errors }; }
function finish(errors: CliSchemaError[]): CliSchemaValidation { return errors.length === 0 ? { ok: true } : { ok: false, errors }; }
