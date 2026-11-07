import type { V2CalibrationProvenance, V2ExpectedLabel, V2ExpectedRule, V2ObservedState } from './v2-case-schema';
import { isSettledAdjudication, type V2Adjudication } from './v2-adjudication';

export type V2MetricMeasurements = { latencyMs: number; memoryBytes: number; rssBytes: number; serializedBytes: number };
export type V2MetricCase = {
  caseId: string;
  provenance: V2CalibrationProvenance;
  adjudication: V2Adjudication;
  expectedRules: readonly V2ExpectedRule[];
  observedRuleIds: readonly string[];
  unknownRuleIds?: readonly string[];
  observedState: V2ObservedState;
  measurements: V2MetricMeasurements;
};
export type V2FalseNegativeClass = 'MISSING' | 'UNKNOWN' | 'ABSTENTION' | 'DEGRADATION' | 'OMITTED' | 'REJECTED';
export type V2ConfidenceInterval = { lower: number; upper: number; confidence: 0.95; method: 'WILSON' };
export type V2RuleMetric = {
  ruleId: string;
  status: 'READY' | 'PARTIAL' | 'UNAVAILABLE';
  settledCases: number;
  unresolvedCases: number;
  positiveDenominator: number;
  negativeDenominator: number;
  nearMissDenominator: number;
  unsupportedDenominator: number;
  observedPositiveCases: number;
  unknownCases: number;
  abstentionCases: number;
  degradedCases: number;
  omittedCases: number;
  rejectedCases: number;
  truePositiveCases: number;
  falsePositiveCases: number;
  falseNegativeCases: number;
  precision: number | null;
  recall: number | null;
  precisionInterval: V2ConfidenceInterval | null;
  recallInterval: V2ConfidenceInterval | null;
  falseNegativeClasses: Readonly<Record<V2FalseNegativeClass, number>>;
  abstentionRate: number | null;
  degradationRate: number | null;
  latencyMsTotal: number;
  memoryBytesTotal: number;
  rssBytesTotal: number;
  serializedBytesTotal: number;
};
export type V2MetricsReport = {
  schemaVersion: 'calibration-metrics-v2';
  status: 'READY' | 'PARTIAL' | 'INSUFFICIENT_EVIDENCE';
  caseIds: readonly string[];
  settledCaseCount: number;
  unresolvedCaseCount: number;
  interval: { method: 'WILSON'; confidence: 0.95 };
  ruleMetrics: Readonly<Record<string, V2RuleMetric>>;
  totals: { latencyMs: number; memoryBytes: number; rssBytes: number; serializedBytes: number };
};

