import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import { resolvePolicyProfile } from '@hub/scanner-core/policies/profile';
import type { PolicyEffect, ScanSeverity } from '@hub/scanner-core/policy';
import { scanJson } from '../cli/scan-core.js';
import {
  canonicalFixtureHash,
  type CalibrationCase,
  type CalibrationCaseResult,
  type CalibrationExpectedFinding,
  type CalibrationPolicyMetric,
  type CalibrationReport,
  type CalibrationRunOptions,
  type CalibrationThemeMetric,
  type ObservedFindingIdentity,
} from './calibration-types.js';

const SEVERITIES: readonly ScanSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const STATUSES = ['COMPLETE', 'DEGRADED', 'INDETERMINATE', 'REJECTED'] as const;
const GRADES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'NOT_GRADED'] as const;
const SPLITS = ['development', 'holdout'] as const;
const STRATA = ['clean-negative', 'legacy-policy', 'credential', 'network', 'hardened-code', 'hardened-taint', 'ai-autonomy', 'completeness', 'resource-adversarial', 'input-adversarial', 'analyzer-adversarial'] as const;
const THEMES = ['clean-controls', 'legacy-capability', 'credential-shape', 'domain-allowlist', 'hardened-code', 'hardened-taint', 'ai-control', 'completeness-boundary', 'resource-boundary', 'input-boundary', 'analyzer-boundary'] as const;

export class CalibrationValidationError extends Error {
  constructor(public readonly code: 'INVALID_FIXTURE_METADATA' | 'INVALID_EXPECTED_IDENTITY' | 'FIXTURE_HASH_MISMATCH', message: string) {
    super(message);
    this.name = 'CalibrationValidationError';
  }
}

export function runCalibration(cases: readonly CalibrationCase[], options: CalibrationRunOptions = {}): CalibrationReport {
  validateCorpus(cases);
  const clock = options.now ?? (() => performance.now());
  const ordered = [...cases].sort((left, right) => compare(left.id, right.id));
  const results = ordered.map((fixture) => runCase(fixture, clock));
  const profile = resolvePolicyProfile(ordered[0]!.profile);
  if (!profile.ok) invalidMetadata(ordered[0]!.id, 'scanner profile');
  const policyIds = [...new Set(results.flatMap((result) => [...result.expectedPolicyIds, ...result.observedPolicyIds]))].sort(compare);
  const themes = [...new Set(results.map((result) => result.confusionTheme))].sort(compare);
  return {
    schemaVersion: 'calibration-report-v1', scannerVersion: profile.version, caseCount: results.length,
    splitCounts: { development: results.filter((result) => result.split === 'development').length, holdout: results.filter((result) => result.split === 'holdout').length },
    metrics: Object.fromEntries(policyIds.map((policyId) => [policyId, metricFor(results, policyId)])),
    confusionThemes: themes.map((theme) => themeMetric(results, theme)),
    falseNegativeProbeIds: ordered.filter((fixture) => fixture.falseNegativeProbe).map((fixture) => fixture.id),
    observedFalseNegativeCaseIds: results.filter((result) => result.falseNegativePolicies.length > 0).map((result) => result.caseId),
    gradeHistogram: histogram(GRADES, results.map((result) => result.grade)),
    statusHistogram: histogram(STATUSES, results.map((result) => result.status === 'REJECTED' ? 'REJECTED' : result.completeness)),
    runtime: runtimeSummary(results.map((result) => result.durationMs), options.deviceProfile ?? 'local-node-runtime'),
    cases: results,
  };
}

