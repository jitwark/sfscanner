import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { computeEvaluationMetrics } from './evaluation-metrics.mjs';

const item = (caseId, familyId, split, expected, observed) => ({ caseId, familyId, split, expected, observed });
const provenanceDigest = (caseId) => createHash('sha256').update(`case-${caseId}`).digest('hex');
const decision = (reviewer, label) => ({ reviewer, label, rationale: `rationale ${reviewer}`, reviewedAt: '2026-10-20' });
const adjudication = (caseId, label, overrides = {}) => ({
  caseId,
  status: 'AGREED',
  label,
  decisions: [decision('reviewer-a', label), decision('reviewer-b', label)],
  resolution: null,
  provenance: { digest: provenanceDigest(caseId), licence: 'MIT', permission: 'PERMITTED' },
  ...overrides,
});
/** The settled evidence a producer must supply for every case that may fill a denominator. */
const evidenceFor = (cases) => cases.filter(({ expected }) => expected !== 'EXCLUDED').map(({ caseId, expected }) => adjudication(caseId, expected));
function readyFamily(familyId, split, count = 20) {
  return [
    ...Array.from({ length: count }, (_, index) => item(`${familyId}-p${index}`, familyId, split, 'POSITIVE', 'POSITIVE')),
    ...Array.from({ length: count }, (_, index) => item(`${familyId}-n${index}`, familyId, split, 'NEGATIVE', 'NEGATIVE')),
  ];
}
const report = (cases, extra = {}) => computeEvaluationMetrics({ cases, adjudications: evidenceFor(cases), ...extra });

