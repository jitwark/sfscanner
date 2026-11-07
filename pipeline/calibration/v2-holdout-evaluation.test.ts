import { describe, expect, test } from 'vitest';
import {
  UNREGISTERED_CATEGORY,
  classifyHoldoutVerdict,
  diagnosticCategoryOf,
  summarizeHoldout,
  type HoldoutObservation,
} from './v2-holdout-evaluation';

/** A graded, clean observation; every case below departs from it in exactly one field. */
const baseline: HoldoutObservation = Object.freeze({
  caseId: 'official__1_example.json',
  bodySha256: 'a'.repeat(64),
  ok: true,
  analysisStatus: 'COMPLETE',
  grade: 'LOW',
  diagnosticCodes: Object.freeze([]),
  findingCount: 1,
  latencyMs: 10,
  rssBytes: 100,
});

const observation = (overrides: Partial<HoldoutObservation>): HoldoutObservation => Object.freeze({ ...baseline, ...overrides });

describe('classifyHoldoutVerdict', () => {
  test('refusal, unassessed result and assessment are three different facts', () => {
    expect(classifyHoldoutVerdict(observation({ ok: false, analysisStatus: 'INDETERMINATE', refusalCode: 'SEMANTIC_CATALOGUE_INVALID', grade: undefined }))).toBe('REFUSED');
    expect(classifyHoldoutVerdict(observation({ analysisStatus: 'INDETERMINATE', grade: undefined }))).toBe('INDETERMINATE');
    expect(classifyHoldoutVerdict(observation({ analysisStatus: 'DEGRADED', grade: 'MEDIUM' }))).toBe('GRADED');
  });

  test('never infers a grade the engine did not publish', () => {
    const graded = [observation({ grade: 'CRITICAL' }), observation({ grade: undefined, analysisStatus: 'INDETERMINATE' })];
    const summary = summarizeHoldout(graded);
    expect(summary.verdicts).toEqual({ GRADED: 1, INDETERMINATE: 1, REFUSED: 0 });
    expect(summary.grades).toEqual({ CRITICAL: 1, NO_ASSESSMENT: 1 });
  });
});

describe('diagnosticCategoryOf', () => {
  test('reads the engine registry instead of a second vocabulary', () => {
    expect(diagnosticCategoryOf('SEMANTIC_CATALOGUE_MISS')).toBe('CATALOGUE');
    expect(diagnosticCategoryOf('MALFORMED_CONNECTION_INDEX')).toBe('GRAPH');
    expect(diagnosticCategoryOf('REQUIRED_CAPABILITY_FAILED')).toBe('POLICY');
  });

  test('keeps a code outside the registry visible', () => {
    expect(diagnosticCategoryOf('FUTURE_CODE')).toBe(UNREGISTERED_CATEGORY);
  });
});

describe('summarizeHoldout', () => {
  test('counts an unmodelled node set, a malformed document and a composition defect apart', () => {
    const summary = summarizeHoldout([
      observation({ caseId: 'unmodelled', ok: false, analysisStatus: 'INDETERMINATE', refusalCode: 'SEMANTIC_CATALOGUE_INVALID', grade: undefined }),
      observation({ caseId: 'malformed', ok: false, analysisStatus: 'INDETERMINATE', refusalCode: 'MALFORMED_WORKFLOW', grade: undefined }),
      observation({ caseId: 'tool', ok: false, analysisStatus: 'INDETERMINATE', refusalCode: 'TOOL_INVARIANT_FAILED', grade: undefined }),
      observation({ caseId: 'gap', analysisStatus: 'DEGRADED', grade: 'HIGH', diagnosticCodes: Object.freeze(['SEMANTIC_CATALOGUE_MISS']) }),
    ]);
    expect(summary.verdicts).toEqual({ GRADED: 1, INDETERMINATE: 0, REFUSED: 3 });
    expect(summary.refusalCodes).toEqual({ MALFORMED_WORKFLOW: 1, SEMANTIC_CATALOGUE_INVALID: 1, TOOL_INVARIANT_FAILED: 1 });
    expect(summary.diagnosticCategories).toEqual({ CATALOGUE: 1 });
    expect(summary.gradedWithCatalogueGap).toBe(1);
  });

  test('reports the grade spread over every case, refusals and non-grades included', () => {
    const summary = summarizeHoldout([
      observation({ caseId: 'low', grade: 'LOW' }),
      observation({ caseId: 'low-2', grade: 'LOW' }),
      observation({ caseId: 'critical', grade: 'CRITICAL', analysisStatus: 'DEGRADED' }),
      observation({ caseId: 'no-verdict', grade: undefined, analysisStatus: 'INDETERMINATE' }),
    ]);
    expect(summary.grades).toEqual({ CRITICAL: 1, LOW: 2, NO_ASSESSMENT: 1 });
    expect(summary.analysisStatuses).toEqual({ COMPLETE: 2, DEGRADED: 1, INDETERMINATE: 1 });
    expect(Object.values(summary.grades).reduce((sum, value) => sum + value, 0)).toBe(summary.caseCount);
  });

  test('summarises latency and RSS from the measured samples only', () => {
    const summary = summarizeHoldout([
      observation({ caseId: 'a', latencyMs: 10, rssBytes: 5 }),
      observation({ caseId: 'b', latencyMs: 20, rssBytes: 7 }),
      observation({ caseId: 'c', latencyMs: 30, rssBytes: 9 }),
      observation({ caseId: 'refused', ok: false, analysisStatus: 'INDETERMINATE', refusalCode: 'INVALID_JSON', grade: undefined, latencyMs: 900, rssBytes: 1000 }),
    ]);
    expect(summary.latency).toEqual({ totalMs: 60, minMs: 10, medianMs: 20, maxMs: 30 });
    expect(summary.rss).toEqual({ peakBytes: 9 });
    expect(summarizeHoldout([])).toMatchObject({ caseCount: 0, latency: null, grades: {} });
  });

  test('is deterministic and does not mutate its input', () => {
    const cases = Object.freeze([
      observation({ caseId: 'z', grade: 'MEDIUM' }),
      observation({ caseId: 'a', diagnosticCodes: Object.freeze(['MALFORMED_NODE_PARAMETERS', 'UNKNOWN_CODE']) }),
    ]);
    const snapshot = structuredClone(cases);
    expect(summarizeHoldout(cases)).toEqual(summarizeHoldout([...cases].reverse()));
    expect(cases).toEqual(snapshot);
  });
});