function validateCorpus(cases: readonly CalibrationCase[]): void {
  if (cases.length === 0) throw new CalibrationValidationError('INVALID_FIXTURE_METADATA', 'Calibration corpus must contain at least one case.');
  const ids = new Set<string>();
  for (const fixture of cases) {
    if (!fixture || typeof fixture !== 'object') invalidMetadata(String(fixture), 'case shape');
    if (ids.has(fixture.id) || !/^[a-z0-9][a-z0-9-]+$/.test(fixture.id)) invalidMetadata(fixture.id, 'stable id');
    ids.add(fixture.id);
    if (!SPLITS.includes(fixture.split) || !STRATA.includes(fixture.stratum) || !THEMES.includes(fixture.confusionTheme)) invalidMetadata(fixture.id, 'corpus metadata');
    if (typeof fixture.workflowJson !== 'string' || !fixture.workflowJson || typeof fixture.reviewer !== 'string' || !fixture.reviewer.trim() || typeof fixture.rationale !== 'string' || !fixture.rationale.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(fixture.reviewDate) || !Array.isArray(fixture.allowedEvidenceNotes) || fixture.allowedEvidenceNotes.length === 0 || fixture.allowedEvidenceNotes.some((note) => typeof note !== 'string' || !note.trim())) invalidMetadata(fixture.id, 'review metadata');
    if (!Array.isArray(fixture.approvedDomains) || fixture.approvedDomains.some((domain) => typeof domain !== 'string' || !domain)) invalidMetadata(fixture.id, 'approved domains');
    if (!/^[0-9a-f]{64}$/.test(fixture.canonicalFixtureHash)) invalidMetadata(fixture.id, 'canonical hash format');
    try {
      if (canonicalFixtureHash(fixture.canonicalFixture) !== fixture.canonicalFixtureHash) throw new CalibrationValidationError('FIXTURE_HASH_MISMATCH', `Fixture ${fixture.id} has a mismatched canonical hash.`);
      if (fixture.expectedStatus === 'ACCEPTED' && canonicalizeJson(JSON.parse(fixture.workflowJson)) !== canonicalizeJson(fixture.canonicalFixture)) invalidMetadata(fixture.id, 'workflow JSON differs from canonical fixture');
    } catch (error) {
      if (error instanceof CalibrationValidationError) throw error;
      invalidMetadata(fixture.id, 'canonical fixture');
    }
    if (!['ACCEPTED', 'REJECTED'].includes(fixture.expectedStatus) || ![...STATUSES, 'NOT_APPLICABLE'].includes(fixture.expectedCompleteness)) invalidMetadata(fixture.id, 'status expectation');
    if (fixture.expectedStatus === 'REJECTED' && (!fixture.expectedRejectionCode || fixture.expectedCompleteness !== 'NOT_APPLICABLE' || fixture.canonicalFixture !== fixture.workflowJson)) invalidMetadata(fixture.id, 'rejection expectation');
    if (fixture.expectedStatus === 'ACCEPTED' && (fixture.expectedRejectionCode !== undefined || fixture.expectedCompleteness === 'NOT_APPLICABLE')) invalidMetadata(fixture.id, 'accepted expectation');
    validateExpectedFindings(fixture);
  }
}

function validateExpectedFindings(fixture: CalibrationCase): void {
  const profile = resolvePolicyProfile(fixture.profile);
  if (!profile.ok) invalidMetadata(fixture.id, 'scanner profile');
  const seen = new Set<string>();
  if (!Array.isArray(fixture.expectedFindings)) invalidMetadata(fixture.id, 'expected findings');
  for (const expected of fixture.expectedFindings) {
    if (seen.has(expected.policyId)) invalidExpected(fixture.id, 'duplicate policy label');
    seen.add(expected.policyId);
    const catalog = profile.ruleCatalog.find((entry) => entry.policyId === expected.policyId);
    if (!catalog) invalidExpected(fixture.id, `policy ${expected.policyId} is not in ${fixture.profile}`);
    if (catalog.policyEffect !== expected.effect || !Array.isArray(expected.severities) || expected.severities.length === 0 || expected.severities.some((severity: ScanSeverity) => !SEVERITIES.includes(severity))) invalidExpected(fixture.id, `policy ${expected.policyId} effect or severity`);
    if (new Set(expected.severities).size !== expected.severities.length) invalidExpected(fixture.id, `policy ${expected.policyId} has duplicate severities`);
  }
}