describe('split-aware evaluation metrics', () => {
  test('reports insufficient evidence for an empty case set', () => {
    const empty = report([]);
    expect(empty).toMatchObject({
      schemaVersion: 'evaluation-metrics-v2', status: 'INSUFFICIENT_EVIDENCE', caseCount: 0,
      adjudicationCount: 0, unauthenticatedCount: 0,
      admission: { eligible: false, reasons: ['no HOLDOUT families'] },
    });
    expect(empty.splits.DEV.precision).toBeNull();
    expect(empty.splits.HOLDOUT.recall).toBeNull();
  });

  test('rejects family leakage across DEV and HOLDOUT', () => {
    const cases = [
      item('a', 'family-a', 'DEV', 'POSITIVE', 'POSITIVE'),
      item('b', 'family-a', 'HOLDOUT', 'POSITIVE', 'POSITIVE'),
    ];
    expect(() => computeEvaluationMetrics({ cases, adjudications: evidenceFor(cases) })).toThrow(/leaks across DEV and HOLDOUT/u);
  });

  test('counts TP/FP/FN/TN, unknown and excluded cases independently per family', () => {
    const value = report([
      item('tp', 'f', 'DEV', 'POSITIVE', 'POSITIVE'),
      item('fn', 'f', 'DEV', 'POSITIVE', 'NEGATIVE'),
      item('fp', 'f', 'DEV', 'NEGATIVE', 'POSITIVE'),
      item('tn', 'f', 'DEV', 'NEGATIVE', 'NEGATIVE'),
      item('unknown', 'f', 'DEV', 'POSITIVE', 'UNKNOWN'),
      item('excluded', 'f', 'DEV', 'EXCLUDED', 'POSITIVE'),
    ]);
    expect(value.families[0]).toMatchObject({
      familyId: 'f', counts: { tp: 1, fp: 1, fn: 1, tn: 1, unknown: 1, excluded: 1, eligiblePositives: 2, eligibleNegatives: 2 },
      status: 'INSUFFICIENT_EVIDENCE',
    });
    expect(value.caseCount).toBe(6);
    expect(value.excludedCount).toBe(1);
    expect(value.unknownCount).toBe(1);
    expect(value.status).toBe('PARTIAL');
  });

  test('admits only a HOLDOUT family meeting denominator and precision/recall thresholds', () => {
    const value = report(readyFamily('holdout', 'HOLDOUT'));
    expect(value.splits.HOLDOUT).toMatchObject({ precision: 1, recall: 1, status: 'READY' });
    expect(value.admission).toEqual({ eligible: true, reasons: [] });
    expect(value.adjudicationCount).toBe(40);
    expect(value.adjudicationDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('blocks admission when a HOLDOUT case remains unresolved', () => {
    const cases = [...readyFamily('holdout', 'HOLDOUT'), item('unresolved', 'holdout', 'HOLDOUT', 'POSITIVE', 'UNKNOWN')];
    const value = report(cases);
    expect(value.families[0].status).toBe('INSUFFICIENT_EVIDENCE');
    expect(value.status).toBe('PARTIAL');
    expect(value.admission).toMatchObject({ eligible: false, reasons: expect.arrayContaining(['a HOLDOUT family has unresolved cases']) });
  });

  test('blocks admission on a paired regression even when aggregate metrics pass', () => {
    const cases = readyFamily('holdout', 'HOLDOUT');
    const baseline = cases.map(({ caseId, observed }) => ({ caseId, observed }));
    baseline[0] = { caseId: cases[0].caseId, observed: 'POSITIVE' };
    cases[0] = { ...cases[0], observed: 'NEGATIVE' };
    const value = report(cases, { baseline });
    expect(value.families[0].paired).toMatchObject({ pairs: 40, regressions: 1, improvements: 0 });
    expect(value.admission.eligible).toBe(false);
    expect(value.admission.reasons).toContain('a HOLDOUT family has paired regressions');
  });
});

describe('adjudication evidence gate', () => {
  test('requires the evidence set and never admits a caller-asserted expected label alone', () => {
    const cases = readyFamily('holdout', 'HOLDOUT');
    expect(() => computeEvaluationMetrics({ cases })).toThrow(/array/u);
    const unauthenticated = computeEvaluationMetrics({ cases, adjudications: [] });
    expect(unauthenticated).toMatchObject({ status: 'PARTIAL', unauthenticatedCount: 40, unknownCount: 40 });
    expect(unauthenticated.splits.HOLDOUT.counts).toMatchObject({ tp: 0, tn: 0, unknown: 40 });
    expect(unauthenticated.admission.eligible).toBe(false);
    expect(unauthenticated.admission.reasons).toContain('40 case(s) lack settled adjudication');
  });

  test('refuses a case whose expected label contradicts its settled adjudication', () => {
    const cases = readyFamily('holdout', 'HOLDOUT');
    const adjudications = evidenceFor(cases);
    adjudications[0] = adjudication(cases[0].caseId, 'NEGATIVE');
    expect(() => computeEvaluationMetrics({ cases, adjudications })).toThrow(/expected label disagrees/u);
  });

  test('does not accept an unsettled or partially reviewed case as adjudicated', () => {
    const cases = readyFamily('holdout', 'HOLDOUT');
    const adjudications = evidenceFor(cases);
    adjudications[0] = adjudication(cases[0].caseId, 'POSITIVE', { status: 'HUMAN_REQUIRED', label: null, decisions: [] });
    adjudications[1] = adjudication(cases[1].caseId, 'POSITIVE', { status: 'DISPUTED', label: null, decisions: [decision('reviewer-a', 'POSITIVE'), decision('reviewer-b', 'NEGATIVE')] });
    const value = computeEvaluationMetrics({ cases, adjudications });
    expect(value.unauthenticatedCount).toBe(2);
    expect(value.unknownCount).toBe(2);
    expect(value.admission.eligible).toBe(false);
    expect(() => computeEvaluationMetrics({ cases, adjudications: [adjudication(cases[0].caseId, 'POSITIVE', { decisions: [decision('reviewer-a', 'POSITIVE')] })] })).toThrow(/two independent reviewer/u);
  });

  test('names the evidence it relied on independently of input order', () => {
    const cases = readyFamily('holdout', 'HOLDOUT');
    const adjudications = evidenceFor(cases);
    const forward = computeEvaluationMetrics({ cases, adjudications });
    const reversed = computeEvaluationMetrics({ cases: [...cases].reverse(), adjudications: [...adjudications].reverse() });
    expect(reversed.adjudicationDigest).toBe(forward.adjudicationDigest);
    expect(reversed.families).toEqual(forward.families);
  });
});
