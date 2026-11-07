import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { canonicalizeJson } from '../packages/scanner-core/src/canonical-json.ts';
import { canonicalBytesV1 } from '../packages/scanner-core/src/result-v2/canonical-bytes.ts';
import { validateScannerResultV2 } from '../contracts/scanner-v2-result.ts';
import { SCANNER_VERSION } from '../packages/scanner-core/src/scanner-version.ts';
import { V2_ADAPTER_FIXTURE_MATRIX, V2_ADAPTER_PROFILE } from '../packages/scanner-core/src/__fixtures__/v2-adapter-fixtures.ts';
import { scanWorkflowV2 } from '../packages/scanner-core/src/v2/index.ts';
import { withPreservedP95BudgetOverrides } from './scanner-v2-budget-baseline.mjs';

export const BASELINE_V2_SCHEMA_VERSION = 'scanner-baseline-v2';
export const BASELINE_V2_PATH = resolve(import.meta.dirname, '../docs/scanner/baseline-v2.json');
export const FIXTURE_SOURCE_V2 = 'packages/scanner-core/src/__fixtures__/v2-adapter-fixtures.ts';
export const MEASUREMENT_AGGREGATION_V2 = 'median-batch-p95';
export const MEASUREMENT_DEFAULTS_V2 = Object.freeze({ samples: 100, warmups: 1, batches: 3, aggregation: MEASUREMENT_AGGREGATION_V2 });
export const MEASUREMENT_MAX_SAMPLES_V2 = 100;
export const MEASUREMENT_MAX_WARMUPS_V2 = 100;
export const MEASUREMENT_MAX_BATCHES_V2 = 3;
const HEX = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const normalizedSource = FIXTURE_SOURCE_V2.replaceAll('\\', '/');

export function fixtureKey(fixture) {
  return `${fixture.id}:${fixture.profile.id}@${fixture.profile.version}`;
}
export function orderFixtures(fixtures) {
  return [...fixtures].sort((left, right) => {
    const a = fixtureKey(left); const b = fixtureKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export function percentile(values, quantile) {
  if (!Array.isArray(values) || values.length === 0 || !Number.isFinite(quantile) || quantile < 0 || quantile > 1 || values.some((value) => !Number.isFinite(value))) throw new RangeError('percentile input is invalid');
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * quantile;
  const lower = Math.floor(position); const upper = Math.ceil(position);
  return Number((ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)).toFixed(6));
}
export function aggregateBatchP95(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value))) throw new RangeError('batch p95 input is invalid');
  return percentile(values, 0.5);
}
function summary(values) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) };
}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function error(errors, message) { errors.push(message); }
function metricValid(value, integer = false) { return record(value) && ['p50', 'p95', 'max'].every((key) => Number.isFinite(value[key]) && value[key] >= 0 && (!integer || key !== 'max' || Number.isSafeInteger(value[key]))); }