function runCase(fixture: CalibrationCase, clock: () => number): CalibrationCaseResult {
  const started = clock();
  const outcome = scanJson(fixture.workflowJson, { profile: fixture.profile, approvedDomains: [...fixture.approvedDomains] });
  const durationMs = roundMs(Math.max(0, clock() - started));
  if (!outcome.ok) return rejectedResult(fixture, outcome.code, durationMs);
  const observedFindings = observedIdentities(outcome.result.findings);
  const expectedIds = fixture.expectedFindings.map((finding) => finding.policyId).sort(compare);
  const observedIds = observedFindings.map((finding) => finding.policyId);
  const expectedSet = new Set(expectedIds), observedSet = new Set(observedIds);
  const truePositivePolicies = expectedIds.filter((policyId) => observedSet.has(policyId));
  const falseNegativePolicies = expectedIds.filter((policyId) => !observedSet.has(policyId));
  const falsePositivePolicies = observedIds.filter((policyId) => !expectedSet.has(policyId));
  const mismatches = identityMismatches(fixture, observedFindings, outcome.result.analysisStatus);
  const status = 'ACCEPTED' as const;
  if (fixture.expectedStatus !== status) mismatches.push(`expected status ${fixture.expectedStatus}, observed ${status}`);
  return { caseId: fixture.id, split: fixture.split, stratum: fixture.stratum, confusionTheme: fixture.confusionTheme, status, completeness: outcome.result.analysisStatus, expectedPolicyIds: expectedIds, observedPolicyIds: observedIds, observedFindings, truePositivePolicies, falsePositivePolicies, falseNegativePolicies, identityMismatches: mismatches.sort(compare), grade: outcome.result.riskAssessment?.grade ?? 'NOT_GRADED', durationMs };
}

function rejectedResult(fixture: CalibrationCase, errorCode: string, durationMs: number): CalibrationCaseResult {
  const expectedIds = fixture.expectedFindings.map((finding) => finding.policyId).sort(compare);
  const mismatches = [...(fixture.expectedStatus === 'ACCEPTED' ? [`expected accepted result, observed rejection ${errorCode}`] : []), ...(fixture.expectedRejectionCode !== errorCode ? [`expected rejection ${fixture.expectedRejectionCode ?? 'none'}, observed ${errorCode}`] : [])];
  return { caseId: fixture.id, split: fixture.split, stratum: fixture.stratum, confusionTheme: fixture.confusionTheme, status: 'REJECTED', completeness: 'NOT_APPLICABLE', expectedPolicyIds: expectedIds, observedPolicyIds: [], observedFindings: [], truePositivePolicies: [], falsePositivePolicies: [], falseNegativePolicies: expectedIds, identityMismatches: mismatches, grade: 'NOT_GRADED', durationMs, errorCode };
}

function observedIdentities(findings: readonly { policyId: string; policyEffect: PolicyEffect; severity: ScanSeverity }[]): ObservedFindingIdentity[] {
  const byPolicy = new Map<string, { effect: PolicyEffect; severities: Set<ScanSeverity> }>();
  for (const finding of findings) {
    const existing = byPolicy.get(finding.policyId) ?? { effect: finding.policyEffect, severities: new Set<ScanSeverity>() };
    existing.severities.add(finding.severity);
    byPolicy.set(finding.policyId, existing);
  }
  return [...byPolicy.entries()].sort(([left], [right]) => compare(left, right)).map(([policyId, identity]) => ({ policyId, effect: identity.effect, severities: SEVERITIES.filter((severity) => identity.severities.has(severity)) }));
}

