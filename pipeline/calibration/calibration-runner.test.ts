import { describe, expect, it } from 'vitest';
import { calibrationCases } from './calibration-cases.js';
import { runCalibration } from './calibration-runner.js';
import type { CalibrationCase } from './calibration-types.js';

function fixedClock(step = 1): () => number {
  let tick = 0;
  return () => {
    const value = tick;
    tick += step;
    return value;
  };
}

function oneCase(change: Partial<CalibrationCase>): CalibrationCase {
  return { ...calibrationCases[0]!, ...change };
}

describe('synthetic scanner calibration', () => {
  it('rejects tampered fixture hashes and metadata before scanning', () => {
    const tamperedHash = oneCase({ canonicalFixtureHash: '0'.repeat(64) });
    expect(() => runCalibration([tamperedHash], { now: () => 0 })).toThrow(/hash/i);

    const tamperedFixture = oneCase({ canonicalFixture: { changed: true } });
    expect(() => runCalibration([tamperedFixture], { now: () => 0 })).toThrow(/hash/i);

    const tamperedMetadata = oneCase({ reviewer: '', rationale: ' ' });
    expect(() => runCalibration([tamperedMetadata], { now: () => 0 })).toThrow(/metadata/i);
  });

  it('rejects expected policy identities that are not in the selected profile', () => {
    const invalid = oneCase({
      expectedFindings: [{ policyId: 'NOT_A_REAL_POLICY', effect: 'LEGACY_SCORE', severities: ['HIGH'] }],
    });

    expect(() => runCalibration([invalid], { now: () => 0 })).toThrow(/policy/i);
  });

  it('produces byte-stable reports when the clock is controlled', () => {
    const first = runCalibration(calibrationCases, { now: fixedClock() });
    const second = runCalibration(calibrationCases, { now: fixedClock() });

    expect(first).toEqual(second);
  });

  it('reports representative legacy, hardened, completeness, and false-negative metrics', () => {
    const report = runCalibration(calibrationCases, { now: fixedClock(0.25) });
    const command = report.metrics.N8N_EXECUTE_COMMAND;
    const javascript = report.metrics.JAVASCRIPT_DYNAMIC_EXECUTION;

    expect(command).toMatchObject({
      expectedCases: 2,
      observedCases: 2,
      truePositiveCases: 2,
      falsePositiveCases: 0,
      falseNegativeCases: 0,
      precision: 1,
      recall: 1,
    });
    expect(javascript.expectedCases).toBe(4);
    expect(javascript.falseNegativeCases).toBeGreaterThan(0);
    expect(report.falseNegativeProbeIds).toContain('hardened-unsupported-code');
    expect(report.cases.flatMap((item) => item.identityMismatches)).toEqual([]);
    // Four cases suppress the grade: the non-object parameter shape, plus the
    // three code-node sources the analyzer stage cannot read (unsupported
    // variant, unsupported language, malformed JavaScript). Those three reach
    // the CLI surface as a required-stage failure, not as a bounded omission.
    expect(report.statusHistogram.INDETERMINATE).toBe(4);
    expect(report.statusHistogram.REJECTED).toBe(6);
    expect(report.gradeHistogram.LOW).toBeGreaterThan(0);
    expect(report.confusionThemes.some((theme) => theme.falseNegativeCases > 0)).toBe(true);
    expect(report.runtime.sampleCount).toBe(calibrationCases.length);
    expect(JSON.stringify(report)).not.toContain('sk_live_calibration_fixture');
  });

  it('measures the hostile resource, input, and analyzer strata', () => {
    const report = runCalibration(calibrationCases, { now: fixedClock(0.25) });

    expect(report).toMatchObject({
      caseCount: 27,
      splitCounts: { development: 14, holdout: 13 },
    });
    expect(report.confusionThemes.map((theme) => theme.theme)).toEqual(expect.arrayContaining([
      'resource-boundary', 'input-boundary', 'analyzer-boundary',
    ]));
    expect(report.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ caseId: 'adversarial-cyclic-graph', status: 'ACCEPTED', completeness: 'COMPLETE' }),
      expect.objectContaining({ caseId: 'adversarial-deep-connections', status: 'REJECTED', errorCode: 'WORKFLOW_TOO_COMPLEX' }),
      expect.objectContaining({ caseId: 'adversarial-wide-graph', status: 'REJECTED', errorCode: 'WORKFLOW_TOO_COMPLEX' }),
      expect.objectContaining({ caseId: 'adversarial-wide-parameters', status: 'REJECTED', errorCode: 'WORKFLOW_TOO_COMPLEX' }),
      expect.objectContaining({ caseId: 'adversarial-oversized-workflow', status: 'REJECTED', errorCode: 'WORKFLOW_TOO_LARGE' }),
      expect.objectContaining({ caseId: 'adversarial-repeated-javascript-findings', completeness: 'DEGRADED' }),
      expect.objectContaining({ caseId: 'adversarial-repeated-python-findings', completeness: 'DEGRADED' }),
      expect.objectContaining({ caseId: 'adversarial-unsupported-language', completeness: 'INDETERMINATE' }),
      expect.objectContaining({ caseId: 'adversarial-malformed-javascript', completeness: 'INDETERMINATE' }),
    ]));
    expect(report.cases.find((item) => item.caseId === 'adversarial-repeated-javascript-findings')?.identityMismatches).toEqual([]);
    expect(report.cases.find((item) => item.caseId === 'adversarial-repeated-python-findings')?.identityMismatches).toEqual([]);
  });

  it('keeps hostile accepted fixtures deterministic across repeated reports', () => {
    const hostile = calibrationCases.filter((fixture) => fixture.id.startsWith('adversarial-'));
    expect(runCalibration(hostile, { now: fixedClock() })).toEqual(runCalibration(hostile, { now: fixedClock() }));
  });
});