type Accumulator = Omit<V2RuleMetric, 'ruleId' | 'status' | 'precision' | 'recall' | 'precisionInterval' | 'recallInterval' | 'falseNegativeClasses' | 'abstentionRate' | 'degradationRate'> & { falseNegativeClasses: Record<V2FalseNegativeClass, number> };
const DIGEST = /^[0-9a-f]{64}$/;
const MEASUREMENT_KEYS = ['latencyMs', 'memoryBytes', 'rssBytes', 'serializedBytes'] satisfies readonly (keyof V2MetricMeasurements)[];
const compare = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;
function fail(message: string): never { throw new Error(`Calibration metrics: ${message}`); }
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is invalid.`);
  return value;
}
function parseLabel(value: unknown, label: string): V2ExpectedLabel {
  if (value === 'POSITIVE' || value === 'NEGATIVE' || value === 'NEAR_MISS' || value === 'UNSUPPORTED') return value;
  fail(`${label} is invalid.`);
}
function parseState(value: unknown): V2ObservedState {
  if (value === 'POSITIVE' || value === 'NEGATIVE' || value === 'UNKNOWN' || value === 'ABSTAINED' || value === 'DEGRADED' || value === 'OMITTED' || value === 'REJECTED') return value;
  fail('observedState is invalid.');
}
function plain(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail(`${label} must be a plain object.`);
  const result: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(`${label}.${name} must be enumerable data.`);
    result[name] = descriptor.value;
  }
  return result;
}
function validateProvenance(value: unknown): void {
  const raw = plain(value, 'provenance');
  for (const key of ['source', 'commit', 'path', 'licence', 'permission']) text(raw[key], `provenance.${key}`);
  if (typeof raw.digest !== 'string' || !DIGEST.test(raw.digest)) fail('provenance.digest is invalid.');
}
function validateRules(value: unknown, label: string): void {
  if (!Array.isArray(value)) fail(`${label} is required.`);
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const raw = plain(item, `${label}[${index}]`);
    const ruleId = text(raw.ruleId, `${label}[${index}].ruleId`);
    parseLabel(raw.label, `${label}[${index}].label`);
    if (seen.has(ruleId)) fail(`${label} has duplicate rule IDs.`);
    seen.add(ruleId);
  }
}
function validateIds(value: unknown, label: string): void {
  if (!Array.isArray(value)) fail(`${label} is required.`);
  const seen = new Set<string>();
  for (const item of value) { const id = text(item, label); if (seen.has(id)) fail(`${label} has duplicate rule IDs.`); seen.add(id); }
}
function validateCase(item: V2MetricCase): void {
  text(item.caseId, 'caseId');
  validateProvenance(item.provenance);
  if (item.adjudication === null || typeof item.adjudication !== 'object') fail(`case ${item.caseId} is missing adjudication.`);
  if (item.adjudication.caseId !== item.caseId) fail(`case ${item.caseId} adjudication identity mismatches.`);
  if (item.adjudication.status !== 'AGREED' && item.adjudication.status !== 'RESOLVED' && item.adjudication.status !== 'DISPUTED' && item.adjudication.status !== 'HUMAN_REQUIRED' && item.adjudication.status !== 'INSUFFICIENT_EVIDENCE') fail(`case ${item.caseId} adjudication status is invalid.`);
  validateProvenance(item.adjudication.provenance);
  if (item.adjudication.provenance.digest !== item.provenance.digest || item.adjudication.provenance.licence !== item.provenance.licence || item.adjudication.provenance.permission !== item.provenance.permission) fail(`case ${item.caseId} adjudication provenance mismatches.`);
  validateRules(item.adjudication.rules, `case ${item.caseId}.adjudication.rules`);
  if (!Array.isArray(item.adjudication.decisions)) fail(`case ${item.caseId}.adjudication.decisions are missing.`);
  if (isSettledAdjudication(item.adjudication) !== (item.adjudication.label !== undefined)) fail(`case ${item.caseId}.adjudication label/status is inconsistent.`);
  if (item.adjudication.label !== undefined) parseLabel(item.adjudication.label, `case ${item.caseId}.adjudication.label`);
  validateRules(item.expectedRules, `case ${item.caseId}.expectedRules`);
  validateIds(item.observedRuleIds, `case ${item.caseId}.observedRuleIds`);
  if (item.unknownRuleIds !== undefined) validateIds(item.unknownRuleIds, `case ${item.caseId}.unknownRuleIds`);
  parseState(item.observedState);
  if (item.measurements === null || typeof item.measurements !== 'object') fail(`case ${item.caseId}.measurements is missing.`);
  for (const key of MEASUREMENT_KEYS) {
    const value = item.measurements[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`case ${item.caseId}.measurements.${key} must be finite and non-negative.`);
  }
}
export function wilson95(successes: number, total: number): readonly [number, number] | null {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(total) || total < 0 || successes < 0 || successes > total) throw new TypeError('Invalid binomial counts');
  if (total === 0) return null;
  const z = 1.959963984540054;
  const proportion = successes / total;
  const denominator = 1 + z * z / total;
  const centre = (proportion + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((proportion * (1 - proportion) + z * z / (4 * total)) / total) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}
function interval(success: number, total: number): V2ConfidenceInterval | null {
  const bounds = wilson95(success, total);
  return bounds === null ? null : { lower: bounds[0], upper: bounds[1], confidence: 0.95, method: 'WILSON' };
}
function ratio(numerator: number, denominator: number): number | null { return denominator === 0 ? null : numerator / denominator; }
function emptyClasses(): Record<V2FalseNegativeClass, number> { return { MISSING: 0, UNKNOWN: 0, ABSTENTION: 0, DEGRADATION: 0, OMITTED: 0, REJECTED: 0 }; }
function classify(item: V2MetricCase, ruleId: string): V2FalseNegativeClass {
  if ((item.unknownRuleIds ?? []).includes(ruleId) || item.observedState === 'UNKNOWN') return 'UNKNOWN';
  if (item.observedState === 'ABSTAINED') return 'ABSTENTION';
  if (item.observedState === 'DEGRADED') return 'DEGRADATION';
  if (item.observedState === 'OMITTED') return 'OMITTED';
  if (item.observedState === 'REJECTED') return 'REJECTED';
  return 'MISSING';
}
function newAccumulator(): Accumulator {
  return { settledCases: 0, unresolvedCases: 0, positiveDenominator: 0, negativeDenominator: 0, nearMissDenominator: 0, unsupportedDenominator: 0, observedPositiveCases: 0, unknownCases: 0, abstentionCases: 0, degradedCases: 0, omittedCases: 0, rejectedCases: 0, truePositiveCases: 0, falsePositiveCases: 0, falseNegativeCases: 0, latencyMsTotal: 0, memoryBytesTotal: 0, rssBytesTotal: 0, serializedBytesTotal: 0, falseNegativeClasses: emptyClasses() };
}
export function computeRuleMetrics(inputs: readonly V2MetricCase[]): V2MetricsReport {
  if (!Array.isArray(inputs)) fail('cases must be an array.');
  const ordered = [...inputs].sort((left, right) => compare(left.caseId, right.caseId));
  const caseIds: string[] = []; const seenCases = new Set<string>(); const ruleIds = new Set<string>();
  for (const item of ordered) {
    validateCase(item);
    if (seenCases.has(item.caseId)) fail(`duplicate case ID ${item.caseId}.`);
    seenCases.add(item.caseId); caseIds.push(item.caseId);
    for (const rule of item.expectedRules) ruleIds.add(rule.ruleId);
    for (const ruleId of item.observedRuleIds) ruleIds.add(ruleId);
    for (const ruleId of item.unknownRuleIds ?? []) ruleIds.add(ruleId);
  }
  if (ordered.length === 0) fail('cases must contain at least one case.');
  const sortedRuleIds = [...ruleIds].sort(compare); const accumulators: Record<string, Accumulator> = {};
  for (const ruleId of sortedRuleIds) accumulators[ruleId] = newAccumulator();
  let settledCaseCount = 0; let latencyMs = 0; let memoryBytes = 0; let rssBytes = 0; let serializedBytes = 0;
  for (const item of ordered) {
    const settled = isSettledAdjudication(item.adjudication); if (settled) settledCaseCount += 1;
    latencyMs += item.measurements.latencyMs; memoryBytes += item.measurements.memoryBytes; rssBytes += item.measurements.rssBytes; serializedBytes += item.measurements.serializedBytes;
    for (const ruleId of sortedRuleIds) {
      const expected = item.expectedRules.find((rule: V2ExpectedRule) => rule.ruleId === ruleId)?.label;
      const relevant = expected !== undefined || item.observedRuleIds.includes(ruleId) || (item.unknownRuleIds ?? []).includes(ruleId);
      if (!relevant) continue;
      const metric = accumulators[ruleId]!;
      if (!settled) { metric.unresolvedCases += 1; continue; }
      metric.settledCases += 1; metric.latencyMsTotal += item.measurements.latencyMs; metric.memoryBytesTotal += item.measurements.memoryBytes; metric.rssBytesTotal += item.measurements.rssBytes; metric.serializedBytesTotal += item.measurements.serializedBytes;
      if (expected === 'POSITIVE') metric.positiveDenominator += 1;
      if (expected === 'NEGATIVE') metric.negativeDenominator += 1;
      if (expected === 'NEAR_MISS') metric.nearMissDenominator += 1;
      if (expected === 'UNSUPPORTED') metric.unsupportedDenominator += 1;
      if ((item.unknownRuleIds ?? []).includes(ruleId) || item.observedState === 'UNKNOWN') metric.unknownCases += 1;
      if (item.observedState === 'ABSTAINED') metric.abstentionCases += 1;
      if (item.observedState === 'DEGRADED') metric.degradedCases += 1;
      if (item.observedState === 'OMITTED') metric.omittedCases += 1;
      if (item.observedState === 'REJECTED') metric.rejectedCases += 1;
      const observed = item.observedRuleIds.includes(ruleId) && !(item.unknownRuleIds ?? []).includes(ruleId) && item.observedState !== 'UNKNOWN';
      if (observed) metric.observedPositiveCases += 1;
      if (expected === 'POSITIVE' && observed) metric.truePositiveCases += 1;
      if (expected !== 'POSITIVE' && observed) metric.falsePositiveCases += 1;
      if (expected === 'POSITIVE' && !observed) { metric.falseNegativeCases += 1; metric.falseNegativeClasses[classify(item, ruleId)] += 1; }
    }
  }
  if (![latencyMs, memoryBytes, rssBytes, serializedBytes].every(Number.isFinite)) fail('measurement totals overflowed finite range.');
  const metrics: Record<string, V2RuleMetric> = {};
  for (const ruleId of sortedRuleIds) {
    const metric = accumulators[ruleId]!; const precisionDenominator = metric.truePositiveCases + metric.falsePositiveCases;
    const status = settledCaseCount === 0 ? 'UNAVAILABLE' : metric.unresolvedCases === 0 ? 'READY' : 'PARTIAL';
    metrics[ruleId] = Object.freeze({ ruleId, status, ...metric, precision: ratio(metric.truePositiveCases, precisionDenominator), recall: ratio(metric.truePositiveCases, metric.positiveDenominator), precisionInterval: interval(metric.truePositiveCases, precisionDenominator), recallInterval: interval(metric.truePositiveCases, metric.positiveDenominator), falseNegativeClasses: Object.freeze(metric.falseNegativeClasses), abstentionRate: ratio(metric.abstentionCases, metric.settledCases), degradationRate: ratio(metric.degradedCases, metric.settledCases) });
  }
  return Object.freeze({ schemaVersion: 'calibration-metrics-v2', status: settledCaseCount === 0 ? 'INSUFFICIENT_EVIDENCE' : settledCaseCount === ordered.length ? 'READY' : 'PARTIAL', caseIds: Object.freeze(caseIds), settledCaseCount, unresolvedCaseCount: ordered.length - settledCaseCount, interval: Object.freeze({ method: 'WILSON', confidence: 0.95 }), ruleMetrics: Object.freeze(metrics), totals: Object.freeze({ latencyMs, memoryBytes, rssBytes, serializedBytes }) });
}