function identityMismatches(fixture: CalibrationCase, observed: readonly ObservedFindingIdentity[], completeness: string): string[] {
  const mismatches: string[] = [];
  for (const expected of fixture.expectedFindings) {
    const actual = observed.find((finding) => finding.policyId === expected.policyId);
    if (actual && (actual.effect !== expected.effect || !sameValues(actual.severities, [...expected.severities].sort(severityCompare)))) mismatches.push(`policy ${expected.policyId} effect/severity mismatch`);
  }
  if (fixture.expectedCompleteness !== completeness) mismatches.push(`expected completeness ${fixture.expectedCompleteness}, observed ${completeness}`);
  return mismatches;
}

function metricFor(results: readonly CalibrationCaseResult[], policyId: string): CalibrationPolicyMetric {
  const expectedCases = results.filter((result) => result.expectedPolicyIds.includes(policyId)).length;
  const observedCases = results.filter((result) => result.observedPolicyIds.includes(policyId)).length;
  const truePositiveCases = results.filter((result) => result.truePositivePolicies.includes(policyId)).length;
  const falsePositiveCases = results.filter((result) => result.falsePositivePolicies.includes(policyId)).length;
  const falseNegativeCases = results.filter((result) => result.falseNegativePolicies.includes(policyId)).length;
  return { expectedCases, observedCases, truePositiveCases, falsePositiveCases, falseNegativeCases, precision: ratio(truePositiveCases, observedCases), recall: ratio(truePositiveCases, expectedCases) };
}

function themeMetric(results: readonly CalibrationCaseResult[], theme: CalibrationCaseResult['confusionTheme']): CalibrationThemeMetric {
  const scoped = results.filter((result) => result.confusionTheme === theme);
  return { theme, caseIds: scoped.map((result) => result.caseId), caseCount: scoped.length, expectedPolicyCount: new Set(scoped.flatMap((result) => result.expectedPolicyIds)).size, observedPolicyCount: new Set(scoped.flatMap((result) => result.observedPolicyIds)).size, agreementCases: scoped.filter((result) => result.falsePositivePolicies.length === 0 && result.falseNegativePolicies.length === 0).length, falsePositiveCases: scoped.filter((result) => result.falsePositivePolicies.length > 0).length, falseNegativeCases: scoped.filter((result) => result.falseNegativePolicies.length > 0).length };
}

function runtimeSummary(durations: readonly number[], deviceProfile: string): CalibrationReport['runtime'] {
  const ordered = [...durations].sort((left, right) => left - right);
  return { deviceProfile, sampleCount: ordered.length, totalMs: roundMs(ordered.reduce((total, duration) => total + duration, 0)), minMs: ordered[0] ?? 0, p50Ms: percentile(ordered, 0.5), p95Ms: percentile(ordered, 0.95), maxMs: ordered.at(-1) ?? 0 };
}

function percentile(values: readonly number[], percentileValue: number): number { return values.length === 0 ? 0 : values[Math.min(values.length - 1, Math.ceil(values.length * percentileValue) - 1)]!; }
function ratio(numerator: number, denominator: number): number | null { return denominator === 0 ? null : roundMs(numerator / denominator); }
function roundMs(value: number): number { return Math.round(value * 1000) / 1000; }
function histogram<T extends string>(keys: readonly T[], values: readonly string[]): Record<T, number> { const result = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>; for (const value of values) if (value in result) result[value as T] += 1; return result; }
function sameValues(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function severityCompare(left: ScanSeverity, right: ScanSeverity): number { return SEVERITIES.indexOf(left) - SEVERITIES.indexOf(right); }
function compare(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1; }
function invalidMetadata(id: string, reason: string): never { throw new CalibrationValidationError('INVALID_FIXTURE_METADATA', `Calibration case ${id} has invalid ${reason}.`); }
function invalidExpected(id: string, reason: string): never { throw new CalibrationValidationError('INVALID_EXPECTED_IDENTITY', `Calibration case ${id} has invalid expected identity: ${reason}.`); }
