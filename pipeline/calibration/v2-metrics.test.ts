import { describe, expect, it } from 'vitest';
import {
  adjudicateCalibrationCase,
  adjudicateCalibrationCases,
  type V2Adjudication,
  type V2ReviewerDecision,
} from './v2-adjudication';
import {
  computeRuleMetrics,
  wilson95,
  type V2MetricCase,
  type V2MetricMeasurements,
} from './v2-metrics';

const provenance = {
  source: 'synthetic/reviewed',
  commit: 'a'.repeat(40),
  path: 'fixtures/workflow.json',
  licence: 'MIT',
  permission: 'redistributable',
  digest: 'b'.repeat(64),
} as const;

function decision(reviewer: string, label: V2ReviewerDecision['label'], rationale = 'bounded evidence supports this label.'): V2ReviewerDecision {
  return { reviewer, label, rationale, reviewedAt: '2026-09-10' };
}
function adjudicated(caseId: string, label: V2ReviewerDecision['label'] = 'POSITIVE'): V2Adjudication {
  return adjudicateCalibrationCase({ caseId, provenance, decisions: [decision('reviewer-a', label), decision('reviewer-b', label)] });
}
const measurements: V2MetricMeasurements = { latencyMs: 12.5, memoryBytes: 100, rssBytes: 2048, serializedBytes: 64 };
function metricCase(overrides: Partial<V2MetricCase> = {}): V2MetricCase {
  return {
    caseId: 'case-positive',
    provenance,
    adjudication: adjudicated('case-positive'),
    expectedRules: [{ ruleId: 'RULE_A', label: 'POSITIVE' }],
    observedRuleIds: ['RULE_A'],
    observedState: 'POSITIVE',
    measurements,
    ...overrides,
  };
}

describe('independent calibration adjudication', () => {
  it('settles agreement only when independent reviewers agree and preserves rationale and rights', () => {
    const result = adjudicateCalibrationCase({
      caseId: 'agreement', provenance,
      decisions: [decision('reviewer-a', 'POSITIVE', 'source evidence A'), decision('reviewer-b', 'POSITIVE', 'source evidence B')],
    });
    expect(result).toMatchObject({ status: 'AGREED', label: 'POSITIVE', caseId: 'agreement' });
    expect(result.decisions.map((item) => item.rationale)).toEqual(['source evidence A', 'source evidence B']);
    expect(result.provenance.licence).toBe('MIT');
    expect(result.provenance.permission).toBe('redistributable');
  });

  it('keeps disagreement, HUMAN_REQUIRED, and insufficient evidence out of settled truth', () => {
    const disagreement = adjudicateCalibrationCase({ caseId: 'disputed', provenance, decisions: [decision('a', 'POSITIVE'), decision('b', 'NEGATIVE')] });
    const human = adjudicateCalibrationCase({ caseId: 'human', provenance, dispute: 'HUMAN_REQUIRED', decisions: [decision('a', 'POSITIVE'), decision('b', 'POSITIVE')] });
    const insufficient = adjudicateCalibrationCase({ caseId: 'insufficient', provenance, decisions: [decision('a', 'POSITIVE')] });
    expect(disagreement).toMatchObject({ status: 'DISPUTED', disagreement: true });
    expect(disagreement.label).toBeUndefined();
    expect(human).toMatchObject({ status: 'HUMAN_REQUIRED' });
    expect(human.label).toBeUndefined();
    expect(insufficient).toMatchObject({ status: 'INSUFFICIENT_EVIDENCE' });
    expect(insufficient.label).toBeUndefined();
  });

  it('rejects duplicate case/reviewer decisions and malformed or missing provenance', () => {
    expect(() => adjudicateCalibrationCases([
      { caseId: 'same', provenance, decisions: [decision('a', 'POSITIVE'), decision('b', 'POSITIVE')] },
      { caseId: 'same', provenance, decisions: [decision('a', 'POSITIVE'), decision('b', 'POSITIVE')] },
    ])).toThrow(/duplicate.*case/i);
    expect(() => adjudicateCalibrationCase({ caseId: 'duplicate-reviewer', provenance, decisions: [decision('a', 'POSITIVE'), decision('a', 'POSITIVE')] })).toThrow(/duplicate.*reviewer/i);
    expect(() => adjudicateCalibrationCase({ caseId: 'bad-label', provenance, decisions: [decision('a', 'WRONG' as never), decision('b', 'POSITIVE')] })).toThrow(/label/i);
    expect(() => adjudicateCalibrationCase({ caseId: 'missing-provenance', provenance: { ...provenance, permission: '' }, decisions: [decision('a', 'POSITIVE'), decision('b', 'POSITIVE')] })).toThrow(/provenance|permission/i);
  });
});