export function validateBaselineV2Report(report) {
  const errors = [];
  if (!record(report) || report.schemaVersion !== BASELINE_V2_SCHEMA_VERSION) error(errors, 'unsupported baseline v2 schema');
  if (report?.gate !== 'scanner-v2-performance') error(errors, 'baseline v2 gate must be scanner-v2-performance');
  if (typeof report?.claim !== 'string' || !report.claim.includes('same-machine') || !report.claim.includes('not cross-machine production performance')) error(errors, 'baseline v2 must disclaim cross-machine production performance');
  const measurement = report?.measurement;
  if (!record(measurement) || !Number.isInteger(measurement.warmups) || measurement.warmups < 1 || measurement.warmups > MEASUREMENT_MAX_WARMUPS_V2 || !Number.isInteger(measurement.samples) || measurement.samples < 5 || measurement.samples > MEASUREMENT_MAX_SAMPLES_V2 || !Number.isInteger(measurement.batches) || measurement.batches < 1 || measurement.batches > MEASUREMENT_MAX_BATCHES_V2 || measurement.aggregation !== MEASUREMENT_AGGREGATION_V2 || measurement.clock !== 'performance.now' || measurement.rss !== 'process.memoryUsage.rss' || measurement.serialization !== 'secureflow-canonical-json-v1') error(errors, 'measurement metadata is malformed');
  const environment = report?.environment;
  if (!record(environment) || typeof environment.node !== 'string' || typeof environment.platform !== 'string' || typeof environment.arch !== 'string' || !Number.isSafeInteger(environment.cpuCount) || environment.cpuCount < 1 || HEX.test(environment.digest ?? '') === false) error(errors, 'environment metadata is malformed');
  const tool = report?.tool;
  if (!record(tool) || typeof tool.scannerVersion !== 'string' || tool.hash !== 'sha256' || !HEX.test(tool.scriptSha256 ?? '') || !HEX.test(tool.digest ?? '')) error(errors, 'tool metadata is malformed');
  const ceilings = report?.byteCeilings;
  if (!record(ceilings) || !['maxSerializedResultBytes', 'maxEvidenceBytes', 'maxRedactedArtifactBytes'].every((key) => Number.isSafeInteger(ceilings[key]) && ceilings[key] >= 0)) error(errors, 'byte ceilings are malformed');
  const fixtures = report?.fixtures; const cases = Array.isArray(report?.cases) ? report.cases : [];
  if (!record(fixtures) || fixtures.source !== normalizedSource || !record(fixtures.profile) || fixtures.profile.id !== V2_ADAPTER_PROFILE.id || fixtures.profile.version !== V2_ADAPTER_PROFILE.version || !Number.isSafeInteger(fixtures.count) || fixtures.count !== cases.length || !Array.isArray(fixtures.order) || !HEX.test(fixtures.digest ?? '')) error(errors, 'fixture metadata is malformed');
  const keys = [];
  for (const item of cases) {
    const key = item?.key ?? '<unknown>';
    const closed = (item?.outcome === 'SUCCESS' && ['COMPLETE', 'DEGRADED', 'INDETERMINATE'].includes(item.status) && item.failureCode === null) || (item?.outcome === 'FAILURE' && item.status === null && typeof item.failureCode === 'string' && item.failureCode.length > 0);
    if (!record(item) || typeof item.key !== 'string' || typeof item.id !== 'string' || !['valid', 'rejected'].includes(item.kind) || typeof item.fixtureClass !== 'string' || !record(item.profile) || item.profile.id !== V2_ADAPTER_PROFILE.id || item.profile.version !== V2_ADAPTER_PROFILE.version || !HEX.test(item.inputSha256 ?? '') || !['SUCCESS', 'FAILURE'].includes(item.outcome) || !closed) { error(errors, `${key} case identity, outcome or status is malformed`); continue; }
    if (item.budgetBaselineP95Ms !== undefined && (!Number.isFinite(item.budgetBaselineP95Ms) || item.budgetBaselineP95Ms <= 0)) error(errors, `${key} budgetBaselineP95Ms must be a positive finite number`);
    if (!metricValid(item.latencyMs)) error(errors, `${key}.latencyMs summary is malformed`);
    if (!metricValid(item.rssBytes, true)) error(errors, `${key}.rssBytes summary is malformed`);
    if (!metricValid(item.serializedBytes, true)) error(errors, `${key}.serializedBytes summary is malformed`);
    if (!metricValid(item.evidenceBytes, true)) error(errors, `${key}.evidenceBytes summary is malformed`);
    if (!metricValid(item.redactedArtifactBytes, true)) error(errors, `${key}.redactedArtifactBytes summary is malformed`);
    if (keys.includes(item.key)) error(errors, `duplicate baseline v2 case: ${item.key}`); keys.push(item.key);
  }
  if (Array.isArray(fixtures?.order) && fixtures.order.some((key, index) => key !== keys[index])) error(errors, 'fixture order does not match case order');
  validateRetainedSamples(errors, report);
  return { ok: errors.length === 0, errors };
}

