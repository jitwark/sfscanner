import { scanWorkflowV2, type ScanWorkflowV2Result } from '@hub/scanner-core/v2';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import type { ScannerResultV2 } from '../../contracts/scanner-v2-result';
import {
  createV2CalibrationCase,
  type V2CalibrationAuthority,
  type V2CalibrationCase,
  type V2CalibrationSplit,
  type V2AnalysisStatus,
  type V2ExpectedLabel,
  type V2ObservedState,
} from './v2-case-schema';

export type V2CalibrationScanRequest = { bytes: Uint8Array; profile: { id: string; version: string }; target: V2CalibrationCase['target'] };
export type V2CalibrationScanner = (request: V2CalibrationScanRequest) => ScanWorkflowV2Result;
export type V2CalibrationRunOptions = { split?: V2CalibrationSplit; scan?: V2CalibrationScanner; now?: () => number; memory?: () => number };
export type V2RuleMetric = {
  positiveDenominator: number; negativeDenominator: number; nearMissDenominator: number; unsupportedDenominator: number;
  observedPositiveCases: number; unknownCases: number; abstainedCases: number; degradedCases: number; omittedCases: number; rejectedCases: number;
  truePositiveCases: number; falsePositiveCases: number; falseNegativeCases: number; precision: number | null; recall: number | null;
};
export type V2CalibrationCaseResult = {
  caseId: string; split: V2CalibrationSplit; provenance: V2CalibrationCase['provenance']; review?: V2CalibrationCase['review']; target: V2CalibrationCase['target']; profile: V2CalibrationCase['profile']; authority: V2CalibrationAuthority;
  expectedLabel: V2ExpectedLabel; observedState: V2ObservedState; expectedRuleIds: readonly string[]; observedRuleIds: readonly string[];
  truePositiveRules: readonly string[]; falsePositiveRules: readonly string[]; falseNegativeRules: readonly string[]; unknownRules: readonly string[];
  expectedAnalysisStatus?: V2AnalysisStatus; observedAnalysisStatus: V2AnalysisStatus; identityMismatches: readonly string[];
  scannerError?: string; counters: { latencyMs: number; memoryBytes: number; serializedBytes: number };
};
export type V2CalibrationReport = {
  schemaVersion: 'calibration-report-v2'; split: V2CalibrationSplit; caseCount: number; cases: readonly V2CalibrationCaseResult[];
  ruleMetrics: Readonly<Record<string, V2RuleMetric>>; totals: { latencyMs: number; memoryBytes: number; serializedBytes: number };
};
export class V2CalibrationRunnerError extends Error {
  constructor(public readonly code: 'DUPLICATE_ID' | 'HOLDOUT_SEPARATION' | 'STALE_AUTHORITY', message: string) { super(message); this.name = 'V2CalibrationRunnerError'; }
}