describe('per-rule calibration metrics', () => {
  it('computes confusion counts, abstention/degradation, taxonomy, and measurements deterministically', () => {
    const report = computeRuleMetrics([
      metricCase({ caseId: 'z-negative', adjudication: adjudicated('z-negative', 'NEGATIVE'), expectedRules: [{ ruleId: 'RULE_A', label: 'NEGATIVE' }], observedRuleIds: ['RULE_A'], observedState: 'DEGRADED', measurements: { ...measurements, latencyMs: 3, memoryBytes: 7, rssBytes: 11 } }),
      metricCase({ caseId: 'a-positive', adjudication: adjudicated('a-positive'), measurements: { ...measurements, latencyMs: 2, memoryBytes: 5, rssBytes: 13 } }),
      metricCase({ caseId: 'm-miss', adjudication: adjudicated('m-miss'), expectedRules: [{ ruleId: 'RULE_A', label: 'POSITIVE' }], observedRuleIds: [], observedState: 'ABSTAINED', measurements: { ...measurements, latencyMs: 4, memoryBytes: 9, rssBytes: 17 } }),
      metricCase({ caseId: 'b-near', adjudication: adjudicated('b-near', 'NEAR_MISS'), expectedRules: [{ ruleId: 'RULE_A', label: 'NEAR_MISS' }], observedRuleIds: [], observedState: 'NEGATIVE' }),
    ]);
    const metric = report.ruleMetrics.RULE_A!;
    expect(report.caseIds).toEqual(['a-positive', 'b-near', 'm-miss', 'z-negative']);
    expect(metric).toMatchObject({ positiveDenominator: 2, negativeDenominator: 1, nearMissDenominator: 1, truePositiveCases: 1, falsePositiveCases: 1, falseNegativeCases: 1, abstentionCases: 1, degradedCases: 1, abstentionRate: 0.25, degradationRate: 0.25 });
    expect(metric.falseNegativeClasses).toMatchObject({ ABSTENTION: 1 });
    expect(metric.precision).toBe(0.5);
    expect(metric.recall).toBe(0.5);
    expect(metric.latencyMsTotal).toBe(21.5);
    expect(metric.memoryBytesTotal).toBe(121);
    expect(metric.rssBytesTotal).toBe(2089);
  });

  it('bounds Wilson intervals and never settles a report with insufficient evidence', () => {
    const report = computeRuleMetrics([metricCase({ caseId: 'unreviewed', adjudication: adjudicateCalibrationCase({ caseId: 'unreviewed', provenance, dispute: 'HUMAN_REQUIRED', decisions: [] }) })]);
    expect(report.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(report.ruleMetrics.RULE_A).toMatchObject({ status: 'UNAVAILABLE', precision: null, recall: null, precisionInterval: null, recallInterval: null });
    const measured = computeRuleMetrics([metricCase()]).ruleMetrics.RULE_A!;
    expect(measured.precisionInterval?.lower).toBeGreaterThanOrEqual(0);
    expect(measured.precisionInterval?.upper).toBeLessThanOrEqual(1);
    expect(measured.recallInterval?.lower).toBeGreaterThanOrEqual(0);
    expect(measured.recallInterval?.upper).toBeLessThanOrEqual(1);
  });

  it('rejects missing adjudication, malformed labels, duplicate IDs, and non-finite measurements', () => {
    expect(() => computeRuleMetrics([metricCase({ adjudication: undefined as never })])).toThrow(/adjudication/i);
    expect(() => computeRuleMetrics([metricCase({ expectedRules: [{ ruleId: 'RULE_A', label: 'INVALID' as never }] })])).toThrow(/label/i);
    expect(() => computeRuleMetrics([metricCase(), metricCase()])).toThrow(/duplicate.*case/i);
    expect(() => computeRuleMetrics([metricCase({ measurements: { ...measurements, rssBytes: Number.NaN } })])).toThrow(/finite|measurement/i);
  });

  it('keeps per-rule ordering and distinguishes unknown, omitted, rejected, and degraded false negatives', () => {
    const cases = (['UNKNOWN', 'OMITTED', 'REJECTED', 'DEGRADED'] as const).map((state) => metricCase({ caseId: `case-${state}`, adjudication: adjudicated(`case-${state}`), expectedRules: [{ ruleId: `RULE_${state}`, label: 'POSITIVE' }], observedRuleIds: [], observedState: state, unknownRuleIds: state === 'UNKNOWN' ? [`RULE_${state}`] : [] }));
    const report = computeRuleMetrics(cases.reverse());
    expect(Object.keys(report.ruleMetrics)).toEqual(['RULE_DEGRADED', 'RULE_OMITTED', 'RULE_REJECTED', 'RULE_UNKNOWN']);
    expect(report.ruleMetrics.RULE_UNKNOWN?.falseNegativeClasses).toMatchObject({ UNKNOWN: 1 });
    expect(report.ruleMetrics.RULE_OMITTED?.falseNegativeClasses).toMatchObject({ OMITTED: 1 });
    expect(report.ruleMetrics.RULE_REJECTED?.falseNegativeClasses).toMatchObject({ REJECTED: 1 });
    expect(report.ruleMetrics.RULE_DEGRADED?.falseNegativeClasses).toMatchObject({ DEGRADATION: 1 });
  });
});

describe('Wilson 95% primitive', () => {
  it('returns null for an empty sample and finite clamped intervals at the boundaries', () => {
    expect(wilson95(0, 0)).toBeNull();
    const none = wilson95(0, 20);
    const all = wilson95(20, 20);
    expect(none).not.toBeNull();
    expect(all).not.toBeNull();
    expect(none?.[0]).toBe(0);
    expect(Number.isFinite(none?.[1])).toBe(true);
    expect(none?.[1]).toBeGreaterThan(0);
    expect(none?.[1]).toBeLessThan(1);
    expect(all?.[1]).toBe(1);
    expect(Number.isFinite(all?.[0])).toBe(true);
    expect(all?.[0]).toBeGreaterThan(0);
    expect(all?.[0]).toBeLessThan(1);
  });

  it('rejects non-safe, negative, fractional, and over-total counts', () => {
    for (const [successes, total] of [
      [-1, 20],
      [0, -1],
      [1.5, 20],
      [21, 20],
      [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2],
      [Number.NaN, 20],
      [0, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(() => wilson95(successes, total)).toThrow(TypeError);
      expect(() => wilson95(successes, total)).toThrow('Invalid binomial counts');
    }
  });

  it('leaves existing rule metric intervals and report metadata unchanged', () => {
    const report = computeRuleMetrics([
      metricCase(),
      metricCase({ caseId: 'case-negative', adjudication: adjudicated('case-negative', 'NEGATIVE'), expectedRules: [], observedRuleIds: ['RULE_A'], observedState: 'POSITIVE' }),
    ]);
    expect(report.interval).toEqual({ method: 'WILSON', confidence: 0.95 });
    expect(report.ruleMetrics.RULE_A?.precisionInterval).toEqual({ lower: 0.09453120573423074, upper: 0.9054687942657693, confidence: 0.95, method: 'WILSON' });
    expect(report.ruleMetrics.RULE_A?.recallInterval).toEqual({ lower: 0.20654931437723745, upper: 1, confidence: 0.95, method: 'WILSON' });
    expect(wilson95(1, 2)).toEqual([0.09453120573423074, 0.9054687942657693]);
    expect(computeRuleMetrics([metricCase()]).ruleMetrics.RULE_A?.precisionInterval).toEqual({ lower: 0.20654931437723745, upper: 1, confidence: 0.95, method: 'WILSON' });
    expect(computeRuleMetrics([metricCase()]).ruleMetrics.RULE_A?.recallInterval).toEqual({ lower: 0.20654931437723745, upper: 1, confidence: 0.95, method: 'WILSON' });
    expect(computeRuleMetrics([metricCase({ caseId: 'case-unreviewed', adjudication: adjudicateCalibrationCase({ caseId: 'case-unreviewed', provenance, dispute: 'HUMAN_REQUIRED', decisions: [] }) })]).ruleMetrics.RULE_A?.recallInterval).toBeNull();
  });
});