// A retained-sample record is optional, but when present it must be evidence: every declared batch,
// the full per-call series, and batch and case summaries that the retained series actually reproduces.
function validateRetainedSamples(errors, report) {
  const retained = report?.retainedSamples;
  if (retained === undefined) return;
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  const samples = report?.measurement?.samples; const batches = report?.measurement?.batches;
  const byteMetrics = ['rssBytes', 'serializedBytes', 'evidenceBytes', 'redactedArtifactBytes'];
  if (!record(retained) || Object.keys(retained).length !== cases.length || cases.some((item) => !record(item) || !record(retained[item.key]))) { error(errors, 'retained samples must cover every case exactly once'); return; }
  for (const item of cases) {
    const entries = retained[item.key]?.batches;
    const series = Array.isArray(entries) && entries.length === batches ? entries.map((batch) => batch?.latencyMs?.samples) : null;
    const metrics = item?.latencyMs ?? {};
    // A declared zero-sample or zero-batch policy would make the `every` checks below vacuously true and
    // then hand an empty array to `percentile`, which throws instead of returning validation errors.
    const policyIsPositive = Number.isInteger(samples) && samples > 0 && Number.isInteger(batches) && batches > 0;
    const ok = series !== null && policyIsPositive && series.every((values) => Array.isArray(values) && values.length === samples && values.every((value) => Number.isFinite(value) && value >= 0)) && entries.every((batch) => batch.latencyMs.p50 === percentile(batch.latencyMs.samples, 0.5) && batch.latencyMs.p95 === percentile(batch.latencyMs.samples, 0.95) && batch.latencyMs.max === Math.max(...batch.latencyMs.samples) && byteMetrics.every((key) => metricValid(batch[key], true))) && metrics.p50 === percentile(series.flat(), 0.5) && metrics.p95 === aggregateBatchP95(entries.map((batch) => batch.latencyMs.p95)) && metrics.max === Math.max(...entries.map((batch) => batch.latencyMs.max)) && byteMetrics.every((key) => item[key]?.max === Math.max(...entries.map((batch) => batch[key].max)));
    if (!ok) error(errors, `${item.key} retained samples are malformed`);
  }
}

