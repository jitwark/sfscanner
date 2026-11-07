import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SCANNER_LIMITS, LIMITS, SCANNER_RESULT_SCHEMA_VERSION, toWorkflowParseOptions } from '@hub/contracts';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import { SCANNER_VERSION } from '../packages/scanner-core/src/scanner-version.ts';
import { scannerParityFixtures } from '../app/src/scanner/__fixtures__/scanner-parity.js';
import { scanWorkflow } from '../app/src/scanner/engine.js';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { runCli } from '../pipeline/cli/cli-runner.js';
import { scanCandidate } from '../pipeline/scan/scan-entry.js';
export const PARITY_PROFILES = Object.freeze(['beta-default', 'beta-hardened']);
const PARSE_OPTIONS = toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS);
const PIPELINE_SCANNER_VERSION = SCANNER_VERSION;
const SEVERITY_ORDER = Object.freeze({ CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 });
const SECRET_KEY = /(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|credential|authorization|cookie|private[-_ ]?key|secret)/i;
const SECRET_VALUE = [ /\bsk_(?:live|test)_[A-Za-z0-9][A-Za-z0-9_-]{7,}\b/, /\b(?:ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/, /^Bearer\s+[A-Za-z0-9._~+/=-]{12,}$/i, /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/ ];

export function canonicalWire(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('value is not JSON-serializable');
  return canonicalizeJson(JSON.parse(serialized));
}
export function findSecretLikeFixtureValues(fixture) {
  let parsed; try { parsed = JSON.parse(fixture.json); } catch { return []; }
  const values = new Set();
  const visit = (value, key) => {
    if (typeof value === 'string') {
      const candidate = value.trim();
      if (candidate.length >= 8 && ((key && SECRET_KEY.test(key)) || SECRET_VALUE.some((pattern) => pattern.test(candidate)))) values.add(candidate);
      return;
    }
    if (Array.isArray(value)) return value.forEach((child) => visit(child, key));
    if (isRecord(value)) for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  visit(parsed, undefined); return [...values];
}
export function validateSecretGuard(fixture, emitted, label) {
  let serialized;
  try { serialized = JSON.stringify(emitted); } catch { serialized = undefined; }
  if (serialized === undefined) return { ok: false, errors: [`${fixture.id} ${label} output is not serializable`] };
  const errors = findSecretLikeFixtureValues(fixture).filter((secret) => serialized.includes(secret)).map(() => `${fixture.id} ${label} output contains a secret-like fixture value`);
  return verdict(errors);
}
export function validateValidParity({ fixture, profile, browserResult, cliRun }) {
  const context = `${fixture.id} [${profile}]`;
  const errors = [...validateSecretGuard(fixture, browserResult, 'browser').errors, ...validateSecretGuard(fixture, cliRun, 'CLI').errors];
  const cli = readCliDocument(cliRun, context, errors);
  if (cliRun?.exitCode !== 0) errors.push(`${context} expected CLI exit code 0, received ${String(cliRun?.exitCode)}`);
  const item = cli?.results[0];
  if (!item || item.input !== '-' || item.ok !== true || !('result' in item)) errors.push(`${context} CLI did not return one successful result`);
  else { try { if (canonicalWire(browserResult) !== canonicalWire(item.result)) errors.push(`${context} browser/CLI result mismatch`); } catch { errors.push(`${context} result could not be canonicalized`); } }
  return verdict(errors);
}
export function projectBrowserEntrySecurity(defaultResult, hardenedResult) {
  const rawFindings = Array.isArray(defaultResult?.findings) ? defaultResult.findings : [];
  const findings = rawFindings.map(projectBrowserFinding).sort(comparePublicFindings).slice(0, LIMITS.maxPublicFindings);
  const findingKey = (finding) => {
    const location = isRecord(finding?.location) ? finding.location : {};
    return `${finding?.policyId}:${location.nodeName ?? location.nodeId ?? ''}`;
  };
  const defaultKeys = new Set(rawFindings.map(findingKey));
  const hardenedExtra = (Array.isArray(hardenedResult?.findings) ? hardenedResult.findings : []).filter((finding) => !defaultKeys.has(findingKey(finding))).length;
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  if (isRecord(defaultResult?.summary)) for (const key of Object.keys(counts)) counts[key] = typeof defaultResult.summary[key] === 'number' ? defaultResult.summary[key] : 0;
  else for (const finding of defaultResult?.findings ?? []) {
    const severity = typeof finding?.severity === 'string' ? finding.severity.toLowerCase() : '';
    if (severity in counts) counts[severity] += 1;
  }
  const diagnostics = Array.isArray(defaultResult?.analysisDiagnostics) ? defaultResult.analysisDiagnostics.map((diagnostic) => diagnostic?.code).filter((code) => typeof code === 'string') : [];
  return {
    schemaVersion: SCANNER_RESULT_SCHEMA_VERSION,
    grade: defaultResult?.riskAssessment?.grade ?? 'UNKNOWN',
    score: typeof defaultResult?.riskAssessment?.score === 'number' ? defaultResult.riskAssessment.score : 0,
    counts, findings, hardenedExtra, scannerVersion: PIPELINE_SCANNER_VERSION, profile: 'beta-default',
    ...(defaultResult?.analysisStatus ? { analysisStatus: defaultResult.analysisStatus } : {}),
    ...(diagnostics.length > 0 ? { analysisDiagnosticCodes: diagnostics } : {}),
  };
}
export function validatePipelineParity({ fixture, browserResults, pipelineResult }) {
  const context = `${fixture.id} pipeline`;
  const errors = [...validateSecretGuard(fixture, pipelineResult, 'pipeline').errors];
  if (!isRecord(pipelineResult)) errors.push(`${context} output was malformed`); else {
    if (pipelineResult.profile !== 'beta-default') errors.push(`${context} output used unexpected profile ${String(pipelineResult.profile)}`);
    if (pipelineResult.schemaVersion !== SCANNER_RESULT_SCHEMA_VERSION) errors.push(`${context} output used unexpected schema version`);
    if (!Array.isArray(pipelineResult.findings) || !isRecord(pipelineResult.counts)) errors.push(`${context} output was malformed`);
  }
  const browserDefault = browserResults?.['beta-default'];
  const browserHardened = browserResults?.['beta-hardened'];
  if (!browserDefault || !browserHardened) errors.push(`${context} is missing one browser profile result`);
  else {
    try { if (canonicalWire(pipelineResult) !== canonicalWire(projectBrowserEntrySecurity(browserDefault, browserHardened))) errors.push(`${context} output did not match browser projection`); }
    catch { errors.push(`${context} result could not be canonicalized`); }
  }
  return verdict(errors);
}
export function validatePipelineRejection({ fixture, pipelineResult }) {
  const errors = [...validateSecretGuard(fixture, pipelineResult, 'pipeline').errors];
  const counts = pipelineResult?.counts;
  const zeroCounts = isRecord(counts) && Object.keys({ critical: 0, high: 0, medium: 0, low: 0, info: 0 }).every((key) => counts[key] === 0);
  if (!isRecord(pipelineResult) || pipelineResult.grade !== 'UNKNOWN' || pipelineResult.score !== 0 || !Array.isArray(pipelineResult.findings)
    || pipelineResult.findings.length !== 0 || pipelineResult.analysisStatus !== 'INDETERMINATE' || pipelineResult.profile !== 'beta-default' || !zeroCounts) errors.push(`${fixture.id} pipeline rejection did not fail closed`);
  return verdict(errors);
}
export function validateRejectedParity({ fixture, profile, cliRun }) {
  const context = `${fixture.id} [${profile}]`;
  const errors = [...validateSecretGuard(fixture, cliRun, 'CLI').errors];
  const cli = readCliDocument(cliRun, context, errors);
  if (cliRun?.exitCode !== 3) errors.push(`${context} expected CLI exit code 3, received ${String(cliRun?.exitCode)}`);
  const item = cli?.results[0];
  if (!item || item.input !== '-' || item.ok !== false) errors.push(`${context} CLI did not return one input rejection`);
  else {
    const code = item.error?.code;
    if (item.error?.kind !== 'input') errors.push(`${context} CLI rejection kind was not input`);
    if (code !== fixture.rejectionCode) errors.push(`${context} expected ${fixture.rejectionCode}, received ${String(code)}`);
  }
  return verdict(errors);
}
export function validateFixtureMatrix(fixtures) {
  const errors = [];
  if (!Array.isArray(fixtures) || fixtures.length === 0) return ['fixture matrix is empty'];
  const ids = new Set();
  for (const fixture of fixtures) {
    if (!isRecord(fixture) || typeof fixture.id !== 'string' || typeof fixture.json !== 'string' || !['valid', 'rejected'].includes(fixture.kind)) { errors.push('fixture matrix contains a malformed fixture'); continue; }
    if (ids.has(fixture.id)) errors.push(`fixture matrix contains duplicate id: ${fixture.id}`);
    ids.add(fixture.id);
    if (fixture.kind === 'rejected' && typeof fixture.rejectionCode !== 'string') errors.push(`${fixture.id} is rejected but has no declared input code`);
  }
  if (!fixtures.some((fixture) => fixture?.kind === 'valid')) errors.push('fixture matrix has no valid fixtures');
  if (!fixtures.some((fixture) => fixture?.kind === 'rejected')) errors.push('fixture matrix has no rejected fixtures');
  return errors;
}
export async function runParityGate({ fixtures = scannerParityFixtures, scanBrowser = scanBrowserFixture, scanCli = runIsolatedCli, scanPipeline = scanPipelineFixture } = {}) {
  const errors = validateFixtureMatrix(fixtures);
  if (errors.length > 0) return { ok: false, errors, validChecks: 0, rejectedChecks: 0 };
  let validChecks = 0; let rejectedChecks = 0;
  for (const fixture of fixtures) {
    const browserResults = {};
    for (const profile of PARITY_PROFILES) {
      if (fixture.kind === 'valid') {
        validChecks += 1;
        let browserResult; let cliRun; let browserReady = false; let cliReady = false;
        try { browserResult = await scanBrowser(fixture, profile); browserReady = true; } catch (error) { errors.push(`${fixture.id} [${profile}] browser scan failed: ${errorMessage(error)}`); }
        try { cliRun = await scanCli(fixture, profile); cliReady = true; } catch (error) { errors.push(`${fixture.id} [${profile}] CLI scan failed: ${errorMessage(error)}`); }
        if (browserReady) browserResults[profile] = browserResult;
        if (browserReady && cliReady) errors.push(...validateValidParity({ fixture, profile, browserResult, cliRun }).errors);
        else { if (browserReady) errors.push(...validateSecretGuard(fixture, browserResult, 'browser').errors); if (cliReady) errors.push(...validateSecretGuard(fixture, cliRun, 'CLI').errors); }
      } else {
        rejectedChecks += 1;
        const parsed = parseWorkflowJson(fixture.json, PARSE_OPTIONS);
        if (parsed.ok || parsed.code !== fixture.rejectionCode) errors.push(`${fixture.id} declared ${fixture.rejectionCode}, parser returned ${parsed.ok ? 'accepted' : parsed.code}`);
        try { errors.push(...validateRejectedParity({ fixture, profile, cliRun: await scanCli(fixture, profile) }).errors); }
        catch (error) { errors.push(`${fixture.id} [${profile}] CLI rejection check failed: ${errorMessage(error)}`); }
      }
    }
    try { const pipelineResult = await scanPipeline(fixture); errors.push(...(fixture.kind === 'valid'
      ? validatePipelineParity({ fixture, browserResults, pipelineResult }).errors : validatePipelineRejection({ fixture, pipelineResult }).errors)); }
    catch (error) { errors.push(`${fixture.id} pipeline scan failed: ${errorMessage(error)}`); }
  }
  return { ok: errors.length === 0, errors, validChecks, rejectedChecks };
}
function scanBrowserFixture(fixture, profile) {
  const parsed = parseWorkflowJson(fixture.json, PARSE_OPTIONS);
  if (!parsed.ok) throw new Error(`input rejected as ${parsed.code}`);
  return scanWorkflow(parsed.workflow, { policyProfile: profile });
}
async function scanPipelineFixture(fixture) {
  return scanCandidate({ id: fixture.id, json: fixture.json }, {
    scannerVersion: PIPELINE_SCANNER_VERSION,
    scan: (workflow, options) => scanWorkflow(workflow, options),
  });
}
async function runIsolatedCli(fixture, profile) {
  return runCli(['scan', '-', '--format', 'json', '--profile', profile, '--timeout', '30000'], { stdin: new TextEncoder().encode(fixture.json), signal: new AbortController().signal });
}
function readCliDocument(cliRun, context, errors) {
  if (!isRecord(cliRun)) { errors.push(`${context} CLI returned no run result`); return undefined; }
  if (cliRun.stderr !== '') errors.push(`${context} CLI wrote to stderr`);
  if (typeof cliRun.stdout !== 'string') { errors.push(`${context} CLI stdout was not text`); return undefined; }
  try { const document = JSON.parse(cliRun.stdout); if (!isRecord(document) || !Array.isArray(document.results) || document.results.length !== 1) { errors.push(`${context} CLI JSON document did not contain one result`); return undefined; } return document; }
  catch { errors.push(`${context} CLI stdout was not valid JSON`); return undefined; }
}
function projectBrowserFinding(finding) {
  const location = isRecord(finding?.location) ? finding.location : {};
  const node = location.nodeName ?? location.nodeId;
  return { id: finding?.policyId, title: finding?.title, severity: finding?.severity, ...(node ? { node } : {}), why: finding?.whyItMatters, fix: finding?.remediation };
}
function comparePublicFindings(left, right) {
  return (SEVERITY_ORDER[left.severity] ?? SEVERITY_ORDER.INFO) - (SEVERITY_ORDER[right.severity] ?? SEVERITY_ORDER.INFO) || String(left.id).localeCompare(String(right.id));
}
function verdict(errors) { return { ok: errors.length === 0, errors }; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
export async function main(io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const report = await runParityGate();
    if (!report.ok) { io.stderr.write('Scanner parity gate failed:\n'); for (const error of report.errors.slice(0, 20)) io.stderr.write(`- ${error}\n`); if (report.errors.length > 20) io.stderr.write(`- ...and ${report.errors.length - 20} more\n`); return 1; }
    io.stdout.write(`Scanner parity passed: ${report.validChecks} valid and ${report.rejectedChecks} rejected profile checks.\n`); return 0;
  } catch (error) { io.stderr.write(`Scanner parity gate failed: ${errorMessage(error)}\n`); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) process.exitCode = await main();
