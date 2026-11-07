import { createHash } from 'node:crypto';
import { access, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DEFAULT_SCANNER_LIMITS, toWorkflowParseOptions } from '@hub/contracts';
import { canonicalizeJson } from '../packages/scanner-core/src/canonical-json.ts';
import { parseWorkflowJson } from '../packages/scanner-core/src/workflow.ts';
import { SCANNER_VERSION } from '../packages/scanner-core/src/scanner-version.ts';
import { V1_GOLDEN_CASES } from '../packages/scanner-core/src/__fixtures__/v1-goldens.ts';
import { scanWorkflow } from '../app/src/scanner/engine.ts';

export const BASELINE_SCHEMA_VERSION = 'scanner-baseline-v1';
export const BASELINE_PATH = resolve(import.meta.dirname, '../docs/scanner/baseline-v1.json');
export const FIXTURE_SOURCE = 'packages/scanner-core/src/__fixtures__/v1-goldens.ts';
const PARSE_OPTIONS = toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS);
const HEX = /^[0-9a-f]{64}$/;

export function fixtureKey(fixture) { return `${fixture.id}:${fixture.profile}`; }
export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export function percentile(values, quantile) {
  if (!values.length || quantile < 0 || quantile > 1) throw new RangeError('percentile input is invalid');
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * quantile;
  const lower = Math.floor(position); const upper = Math.ceil(position);
  return Number((ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)).toFixed(6));
}

function summary(values) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) };
}
function unavailable(reason) { return { value: null, reason }; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function error(errors, message) { errors.push(message); }

export function validateBaselineReport(report) {
  const errors = [];
  if (!isRecord(report) || report.schemaVersion !== BASELINE_SCHEMA_VERSION) error(errors, 'unsupported baseline schema');
  if (report?.gate !== 'scanner-baseline') error(errors, 'baseline gate must be scanner-baseline');
  if (typeof report?.claim !== 'string' || !report.claim.includes('same-machine') || !report.claim.includes('not cross-machine')) error(errors, 'baseline must disclaim cross-machine production performance');
  if (!isRecord(report?.measurement) || !Number.isInteger(report.measurement.samples) || report.measurement.samples < 1) error(errors, 'measurement samples must be a positive integer');
  if (!isRecord(report?.environment) || !HEX.test(report.environment.digest ?? '')) error(errors, 'environment digest is missing');
  if (!isRecord(report?.tool) || !HEX.test(report.tool.digest ?? '')) error(errors, 'tool digest is missing');
  const fixtures = report?.fixtures;
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  if (!isRecord(fixtures) || !Number.isInteger(fixtures.count) || fixtures.count !== cases.length || !Array.isArray(fixtures.order) || !HEX.test(fixtures.digest ?? '')) error(errors, 'fixture metadata is malformed');
  const keys = [];
  for (const item of cases) {
    if (!isRecord(item) || typeof item.key !== 'string' || typeof item.id !== 'string' || typeof item.profile !== 'string' || item.key !== fixtureKey(item) || !HEX.test(item.expectedDigest ?? '') || !HEX.test(item.inputSha256 ?? '')) { error(errors, 'baseline case identity or digest is malformed'); continue; }
    if (keys.includes(item.key)) error(errors, `duplicate baseline case: ${item.key}`);
    keys.push(item.key);
    const dimensions = item.dimensions;
    for (const dimension of ['inputBytes', 'nodes', 'acceptedEdges', 'codeIndicators', 'rawEdges', 'codeAstNodes', 'taintStates']) {
      const value = dimensions?.[dimension];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) continue;
      if (isRecord(value) && value.value === null && typeof value.reason === 'string' && value.reason.length > 0) continue;
      error(errors, `${item.key}.${dimension} must explain an unavailable value`);
    }
    for (const metric of ['latencyMs', 'rssBytes']) {
      const values = item[metric];
      if (!isRecord(values) || !['p50', 'p95', 'max'].every((key) => Number.isFinite(values[key]))) error(errors, `${item.key}.${metric} summary is malformed`);
    }
  }
  if (Array.isArray(fixtures?.order) && fixtures.order.some((key, index) => key !== keys[index])) error(errors, 'fixture order does not match case order');
  return { ok: errors.length === 0, errors };
}

