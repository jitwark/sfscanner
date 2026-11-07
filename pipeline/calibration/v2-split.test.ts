import { describe, expect, it } from 'vitest';
import {
  splitCalibrationCorpus,
  type CalibrationSplitResult,
} from './v2-split';
import type { CalibrationLineageRecord } from './v2-lineage';

const digest = (hex: string) => hex.repeat(64 / hex.length);

function record(id: string, repository: string, hex: string, overrides: Partial<CalibrationLineageRecord> = {}): CalibrationLineageRecord {
  return {
    id,
    provenance: {
      source: repository,
      commit: 'a'.repeat(40),
      path: `workflows/${id}.json`,
      licence: 'MIT',
      permission: 'redistributable',
      digest: digest(hex),
    },
    repository,
    label: 'NEGATIVE',
    labelSource: 'independent-review',
    reviewer: 'reviewer-a',
    dispute: 'NONE',
    ...overrides,
  };
}

const corpus = [
  record('alpha', 'repo-a', 'a'),
  record('beta', 'repo-b', 'b'),
  record('gamma', 'repo-c', 'c'),
];
describe('splitCalibrationCorpus', () => {
  it('creates grouped development and holdout partitions without leakage', () => {
    const result = splitCalibrationCorpus(corpus, { holdoutCount: 1 });
    expect(result.ok).toBe(true);
    expect(result.development.map((item) => item.id)).toEqual(['alpha', 'beta']);
    expect(result.holdout.map((item) => item.id)).toEqual(['gamma']);
    expect(new Set(result.development.map((item) => item.lineageGroup))).not.toEqual(
      new Set(result.holdout.map((item) => item.lineageGroup)),
    );
    expect(result.report.status).toBe('READY');
  });

  it('rejects authored split leakage when related records disagree', () => {
    const result = splitCalibrationCorpus([
      record('development', 'same-repo', 'a', { split: 'development' }),
      record('holdout', 'same-repo', 'b', { split: 'holdout' }),
    ], { holdoutCount: 1 });
    expect(result.ok).toBe(false);
    expect(result.report.code).toBe('LINEAGE_SPLIT_CONFLICT');
  });

  it('is deterministic for repeated and permuted inputs', () => {
    const first = splitCalibrationCorpus(corpus, { holdoutRatio: 1 / 3 });
    const second = splitCalibrationCorpus([...corpus].reverse(), { holdoutRatio: 1 / 3 });
    expect(second).toEqual(first);
  });

  it('reports impossible requests and insufficient holdout evidence explicitly', () => {
    const impossible = splitCalibrationCorpus(corpus, { holdoutCount: 4 });
    expect(impossible.ok).toBe(false);
    expect(impossible.report.code).toBe('IMPOSSIBLE_SPLIT');

    const insufficient = splitCalibrationCorpus([
      record('unlabelled', 'repo-unlabelled', 'd', {
        labelSource: 'UNLABELLED_STRATA', reviewer: undefined, dispute: 'HUMAN_REQUIRED',
      }),
      record('labelled', 'repo-labelled', 'f'),
    ], { holdoutCount: 1 });
    expect(insufficient.ok).toBe(false);
    expect(insufficient.report.code).toBe('INSUFFICIENT_EVIDENCE');
    const missingDispute = splitCalibrationCorpus([
      record('reviewed', 'repo-reviewed', '1'),
      record('missing-dispute', 'repo-missing-dispute', '2', { dispute: undefined, split: 'holdout' }),
    ], { holdoutCount: 1 });
    expect(missingDispute.ok).toBe(false);
    expect(missingDispute.report.code).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('preserves provenance, review, dispute, and explicit labels without inventing labels', () => {
    const value = record('preserved', 'repo-preserved', 'e', {
      labelSource: undefined,
      reviewer: undefined,
      dispute: 'HUMAN_REQUIRED',
      split: undefined,
      label: undefined,
    });
    const result: CalibrationSplitResult = splitCalibrationCorpus([value], { holdoutCount: 0 });
    expect(result.ok).toBe(false);
    expect(result.development[0]?.provenance).toEqual(value.provenance);
    expect(result.development[0]?.label).toBeUndefined();
  });
});