function scanFixture(fixture) {
  const bytes = encoder.encode(fixture.json);
  return scanWorkflowV2({ bytes, profile: V2_ADAPTER_PROFILE, limits: DEFAULT_SCANNER_LIMITS_V2 });
}
// `redactedArtifactBytes` is an alias for the serialized result size: redaction-v2 is development-only
// and unwired (task 5.2a), no shipped path produces a redacted artifact, and nothing here invokes the
// redaction operation. The field name is retained because `docs/scanner/baseline-v2.json` is a pinned
// artifact; read it as a second, stricter serialized-byte bound, not as a redaction measurement.
function outputMetrics(outcome) {
  if (!outcome || typeof outcome !== 'object') throw new Error('MEASUREMENT_INVALID_OUTCOME');
  if (!outcome.ok) {
    if (typeof outcome.code !== 'string' || typeof outcome.message !== 'string') throw new Error('MEASUREMENT_INVALID_FAILURE');
    const serializedBytes = canonicalBytesV1(outcome).byteLength;
    return { outcome: 'FAILURE', status: null, failureCode: outcome.code, serializedBytes, evidenceBytes: 0, redactedArtifactBytes: serializedBytes };
  }
  const validation = validateScannerResultV2(outcome.result);
  if (!validation.ok) throw new Error(`MEASUREMENT_INVALID_RESULT:${validation.errors.slice(0, 2).join('|')}`);
  const serializedBytes = canonicalBytesV1(outcome.result).byteLength;
  const evidenceBytes = canonicalBytesV1({ analysis: outcome.result.analysis, facts: outcome.result.facts, traces: outcome.result.traces, findings: outcome.result.findings }).byteLength;
  return { outcome: 'SUCCESS', status: outcome.result.analysis.status, failureCode: null, serializedBytes, evidenceBytes, redactedArtifactBytes: serializedBytes };
}
function enforceBounds(fixture, metrics, elapsed) {
  if (metrics.serializedBytes > DEFAULT_SCANNER_LIMITS_V2.maxSerializedResultBytes) throw new Error(`SERIALIZED_RESULT_LIMIT:${fixture.id}`);
  if (metrics.evidenceBytes > DEFAULT_SCANNER_LIMITS_V2.maxEvidenceBytes) throw new Error(`EVIDENCE_LIMIT:${fixture.id}`);
  if (metrics.redactedArtifactBytes > DEFAULT_SCANNER_LIMITS_V2.maxRedactedArtifactBytes) throw new Error(`REDACTED_ARTIFACT_LIMIT:${fixture.id}`);
  if (fixture.fixtureClass === 'max-bound') {
    if (elapsed > 5_000) throw new Error(`MAX_BOUND_TIMEOUT:${fixture.id}`);
    if (fixture.kind === 'valid' && metrics.outcome !== 'SUCCESS') throw new Error(`MAX_BOUND_INVALID_OUTCOME:${fixture.id}:${metrics.failureCode}`);
  }
  if (fixture.kind === 'valid' && fixture.expectedStatus && metrics.status !== fixture.expectedStatus) throw new Error(`FIXTURE_STATUS_MISMATCH:${fixture.id}:${metrics.status}`);
  if (fixture.kind === 'rejected' && (metrics.outcome !== 'FAILURE' || metrics.failureCode !== fixture.rejectionCode)) throw new Error(`FIXTURE_FAILURE_MISMATCH:${fixture.id}:${metrics.failureCode}`);
}
function measureBatch(fixture, samples, warmups) {
  for (let index = 0; index < warmups; index += 1) scanFixture(fixture);
  const latency = []; const rss = []; const serialized = []; const evidence = []; const redacted = []; let first;
  for (let index = 0; index < samples; index += 1) {
    const before = process.memoryUsage().rss; const started = performance.now(); const outcome = scanFixture(fixture); const elapsed = performance.now() - started; const after = process.memoryUsage().rss;
    const metrics = outputMetrics(outcome); enforceBounds(fixture, metrics, elapsed); first ??= metrics;
    latency.push(elapsed); rss.push(Math.max(before, after)); serialized.push(metrics.serializedBytes); evidence.push(metrics.evidenceBytes); redacted.push(metrics.redactedArtifactBytes);
  }
  return { first, latency, rss, serialized, evidence, redacted };
}
function aggregateBatchSummary(batches, metric) {
  return summary(batches.flatMap((batch) => batch[metric]));
}
function measureCase(fixture, samples, warmups, batches) {
  const measurements = Array.from({ length: batches }, () => measureBatch(fixture, samples, warmups));
  const latencyMs = aggregateBatchSummary(measurements, 'latency');
  latencyMs.p95 = aggregateBatchP95(measurements.map((batch) => summary(batch.latency).p95));
  const first = measurements[0].first;
  return { item: { key: fixtureKey(fixture), id: fixture.id, kind: fixture.kind, fixtureClass: fixture.fixtureClass, profile: V2_ADAPTER_PROFILE, inputSha256: sha256(encoder.encode(fixture.json)), outcome: first.outcome, status: first.status, failureCode: first.failureCode, latencyMs, rssBytes: aggregateBatchSummary(measurements, 'rss'), serializedBytes: aggregateBatchSummary(measurements, 'serialized'), evidenceBytes: aggregateBatchSummary(measurements, 'evidence'), redactedArtifactBytes: aggregateBatchSummary(measurements, 'redacted') }, batches: measurements.map(batchEvidence) };
}
// A requested record retains the per-call latency series plus every metric's per-batch p50/p95/max, so a
// measured run can be re-derived and audited without rerunning the scanner. The pinned baseline stays
// summary-only; this evidence is never an input to the comparator's budget arithmetic.
function batchEvidence(batch) {
  return { latencyMs: { samples: [...batch.latency], ...summary(batch.latency) }, rssBytes: summary(batch.rss), serializedBytes: summary(batch.serialized), evidenceBytes: summary(batch.evidence), redactedArtifactBytes: summary(batch.redacted) };
}

