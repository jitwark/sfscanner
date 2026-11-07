import { describe, expect, it } from 'vitest';
import {
  canonicalQueryKey,
  evaluateRankingImprovement,
  querySetSha256,
  type JudgedCase,
  type JudgedSet,
  type RankedRun,
} from './improvement-protocol';

const releaseId = 'synthetic@2026-08-31T00:00:00.000Z';
const judgment = (id: string, relevance: 1 | 2 | 3) => ({
  id, relevance, rationale: 'synthetic judgment', reviewer: 'test', reviewedOn: '2026-08-31', releaseId,
});

const cases: JudgedCase[] = [
  { id: 'd-exact', split: 'development', kind: 'exact', sort: 'relevance', query: 'exact', expected: [judgment('d1', 3)] },
  { id: 'd-facet', split: 'development', kind: 'facet', sort: 'relevance', query: 'facet', filters: { tag: ['safe'] }, expected: [judgment('d2', 3)] },
  { id: 'h-exact', split: 'holdout', kind: 'exact', sort: 'relevance', query: 'holdout exact', expected: [judgment('hx', 3)] },
  { id: 'h-intent', split: 'holdout', kind: 'natural-language', sort: 'relevance', query: 'holdout intent', expected: [judgment('h1', 3), judgment('h2', 2)] },
];
const fixture: JudgedSet = {
  schemaVersion: 'relevance-set-v2', release: { releaseId },
  protocol: {
    tuningSplit: 'development', holdoutSplit: 'holdout', holdoutPolicy: 'untouched-evaluate-once',
    queryKey: 'query+filters+sort-v1', developmentQuerySetSha256: querySetSha256(cases, 'development'),
    holdoutQuerySetSha256: querySetSha256(cases, 'holdout'),
  }, cases,
};
const availableIds = ['d1', 'd2', 'hx', 'h1', 'h2', ...Array.from({ length: 10 }, (_, index) => `wrong-${index}`)];
const baselineResults = {
  'd-exact': ['d1'], 'd-facet': ['d2'], 'h-exact': ['hx'],
  'h-intent': Array.from({ length: 10 }, (_, index) => `wrong-${index}`),
};
const improvedResults = { ...baselineResults, 'h-intent': ['h1', 'h2', ...baselineResults['h-intent']] };
const run = (label: string, results: RankedRun['results'], tunedCaseIds: string[] = []): RankedRun => ({
  label, version: 'synthetic-v1', releaseId, results, tunedCaseIds,
});
const input = (candidate: RankedRun, judgedSet = fixture) => ({
  judgedSet, availableIds, baseline: run('baseline', baselineResults), candidate,
});

describe('ranking improvement protocol', () => {
  it('accepts a candidate with a material untouched-holdout win', () => {
    const report = evaluateRankingImprovement(input(run('candidate', improvedResults, ['d-exact', 'd-facet'])));

    expect(report.accepted).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.candidate.metrics?.bySplit.holdout.recallAt10).toBe(1);
    expect(report.comparison.holdoutDeltas.ndcgAt10).toBeGreaterThanOrEqual(0.02);
  });

  it('rejects a candidate that improves development only', () => {
    const report = evaluateRankingImprovement(input(run('candidate', baselineResults, ['d-exact'])));

    expect(report.accepted).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([expect.stringContaining('holdout Recall@10')]));
    expect(report.candidate.metrics).not.toBeNull();
  });

  it('rejects tuning declarations that include holdout cases', () => {
    const report = evaluateRankingImprovement(input(run('candidate', improvedResults, ['h-intent'])));

    expect(report.accepted).toBe(false);
    expect(report.errors).toContain('candidate tuned holdout case: h-intent');
  });

  it('rejects missing and duplicate candidate case outputs', () => {
    const report = evaluateRankingImprovement(input(run('candidate', [
      { caseId: 'd-exact', ids: ['d1'] }, { caseId: 'd-exact', ids: ['d1'] },
    ])));

    expect(report.accepted).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([
      'candidate duplicate case output: d-exact', 'candidate missing case output: d-facet',
    ]));
  });

  it('rejects a judged ID that is absent from the release universe', () => {
    const report = evaluateRankingImprovement(input(run('candidate', improvedResults), fixture));

    const missingIdReport = evaluateRankingImprovement({ ...input(run('candidate', improvedResults)), availableIds: availableIds.filter((id) => id !== 'h2') });
    expect(report.accepted).toBe(true);
    expect(missingIdReport.accepted).toBe(false);
    expect(missingIdReport.errors).toContain('h-intent expected ID missing from available release: h2');
  });

  it('canonicalizes ordering and hashes byte-identically', () => {
    const reversed = [...cases].reverse();
    const reorderedFixture = { ...fixture, cases: reversed, protocol: {
      ...fixture.protocol, developmentQuerySetSha256: querySetSha256(reversed, 'development'),
      holdoutQuerySetSha256: querySetSha256(reversed, 'holdout'),
    }};
    const first = evaluateRankingImprovement(input(run('candidate', improvedResults, ['d-exact']), fixture));
    const second = evaluateRankingImprovement(input(run('candidate', {
      'h-intent': improvedResults['h-intent'], 'h-exact': ['hx'], 'd-facet': ['d2'], 'd-exact': ['d1'],
    }, ['d-exact']), reorderedFixture));

    expect(canonicalQueryKey(cases[1]!)).toBe('["facet",{"tag":["safe"]},"relevance"]');
    expect(second.reportSha256).toBe(first.reportSha256);
  });
});
