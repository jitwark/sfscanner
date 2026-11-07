import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { compareSearchQualityReports, loadSearchQualityThresholds, validateSearchQualityGate } from './check-search-quality.mjs';

const releaseId = 'data@2026-08-25T18:54:03.363Z';

function makeCase(id, split, kind = 'exact') {
  return {
    id,
    split,
    kind,
    sort: 'relevance',
    query: id,
    strata: ['common'],
    expected: [{
      id: `${id}-workflow`,
      relevance: 3,
      rationale: 'The judged workflow matches the query.',
      reviewer: 'reviewer-a',
      reviewedOn: '2026-08-29',
      releaseId,
    }],
  };
}

function querySetHash(cases, split) {
  return createHash('sha256')
    .update(cases.filter((testCase) => testCase.split === split)
      .map((testCase) => JSON.stringify([testCase.query, Object.fromEntries(Object.entries(testCase.filters ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value])), testCase.sort]))
      .sort().join('\n'))
    .digest('hex');
}

function makeFixture(overrides = {}) {
  const cases = overrides.cases ?? [makeCase('development-exact', 'development'), makeCase('holdout-exact', 'holdout')];
  return {
    schemaVersion: 'relevance-set-v2',
    createdOn: '2026-08-29',
    reviewers: ['orchestrator', 'luna-independent-review'],
    release: { releaseId, corpusSha256: 'a'.repeat(64) },
    protocol: {
      tuningSplit: 'development',
      holdoutSplit: 'holdout',
      holdoutPolicy: 'untouched-evaluate-once',
      queryKey: 'query+filters+sort-v1',
      developmentQuerySetSha256: querySetHash(cases, 'development'),
      holdoutQuerySetSha256: querySetHash(cases, 'holdout'),
    },
    cases,
    ...overrides,
  };
}

function makeReport(overrides = {}) {
  const group = { cases: 1, recallAt10: 1, mrr: 1, ndcgAt10: 1 };
  return {
    schemaVersion: 'search-quality-report-v1',
    releaseId,
    corpusSha256: 'a'.repeat(64),
    fixtureSchemaVersion: 'relevance-set-v2',
    cases: 2,
    positiveCases: 2,
    recallAt10: 1,
    mrr: 1,
    ndcgAt10: 1,
    exactAndNavigationalSuccess: 1,
    exactAndNavigationalCases: 1,
    zeroResultAccuracy: 1,
    queryHitRate: 1,
    latencyMs: {
      coldInit: 1,
      warm: { p50: 1, p95: 2, max: 3 },
      byStratum: { common: { cases: 2, p50: 1, p95: 2, max: 3 } },
    },
    bytes: {
      initRaw: 1,
      queryRuntime: 0,
      artifacts: { index: { raw: 1, gzip: 1, brotli: 1 } },
    },
    memory: { rssBytes: 1 },
    byKind: { exact: { ...group } },
    bySplit: { development: { ...group }, holdout: { ...group } },
    protocol: makeFixture().protocol,
    failures: [],
    ...overrides,
  };
}

const approvedRatchets = {
  SEARCH_QUALITY_MIN_RECALL: '0.9',
  SEARCH_QUALITY_MIN_NDCG: '0.9',
};