const compare = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;
const clockZero = (): number => 0;
const memoryZero = (): number => 0;
function ratio(numerator: number, denominator: number): number | null { return denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 1000; }
function uniqueSorted(values: readonly string[]): string[] { return [...new Set(values)].sort(compare); }
function authorityOf(result: ScannerResultV2): V2CalibrationAuthority { return { engine: result.engine, profile: result.profile, ruleset: result.ruleset, semantics: result.semantics }; }
function sameAuthority(expected: V2CalibrationAuthority, observed: V2CalibrationAuthority): boolean { return canonicalizeJson(expected) === canonicalizeJson(observed); }
function expectedLabels(fixture: V2CalibrationCase): ReadonlyMap<string, V2ExpectedLabel> { return new Map(fixture.expected.rules.map((rule) => [rule.ruleId, rule.label])); }
function state(result: ScannerResultV2): V2ObservedState {
  if (result.stats.omittedFindings > 0) return 'OMITTED';
  if (result.analysis.status === 'DEGRADED') return 'DEGRADED';
  if (result.analysis.status === 'INDETERMINATE') return 'ABSTAINED';
  if (result.findings.some((finding) => finding.conclusion === 'UNKNOWN' || finding.applicability === 'UNKNOWN')) return 'UNKNOWN';
  return result.findings.some((finding) => finding.conclusion === 'OBSERVED' && finding.applicability === 'APPLICABLE') ? 'POSITIVE' : 'NEGATIVE';
}
function resultFor(fixture: V2CalibrationCase, scan: V2CalibrationScanner, now: () => number, memory: () => number): V2CalibrationCaseResult {
  const start = now(); const before = memory(); const outcome = scan({ bytes: Uint8Array.prototype.slice.call(fixture.bytes) as Uint8Array, profile: fixture.profile, target: fixture.target }); const latency = Math.max(0, Math.round((now() - start) * 1000) / 1000); const memoryBytes = Math.max(0, memory() - before);
  if (!outcome.ok) return { caseId: fixture.id, split: fixture.split, provenance: fixture.provenance, ...(fixture.review === undefined ? {} : { review: fixture.review }), target: fixture.target, profile: fixture.profile, authority: fixture.authority, expectedLabel: fixture.expected.label, observedState: 'REJECTED', expectedRuleIds: fixture.expected.rules.map((rule) => rule.ruleId).sort(compare), observedRuleIds: [], truePositiveRules: [], falsePositiveRules: [], falseNegativeRules: fixture.expected.rules.filter((rule) => rule.label === 'POSITIVE').map((rule) => rule.ruleId), unknownRules: [], expectedAnalysisStatus: fixture.expected.analysisStatus, observedAnalysisStatus: 'REJECTED', identityMismatches: fixture.expected.analysisStatus === 'REJECTED' ? [] : [`expected ${fixture.expected.analysisStatus ?? 'scan result'}, observed rejection`], scannerError: outcome.code, counters: { latencyMs: latency, memoryBytes, serializedBytes: 0 } };
  const result = outcome.result; const observedAuthority = authorityOf(result); if (!sameAuthority(fixture.authority, observedAuthority)) throw new V2CalibrationRunnerError('STALE_AUTHORITY', `Calibration case ${fixture.id} has stale scanner authority digests.`);
  if (result.input.rawSha256 !== fixture.provenance.digest || result.input.utf8Bytes !== fixture.bytes.byteLength) throw new V2CalibrationRunnerError('STALE_AUTHORITY', `Calibration case ${fixture.id} lost source digest lineage.`);
  const observedRuleIds = uniqueSorted(result.findings.map((finding) => finding.ruleId)); const labels = expectedLabels(fixture); const observedPositive = uniqueSorted(result.findings.filter((finding) => finding.conclusion === 'OBSERVED' && finding.applicability === 'APPLICABLE').map((finding) => finding.ruleId)); const unknownRules = uniqueSorted(result.findings.filter((finding) => finding.conclusion === 'UNKNOWN' || finding.applicability === 'UNKNOWN').map((finding) => finding.ruleId));
  const expectedPositive = fixture.expected.rules.filter((rule) => rule.label === 'POSITIVE').map((rule) => rule.ruleId); const truePositiveRules = expectedPositive.filter((ruleId) => observedPositive.includes(ruleId)); const falseNegativeRules = expectedPositive.filter((ruleId) => !observedPositive.includes(ruleId)); const falsePositiveRules = observedPositive.filter((ruleId) => labels.get(ruleId) !== 'POSITIVE');
  const mismatches = fixture.expected.analysisStatus !== undefined && fixture.expected.analysisStatus !== result.analysis.status ? [`expected analysis ${fixture.expected.analysisStatus}, observed ${result.analysis.status}`] : [];
  return { caseId: fixture.id, split: fixture.split, provenance: fixture.provenance, ...(fixture.review === undefined ? {} : { review: fixture.review }), target: fixture.target, profile: fixture.profile, authority: observedAuthority, expectedLabel: fixture.expected.label, observedState: state(result), expectedRuleIds: fixture.expected.rules.map((rule) => rule.ruleId).sort(compare), observedRuleIds, truePositiveRules, falsePositiveRules, falseNegativeRules, unknownRules, expectedAnalysisStatus: fixture.expected.analysisStatus, observedAnalysisStatus: result.analysis.status, identityMismatches: mismatches, counters: { latencyMs: latency, memoryBytes, serializedBytes: result.stats.serializedBytes } };
}
function metricFor(cases: readonly V2CalibrationCaseResult[], ruleId: string, labelsByCase: ReadonlyMap<string, ReadonlyMap<string, V2ExpectedLabel>>): V2RuleMetric {
  let positiveDenominator = 0, negativeDenominator = 0, nearMissDenominator = 0, unsupportedDenominator = 0, observedPositiveCases = 0, unknownCases = 0, abstainedCases = 0, degradedCases = 0, omittedCases = 0, rejectedCases = 0, truePositiveCases = 0, falsePositiveCases = 0, falseNegativeCases = 0;
  for (const item of cases) { const label = labelsByCase.get(item.caseId)?.get(ruleId); if (label === 'POSITIVE') positiveDenominator += 1; if (label === 'NEGATIVE') negativeDenominator += 1; if (label === 'NEAR_MISS') nearMissDenominator += 1; if (label === 'UNSUPPORTED') unsupportedDenominator += 1; const observed = item.observedRuleIds.includes(ruleId); const positive = item.truePositiveRules.includes(ruleId); const observedPositive = positive || item.falsePositiveRules.includes(ruleId); if (observedPositive) observedPositiveCases += 1; if (item.unknownRules.includes(ruleId)) unknownCases += 1; if (item.observedState === 'ABSTAINED' && (label !== undefined || observed)) abstainedCases += 1; if (item.observedState === 'DEGRADED' && (label !== undefined || observed)) degradedCases += 1; if (item.observedState === 'OMITTED' && (label !== undefined || observed)) omittedCases += 1; if (item.observedState === 'REJECTED' && (label !== undefined || observed)) rejectedCases += 1; if (positive) truePositiveCases += 1; if (item.falsePositiveRules.includes(ruleId)) falsePositiveCases += 1; if (label === 'POSITIVE' && !positive) falseNegativeCases += 1; }
  return { positiveDenominator, negativeDenominator, nearMissDenominator, unsupportedDenominator, observedPositiveCases, unknownCases, abstainedCases, degradedCases, omittedCases, rejectedCases, truePositiveCases, falsePositiveCases, falseNegativeCases, precision: ratio(truePositiveCases, truePositiveCases + falsePositiveCases), recall: ratio(truePositiveCases, positiveDenominator) };
}
export function runCalibrationV2(cases: readonly unknown[], options: V2CalibrationRunOptions = {}): V2CalibrationReport {
  const split = options.split ?? 'development'; const fixtures = cases.map(createV2CalibrationCase); const ids = new Set<string>();
  for (const fixture of fixtures) { if (ids.has(fixture.id)) throw new V2CalibrationRunnerError('DUPLICATE_ID', `Calibration corpus has duplicate case ID ${fixture.id}.`); ids.add(fixture.id); if (fixture.split !== split) throw new V2CalibrationRunnerError('HOLDOUT_SEPARATION', `Calibration case ${fixture.id} is outside the ${split} split (holdout separation enforced).`); }
  if (fixtures.length === 0) throw new V2CalibrationRunnerError('HOLDOUT_SEPARATION', 'Calibration corpus must contain at least one selected case.');
  const now = options.now ?? clockZero; const memory = options.memory ?? memoryZero; const scan = options.scan ?? (scanWorkflowV2 as V2CalibrationScanner); const ordered = [...fixtures].sort((left, right) => compare(left.id, right.id)); const results = ordered.map((fixture) => resultFor(fixture, scan, now, memory));
  const labelsByCase = new Map(ordered.map((fixture) => [fixture.id, expectedLabels(fixture)])); const ruleIds = uniqueSorted(results.flatMap((result) => [...result.expectedRuleIds, ...result.observedRuleIds]));
  const totals = { latencyMs: Math.round(results.reduce((sum, result) => sum + result.counters.latencyMs, 0) * 1000) / 1000, memoryBytes: results.reduce((sum, result) => sum + result.counters.memoryBytes, 0), serializedBytes: results.reduce((sum, result) => sum + result.counters.serializedBytes, 0) };
  return { schemaVersion: 'calibration-report-v2', split, caseCount: results.length, cases: results, ruleMetrics: Object.fromEntries(ruleIds.map((ruleId) => [ruleId, metricFor(results, ruleId, labelsByCase)])), totals };
}