function scanFixture(fixture) {
  const parsed = parseWorkflowJson(fixture.json, PARSE_OPTIONS);
  if (!parsed.ok) throw new Error(`${fixtureKey(fixture)} rejected as ${parsed.code}`);
  const result = scanWorkflow(parsed.workflow, { policyProfile: fixture.profile });
  return { workflow: parsed.workflow, result };
}

function dimensions(fixture, workflow) {
  const codeIndicators = workflow.nodes.filter((node) => node.type.endsWith('.code')).length;
  return {
    inputBytes: new TextEncoder().encode(fixture.json).length,
    nodes: workflow.nodeCount,
    rawEdges: unavailable('native v1 exposes normalized accepted edges, not rejected raw-edge count'),
    acceptedEdges: workflow.graph.edges.length,
    codeIndicators,
    codeAstNodes: unavailable('native v1 scanner does not expose parser AST node counts'),
    taintStates: unavailable('native v1 scanner does not expose taint state counts'),
  };
}

function measureCase(fixture, samples, warmups) {
  for (let index = 0; index < warmups; index += 1) scanFixture(fixture);
  const times = []; const rss = []; let first;
  for (let index = 0; index < samples; index += 1) {
    const before = process.memoryUsage().rss; const started = performance.now();
    first = scanFixture(fixture); times.push(performance.now() - started);
    rss.push(Math.max(before, process.memoryUsage().rss));
  }
  return { key: fixtureKey(fixture), id: fixture.id, profile: fixture.profile,
    expectedDigest: fixture.expectedDigest,
    inputSha256: sha256(new TextEncoder().encode(fixture.json)),
    dimensions: dimensions(fixture, first.workflow), latencyMs: summary(times), rssBytes: summary(rss) };
}

export async function buildBaselineReport({ samples = 5, warmups = 1 } = {}) {
  if (!Number.isInteger(samples) || samples < 1 || !Number.isInteger(warmups) || warmups < 0) throw new RangeError('samples and warmups must be valid integers');
  const source = await readFile(new URL(import.meta.url));
  const environment = { node: process.version, platform: process.platform, arch: process.arch, cpuCount: requireCpuCount() };
  const tool = { scannerVersion: SCANNER_VERSION, canonicalization: 'hub-canonical-json-v1', hash: 'sha256', scriptSha256: sha256(source) };
  const fixtureDigest = sha256(canonicalizeJson(V1_GOLDEN_CASES));
  const cases = V1_GOLDEN_CASES.map((fixture) => measureCase(fixture, samples, warmups));
  const report = { schemaVersion: BASELINE_SCHEMA_VERSION, gate: 'scanner-baseline', claim: 'same-machine repeatability evidence; not cross-machine production performance', measurement: { warmups, samples, clock: 'performance.now', rss: 'process.memoryUsage.rss' }, environment: { ...environment, digest: sha256(canonicalizeJson(environment)) }, tool: { ...tool, digest: sha256(canonicalizeJson(tool)) }, fixtures: { source: FIXTURE_SOURCE, count: cases.length, order: cases.map((item) => item.key), digest: fixtureDigest }, cases };
  return report;
}

function requireCpuCount() { return availableParallelism(); }
async function writeBaseline(report) {
  try { await access(BASELINE_PATH); throw new Error(`baseline already exists: ${BASELINE_PATH}`); }
  catch (cause) { if (cause instanceof Error && cause.message.startsWith('baseline already exists:')) throw cause; }
  const temporary = `${BASELINE_PATH}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, BASELINE_PATH); }
  catch (cause) { await unlink(temporary).catch(() => undefined); throw cause; }
}
async function main() {
  const write = process.argv.includes('--write'); const report = await buildBaselineReport(); const validation = validateBaselineReport(report);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  if (write) await writeBaseline(report);
  console.log(JSON.stringify({ ok: true, mode: write ? 'write' : 'measure', schemaVersion: report.schemaVersion, cases: report.cases.map((item) => ({ key: item.key, p95Ms: item.latencyMs.p95, rssBytes: item.rssBytes.max })) }));
}
const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) { try { await main(); } catch (cause) { console.error(`Scanner baseline failed: ${cause instanceof Error ? cause.message : String(cause)}`); process.exitCode = 1; } }