export async function buildBaselineV2Report({ samples = MEASUREMENT_DEFAULTS_V2.samples, warmups = MEASUREMENT_DEFAULTS_V2.warmups, batches = MEASUREMENT_DEFAULTS_V2.batches, retainSamples = false } = {}) {
  if (!Number.isInteger(samples) || samples < 5 || samples > MEASUREMENT_MAX_SAMPLES_V2 || !Number.isInteger(warmups) || warmups < 1 || warmups > MEASUREMENT_MAX_WARMUPS_V2 || !Number.isInteger(batches) || batches < 1 || batches > MEASUREMENT_MAX_BATCHES_V2) throw new RangeError('samples must be 5..100, warmups must be 1..100, and batches must be 1..3');
  const source = await readFile(new URL(import.meta.url));
  const environment = { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? 'unknown', cpuCount: availableParallelism() };
  const tool = { scannerVersion: SCANNER_VERSION, hash: 'sha256', scriptSha256: sha256(source) };
  const ordered = orderFixtures(V2_ADAPTER_FIXTURE_MATRIX.map((fixture) => ({ ...fixture, profile: V2_ADAPTER_PROFILE })));
  const fixtures = ordered.map((fixture) => ({ id: fixture.id, kind: fixture.kind, fixtureClass: fixture.fixtureClass, inputSha256: sha256(encoder.encode(fixture.json)), rejectionCode: fixture.rejectionCode ?? null, expectedStatus: fixture.expectedStatus ?? null }));
  const measured = ordered.map((fixture) => {
    try { return measureCase(fixture, samples, warmups, batches); }
    catch (cause) { const code = cause instanceof Error ? cause.message.split(':', 1)[0] : 'FIXTURE_MEASUREMENT_FAILED'; throw new Error(`${code}:${fixture.id}`); }
  });
  const cases = measured.map(({ item }) => item);
  const report = {
    schemaVersion: BASELINE_V2_SCHEMA_VERSION,
    gate: 'scanner-v2-performance',
    claim: 'same-machine repeatability evidence; not cross-machine production performance',
    measurement: { warmups, samples, batches, aggregation: MEASUREMENT_AGGREGATION_V2, clock: 'performance.now', rss: 'process.memoryUsage.rss', serialization: 'secureflow-canonical-json-v1' },
    environment: { ...environment, digest: sha256(canonicalizeJson(environment)) },
    tool: { ...tool, digest: sha256(canonicalizeJson(tool)) },
    fixtures: { source: normalizedSource, profile: V2_ADAPTER_PROFILE, count: cases.length, order: cases.map((item) => item.key), digest: sha256(canonicalizeJson(fixtures)) },
    byteCeilings: { maxSerializedResultBytes: DEFAULT_SCANNER_LIMITS_V2.maxSerializedResultBytes, maxEvidenceBytes: DEFAULT_SCANNER_LIMITS_V2.maxEvidenceBytes, maxRedactedArtifactBytes: DEFAULT_SCANNER_LIMITS_V2.maxRedactedArtifactBytes },
    cases,
  };
  if (retainSamples) report.retainedSamples = Object.fromEntries(measured.map(({ item, batches: evidence }) => [item.key, { batches: evidence }]));
  return report;
}
async function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    try { await rename(temporary, path); }
    catch (cause) { if (!['EEXIST', 'EPERM'].includes(cause?.code)) throw cause; await unlink(path); await rename(temporary, path); }
  } catch (cause) { await unlink(temporary).catch(() => undefined); throw cause; }
}
async function writeBaseline(report) {
  const output = await withPreservedP95BudgetOverrides(report, BASELINE_V2_PATH, validateBaselineV2Report);
  return writeJsonFile(BASELINE_V2_PATH, output);
}
// One canonical identity per path, so `--record` cannot alias the pinned baseline through `docs/./`,
// `x/../`, differing case, a trailing dot or space that Windows ignores, or a symlinked parent. It is
// stricter than the host filesystem and fails closed: an unusable candidate is the pinned baseline.
export function isPinnedBaselinePath(candidate, baselinePath = BASELINE_V2_PATH) {
  if (typeof candidate !== 'string' || candidate.length === 0 || typeof baselinePath !== 'string' || baselinePath.length === 0) return true;
  const pinned = pathIdentity(baselinePath, 'real');
  return ['given', 'resolved', 'real'].some((mode) => { const identity = pathIdentity(candidate, mode); return identity === pinned || identity.endsWith(`/${pinned}`) || pinned.endsWith(`/${identity}`); });
}
function pathIdentity(value, mode) {
  const resolved = resolve(value); const parent = dirname(resolved);
  const target = `${mode === 'given' ? value : mode === 'real' && existsSync(parent) ? join(realpathSync.native(parent), basename(resolved)) : resolved}`.replaceAll('\\', '/');
  return target.split('/').reduce((segments, segment) => { const clean = segment.replace(/[. ]+$/, '').toLowerCase(); if (clean === '') return segments; if (clean === '..') segments.pop(); else segments.push(clean); return segments; }, []).join('/');
}
export function parseMeasurementArgs(args) {
  const options = { write: false, recordPath: undefined, samples: MEASUREMENT_DEFAULTS_V2.samples, warmups: MEASUREMENT_DEFAULTS_V2.warmups, batches: MEASUREMENT_DEFAULTS_V2.batches };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--write') options.write = true;
    else if (arg === '--record') { const value = args[++index]; if (value === undefined || value.startsWith('--')) throw new Error('missing value for --record'); options.recordPath = value; }
    else if (arg === '--samples' || arg === '--warmups' || arg === '--batches') { const value = Number(args[++index]); if (!Number.isInteger(value)) throw new Error(`invalid ${arg} value`); options[arg.slice(2)] = value; }
    else throw new Error(`unknown argument: ${arg}`);
  }
  // The pinned baseline stays summary-only: retained raw samples are audit evidence, not budget input,
  // so a retained-sample report must never be written over `docs/scanner/baseline-v2.json`.
  if (options.write && options.recordPath !== undefined) throw new Error('--write and --record are mutually exclusive');
  if (options.recordPath !== undefined && isPinnedBaselinePath(options.recordPath)) throw new Error('--record must not target the pinned baseline path');
  return options;
}
async function main() {
  const options = parseMeasurementArgs(process.argv.slice(2));
  const report = await buildBaselineV2Report({ samples: options.samples, warmups: options.warmups, batches: options.batches, retainSamples: options.recordPath !== undefined });
  const validation = validateBaselineV2Report(report);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  if (options.write) await writeBaseline(report); if (options.recordPath !== undefined) await writeJsonFile(resolve(options.recordPath), report);
  console.log(JSON.stringify({ ok: true, mode: options.write ? 'write' : options.recordPath !== undefined ? 'record' : 'measure', recordPath: options.recordPath ?? null, schemaVersion: report.schemaVersion, cases: report.cases.map(({ key, outcome, latencyMs, rssBytes, serializedBytes }) => ({ key, outcome, p95Ms: latencyMs.p95, rssBytes: rssBytes.max, serializedBytes: serializedBytes.max })) }));
}
const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) { try { await main(); } catch (cause) { console.error(`Scanner v2 measurement failed: ${cause instanceof Error ? cause.message : String(cause)}`); process.exitCode = 1; } }