describe('search quality gate', () => {
  it('loads the versioned provisional release ratchets', () => {
    expect(loadSearchQualityThresholds()).toEqual({
      SEARCH_QUALITY_MIN_RECALL: '0.99',
      SEARCH_QUALITY_MIN_NDCG: '0.97',
    });
  });

  it('accepts a release-bound finite report with development and holdout evidence', () => {
    expect(validateSearchQualityGate({
      report: makeReport(),
      fixture: makeFixture(),
      env: approvedRatchets,
    })).toEqual([]);
  });

  it('rejects a missing holdout split instead of accepting development-only evidence', () => {
    const fixture = makeFixture({ cases: [makeCase('development-exact', 'development')] });
    const report = makeReport({
      cases: 1,
      bySplit: { development: { cases: 1, recallAt10: 1, mrr: 1, ndcgAt10: 1 } },
    });

    expect(validateSearchQualityGate({ report, fixture, env: approvedRatchets })).toEqual(
      expect.arrayContaining([expect.stringContaining('holdout')]),
    );
  });

  it('rejects missing reviewer governance', () => {
    const fixture = makeFixture({ reviewers: [] });

    expect(validateSearchQualityGate({
      report: makeReport(),
      fixture,
      env: approvedRatchets,
    })).toEqual(expect.arrayContaining([expect.stringContaining('reviewer')]));
  });

  it('rejects missing or non-finite ratchets instead of defaulting them to zero', () => {
    const missing = validateSearchQualityGate({ report: makeReport(), fixture: makeFixture(), env: {} });
    const invalid = validateSearchQualityGate({
      report: makeReport(),
      fixture: makeFixture(),
      env: { SEARCH_QUALITY_MIN_RECALL: 'NaN', SEARCH_QUALITY_MIN_NDCG: '0.9' },
    });

    expect(missing).toEqual(expect.arrayContaining([expect.stringContaining('SEARCH_QUALITY_MIN_RECALL')]));
    expect(invalid).toEqual(expect.arrayContaining([expect.stringContaining('finite')]));
  });

  it('rejects finite metrics below the approved ratchets', () => {
    const report = makeReport({ recallAt10: 0.8, ndcgAt10: 0.85 });

    expect(validateSearchQualityGate({ report, fixture: makeFixture(), env: approvedRatchets })).toEqual(expect.arrayContaining([
      expect.stringContaining('Recall@10'),
      expect.stringContaining('NDCG@10'),
    ]));
  });

  it('rejects non-finite report metrics', () => {
    const report = makeReport({ recallAt10: Number.NaN });

    expect(validateSearchQualityGate({ report, fixture: makeFixture(), env: approvedRatchets })).toEqual(
      expect.arrayContaining([expect.stringContaining('recallAt10')]),
    );
  });

  it('preserves the zero-result correctness gate', () => {
    const report = makeReport({ zeroResultAccuracy: 0.5 });

    expect(validateSearchQualityGate({ report, fixture: makeFixture(), env: approvedRatchets })).toEqual(
      expect.arrayContaining([expect.stringContaining('zero-result')]),
    );
  });

  it('rejects a development exact or facet regression reported by the evaluator', () => {
    const report = makeReport({ failures: [{ id: 'development-exact', query: 'development-exact', expected: [], actual: [] }] });

    expect(validateSearchQualityGate({ report, fixture: makeFixture(), env: approvedRatchets })).toEqual(
      expect.arrayContaining([expect.stringContaining('development exact/facet')]),
    );
  });

  it('rejects a query reused across development and holdout', () => {
    const development = makeCase('development-exact', 'development');
    const holdout = { ...makeCase('holdout-exact', 'holdout'), query: development.query };
    const fixture = makeFixture({ cases: [development, holdout] });

    expect(validateSearchQualityGate({ report: makeReport(), fixture, env: approvedRatchets })).toEqual(
      expect.arrayContaining([expect.stringContaining('holdout query contamination')]),
    );
  });

  it('accepts a candidate only when development is protected and holdout clears explicit deltas', () => {
    const baseline = makeReport({ bySplit: {
      development: { cases: 1, recallAt10: 1, mrr: 1, ndcgAt10: 1 },
      holdout: { cases: 1, recallAt10: 0.8, mrr: 0.8, ndcgAt10: 0.8 },
    } });
    const candidate = makeReport({ bySplit: {
      development: { cases: 1, recallAt10: 1, mrr: 1, ndcgAt10: 1 },
      holdout: { cases: 1, recallAt10: 0.8, mrr: 0.8, ndcgAt10: 0.9 },
    } });

    expect(compareSearchQualityReports({
      baseline, candidate, fixture: makeFixture(),
      env: { SEARCH_QUALITY_MIN_HOLDOUT_NDCG_DELTA: '0.05', SEARCH_QUALITY_MIN_HOLDOUT_RECALL_DELTA: '0.05' },
    })).toEqual([]);
  });

  it('rejects a candidate with a new development exact/facet failure or no holdout win', () => {
    const baseline = makeReport({ bySplit: {
      development: { cases: 1, recallAt10: 1, mrr: 1, ndcgAt10: 1 },
      holdout: { cases: 1, recallAt10: 0.8, mrr: 0.8, ndcgAt10: 0.8 },
    } });
    const candidate = makeReport({
      failures: [{ id: 'development-exact' }],
      bySplit: {
        development: { cases: 1, recallAt10: 1, mrr: 1, ndcgAt10: 1 },
        holdout: { cases: 1, recallAt10: 0.8, mrr: 0.8, ndcgAt10: 0.8 },
      },
    });

    expect(compareSearchQualityReports({
      baseline, candidate, fixture: makeFixture(),
      env: { SEARCH_QUALITY_MIN_HOLDOUT_NDCG_DELTA: '0', SEARCH_QUALITY_MIN_HOLDOUT_RECALL_DELTA: '0' },
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('development exact/facet regression'),
      expect.stringContaining('holdout win'),
    ]));
  });

  it('rejects candidate/baseline reports with different release or contamination proofs', () => {
    const candidate = makeReport({ releaseId: 'data@candidate' });

    expect(compareSearchQualityReports({
      baseline: makeReport(), candidate, fixture: makeFixture(), env: {},
    })).toEqual(expect.arrayContaining([expect.stringContaining('release identity')]));
  });
});
