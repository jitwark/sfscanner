import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
const invokedDirectly = process.argv[1]?.replaceAll('\\', '/').endsWith('/check-scanner-v2-parity.mjs');
if (invokedDirectly && !process.execArgv.some((argument) => argument.includes('tsx'))) {
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, ['--import', 'tsx', process.argv[1], ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, SECUREFLOW_V2_PARITY_TSX: '1' },
  });
  process.exit(child.status ?? 1);
}
const { register } = await import('tsx/esm/api');
register();
const [{ canonicalJsonBytes }, { validateScannerResultV2 }, { DEFAULT_SCANNER_LIMITS_V2 }, core, cli, runner, fixtureModule] = await Promise.all([
  import('@hub/scanner-core/canonical-json'),
  import('@hub/contracts/scanner-v2-result'),
  import('@hub/contracts'),
  import('@hub/scanner-core/v2'),
  import('sfscanner/v2/arguments'),
  import('sfscanner/v2/cli-runner'),
  import('../packages/scanner-core/src/__fixtures__/v2-adapter-fixtures.ts'),
]);
const { scanWorkflowV2 } = core;
const { parseArgumentsV2 } = cli;
const { runCliV2 } = runner;
const { runPipelineCli } = await import('../pipeline/cli/package-wrapper.ts');
const { runBrowserScanV2 } = await import('../app/src/scanner/scanner-v2-adapter.ts');
const { V2_ADAPTER_FIXTURE_MATRIX, V2_ADAPTER_PROFILE } = fixtureModule;
const ADAPTERS = Object.freeze(['core', 'browser', 'pipeline', 'package']);
const FAILURE_CODES = new Set('UTF8_DECODING_FAILED INVALID_JSON MALFORMED_WORKFLOW WORKFLOW_TOO_LARGE WORKFLOW_TOO_COMPLEX INVALID_CONFIG UNKNOWN_CONFIGURATION_KEY PROFILE_NOT_ADMITTED SEMANTIC_CATALOGUE_INVALID SEMANTIC_CATALOGUE_AMBIGUOUS RULE_PACK_INVALID RULE_PACK_UNTRUSTED TOOL_INVARIANT_FAILED SERIALIZATION_FAILED SCAN_TIMEOUT SCAN_CANCELLED'.split(' '));
const SECRET_KEY = /(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|credential|authorization|cookie|private[-_ ]?key|secret)/i;
const SECRET_VALUE = [/\bsk_(?:live|test)_[A-Za-z0-9][A-Za-z0-9_-]{7,}\b/, /\b(?:ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/, /^Bearer\s+[A-Za-z0-9._~+/=-]{12,}$/i, /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/];
const encoder = new TextEncoder();

const bytesFor = (fixture) => encoder.encode(fixture.json);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (bytes) => bytesToHex(sha256(bytes));
const sameBytes = (left, right) => left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
const closedFailure = (code) => ({ ok: false, code: typeof code === 'string' && FAILURE_CODES.has(code) ? code : 'TOOL_INVARIANT_FAILED' });
const workflowObservation = (result) => result && typeof result === 'object' && typeof result.ok === 'boolean'
  ? result.ok ? { ok: true, result: result.result } : closedFailure(result.code) : closedFailure('TOOL_INVARIANT_FAILED');

function fixtureSecrets(fixture) {
  let parsed;
  try { parsed = JSON.parse(fixture.json); } catch { return []; }
  const values = new Set();
  const visit = (value, key) => {
    if (typeof value === 'string') {
      const candidate = value.trim(), matches = candidate.length >= 8 ? SECRET_VALUE.flatMap((pattern) => candidate.match(pattern) ?? []) : [];
      if (candidate.length >= 8 && ((key && SECRET_KEY.test(key)) || matches.length > 0)) { values.add(candidate); matches.forEach((match) => values.add(match)); }
    } else if (Array.isArray(value)) value.forEach((child) => visit(child, key));
    else if (isRecord(value)) Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(parsed, undefined);
  return [...values];
}
function secretGuard(fixture, value, adapter) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { serialized = undefined; }
  if (typeof serialized !== 'string') return [`${fixture.id} [${V2_ADAPTER_PROFILE.id}] ${adapter} output was not serializable.`];
  return fixtureSecrets(fixture).some((secret) => serialized.includes(secret)) ? [`${fixture.id} [${V2_ADAPTER_PROFILE.id}] ${adapter} output contains fixture secret-like text.`] : [];
}
function validateRaw(fixture, observation, adapter) {
  if (!observation || observation.ok !== true) return { errors: [`${fixture.id} [${V2_ADAPTER_PROFILE.id}] ${adapter} returned a failure for a valid fixture.`] };
  const checked = validateScannerResultV2(observation.result);
  return checked.ok && checked.result.profile?.id === V2_ADAPTER_PROFILE.id && checked.result.profile?.version === V2_ADAPTER_PROFILE.version ? { result: checked.result, errors: [] } : { errors: [`${fixture.id} [${V2_ADAPTER_PROFILE.id}] ${adapter} returned an invalid ScannerResultV2.`] };
}

export function compareRawResults(fixture, observations) {
  if (!isRecord(fixture) || typeof fixture.id !== 'string' || typeof fixture.json !== 'string' || !isRecord(observations)) return { ok: false, errors: ['parity comparison input is malformed.'] };
  const errors = [], context = `${fixture.id} [${V2_ADAPTER_PROFILE.id}]`, raw = {};
  for (const adapter of ADAPTERS) {
    const observation = observations[adapter];
    errors.push(...secretGuard(fixture, observation, adapter));
    if (fixture.kind === 'valid') {
      const checked = validateRaw(fixture, observation, adapter);
      errors.push(...checked.errors);
      if (checked.result) {
        raw[adapter] = checked.result;
        if (checked.result.input?.rawSha256 !== digest(bytesFor(fixture))) errors.push(`${context} ${adapter} raw input digest is not byte-faithful.`);
        if (fixture.expectedStatus !== undefined && checked.result.analysis?.status !== fixture.expectedStatus) errors.push(`${context} ${adapter} returned an unexpected analysis status.`);
      }
    } else if (!observation || observation.ok !== false || observation.code !== fixture.rejectionCode) errors.push(`${context} ${adapter} returned an unexpected closed failure code.`);
  }
  if (fixture.kind !== 'valid') {
    const codes = ADAPTERS.map((adapter) => observations[adapter]?.code);
    if (codes.every((code) => typeof code === 'string') && codes.some((code) => code !== codes[0])) errors.push(`${context} rejected adapters returned different failure codes.`);
    return { ok: errors.length === 0, errors };
  }
  if (raw.core) {
    const coreBytes = canonicalJsonBytes(raw.core), coreSha = digest(coreBytes);
    for (const adapter of ADAPTERS.slice(1)) {
      if (!raw[adapter]) continue;
      const candidateBytes = canonicalJsonBytes(raw[adapter]);
      if (!sameBytes(coreBytes, candidateBytes)) errors.push(`${context} ${adapter} raw bytes differ from core truth.`);
      if (digest(candidateBytes) !== coreSha) errors.push(`${context} ${adapter} raw SHA-256 differs from core truth.`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateFixtureMatrix(fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) return ['fixture matrix is empty.'];
  const errors = [], ids = new Set();
  for (const fixture of fixtures) {
    if (!isRecord(fixture) || typeof fixture.id !== 'string' || typeof fixture.json !== 'string' || !['valid', 'rejected'].includes(fixture.kind)) { errors.push('fixture matrix contains a malformed fixture.'); continue; }
    if (ids.has(fixture.id)) errors.push(`fixture matrix contains duplicate id: ${fixture.id}.`);
    ids.add(fixture.id);
    if (fixture.kind === 'rejected' && (typeof fixture.rejectionCode !== 'string' || !FAILURE_CODES.has(fixture.rejectionCode))) errors.push(`${fixture.id} has no closed rejection code.`);
  }
  if (!fixtures.some((fixture) => fixture?.kind === 'valid')) errors.push('fixture matrix has no valid fixtures.');
  if (!fixtures.some((fixture) => fixture?.kind === 'rejected')) errors.push('fixture matrix has no rejected fixtures.');
  return errors;
}
function envelopeFailure(run) {
  try { const code = JSON.parse(run.stdout)?.results?.[0]?.error?.code; return typeof code === 'string' ? closedFailure(code) : undefined; } catch { return undefined; }
}
function envelopeResult(run) {
  try {
    const item = JSON.parse(run.stdout)?.results?.[0];
    return item?.ok === true ? item.result : undefined;
  } catch { return undefined; }
}
function coreScanBytes(bytes) { return scanWorkflowV2({ bytes, profile: V2_ADAPTER_PROFILE }); }
function coreScan(fixture) { return coreScanBytes(bytesFor(fixture)); }
function v2Command() {
  const parsed = parseArgumentsV2(['--schema', 'v2', 'scan', '-', '--format', 'json']);
  return parsed.ok && parsed.command.kind === 'scan' ? parsed.command : undefined;
}
async function scanPackageFixture(fixture) {
  const command = v2Command();
  if (!command) return closedFailure('INVALID_CONFIG');
  const run = await runCliV2(command, { stdin: bytesFor(fixture) });
  const result = envelopeResult(run);
  return result ? { ok: true, result } : (envelopeFailure(run) ?? closedFailure('TOOL_INVARIANT_FAILED'));
}
async function scanPipelineFixture(fixture) {
  const run = await runPipelineCli(['--schema', 'v2', 'scan', '-', '--format', 'json'], { stdin: bytesFor(fixture) });
  const result = envelopeResult(run);
  return result ? { ok: true, result } : (envelopeFailure(run) ?? closedFailure('TOOL_INVARIANT_FAILED'));
}
const digestSummary = (fixture, observations) => Object.fromEntries(ADAPTERS.map((adapter) => { const item = observations[adapter]; if (fixture.kind !== 'valid' || item?.ok !== true) return [adapter, { failureCode: item?.code ?? 'TOOL_INVARIANT_FAILED' }]; const checked = validateScannerResultV2(item.result); if (!checked.ok) return [adapter, { failureCode: 'TOOL_INVARIANT_FAILED' }]; const bytes = canonicalJsonBytes(checked.result); return [adapter, { byteLength: bytes.byteLength, sha256: digest(bytes) }]; }));
let browserWorkerCapture;
class ParityWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  terminated = false;
  postMessage(message) {
    if (message?.kind !== 'scan-v2' || typeof message.json !== 'string') return;
    queueMicrotask(() => {
      if (this.terminated) return;
      const result = coreScanBytes(encoder.encode(message.json));
      browserWorkerCapture = result;
      this.onmessage?.({ data: result.ok ? { kind: 'result-v2', id: message.id, result: result.result } : { kind: 'error-v2', id: message.id, code: result.code, message: 'closed scanner failure' } });
    });
  }
  terminate() { this.terminated = true; }
}
async function scanBrowserFixture(fixture) {
  globalThis.Worker = ParityWorker;
  browserWorkerCapture = undefined;
  const outcome = await runBrowserScanV2({ json: fixture.json, profile: V2_ADAPTER_PROFILE.id, approvedDomains: [], deadlineMs: DEFAULT_SCANNER_LIMITS_V2.workerDeadlineMs });
  return browserWorkerCapture ? workflowObservation(browserWorkerCapture) : outcome.ok ? { ok: true, result: outcome.result } : closedFailure(outcome.code);
}
const defaultAdapters = Object.freeze({ core: async (fixture) => workflowObservation(coreScan(fixture)), browser: scanBrowserFixture, pipeline: scanPipelineFixture, package: scanPackageFixture });

export async function runParityGate({ fixtures = V2_ADAPTER_FIXTURE_MATRIX, adapters = {} } = {}) {
  const matrixErrors = validateFixtureMatrix(fixtures);
  const report = {
    schemaVersion: 'scanner-v2-parity-v1',
    profile: { id: V2_ADAPTER_PROFILE.id, version: V2_ADAPTER_PROFILE.version },
    fixtureCount: Array.isArray(fixtures) ? fixtures.length : 0,
    validFixtureCount: Array.isArray(fixtures) ? fixtures.filter((fixture) => fixture?.kind === 'valid').length : 0,
    rejectedFixtureCount: Array.isArray(fixtures) ? fixtures.filter((fixture) => fixture?.kind === 'rejected').length : 0,
    validChecks: 0, rejectedChecks: 0, adapters: [...ADAPTERS], fixtureResults: [],
    hostPresentationDifferences: ['CLI labels and JSON/NDJSON/SARIF/table envelopes are host presentation, not ScannerResultV2 truth.', 'Legacy EntrySecurity and v1 projection fields remain compatibility presentation, not raw v2 truth.'],
    deferredTrustBehavior: 'Phase 7 trust/signing behavior remains deferred and report-only; no external gate is asserted.',
    errors: [...matrixErrors], ok: matrixErrors.length === 0,
  };
  if (matrixErrors.length > 0) return Object.freeze(report);
  const runners = { ...defaultAdapters, ...adapters };
  for (const fixture of fixtures) {
    const observations = {}, fixtureErrors = [];
    for (const adapter of ADAPTERS) {
      try { observations[adapter] = await runners[adapter](fixture); } catch { observations[adapter] = closedFailure('TOOL_INVARIANT_FAILED'); fixtureErrors.push(`${fixture.id} [${V2_ADAPTER_PROFILE.id}] ${adapter} failed closed.`); }
    }
    const compared = compareRawResults(fixture, observations);
    fixtureErrors.push(...compared.errors);
    report[fixture.kind === 'valid' ? 'validChecks' : 'rejectedChecks'] += 1;
    report.fixtureResults.push(Object.freeze({ id: fixture.id, kind: fixture.kind, status: fixtureErrors.length === 0 ? 'passed' : 'failed', digests: digestSummary(fixture, observations), errors: Object.freeze([...fixtureErrors]) }));
    report.errors.push(...fixtureErrors);
  }
  report.ok = report.errors.length === 0;
  report.fixtureResults = Object.freeze(report.fixtureResults);
  report.errors = Object.freeze(report.errors);
  return Object.freeze(report);
}

export async function main(io = { stdout: process.stdout, stderr: process.stderr }) {
  const report = await runParityGate();
  io.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) io.stderr.write('Scanner v2 parity gate failed.\n');
  return report.ok ? 0 : 1;
}
if (invokedDirectly) process.exitCode = await main();
