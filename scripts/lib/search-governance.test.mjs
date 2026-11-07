import { describe, expect, it } from 'vitest';
import {
  canonicalQueryKey,
  querySetSha256,
  validateSearchGovernance,
} from './search-governance.mjs';

const release = {
  releaseId: 'synthetic@2026-08-31T00:00:00.000Z',
  corpusId: 'synthetic',
  generatedAt: '2026-08-31T00:00:00.000Z',
  corpusSha256: 'a'.repeat(64),
};

function makeCase(id, split, overrides = {}) {
  return {
    id,
    split,
    kind: 'exact',
    sort: 'relevance',
    query: id,
    filters: { integration: ['google-sheets', 'slack'] },
    ...overrides,
  };
}

function makeFixture(overrides = {}) {
  const cases = overrides.cases ?? [
    makeCase('development-query', 'development'),
    makeCase('holdout-query', 'holdout'),
  ];
  return {
    schemaVersion: 'relevance-set-v2',
    release,
    protocol: {
      tuningSplit: 'development',
      holdoutSplit: 'holdout',
      holdoutPolicy: 'untouched-evaluate-once',
      queryKey: 'query+filters+sort-v1',
      developmentQuerySetSha256: querySetSha256(cases, 'development'),
      holdoutQuerySetSha256: querySetSha256(cases, 'holdout'),
    },
    cases,
    ...overrides,
  };
}

describe('search governance validator', () => {
  it('accepts a valid release-bound development and holdout fixture', () => {
    const report = validateSearchGovernance({ fixture: makeFixture() });

    expect(report).toMatchObject({
      ok: true,
      schemaVersion: 'relevance-set-v2',
      releaseId: release.releaseId,
      splits: {
        development: { cases: 1 },
        holdout: { cases: 1 },
      },
    });
    expect(report.errors).toEqual([]);
  });

  it('rejects a canonical query key reused across development and holdout', () => {
    const development = makeCase('development-query', 'development');
    const holdout = makeCase('holdout-query', 'holdout', { query: development.query });
    const report = validateSearchGovernance({ fixture: makeFixture({ cases: [development, holdout] }) });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('canonical query key contamination'),
    ]));
  });

  it('rejects a stale pinned holdout query-set hash', () => {
    const fixture = makeFixture({
      protocol: {
        ...makeFixture().protocol,
        holdoutQuerySetSha256: '0'.repeat(64),
      },
    });

    const report = validateSearchGovernance({ fixture });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('holdoutQuerySetSha256 is stale'),
    ]));
  });

  it('rejects a fixture without a holdout split', () => {
    const cases = [makeCase('development-query', 'development')];
    const report = validateSearchGovernance({ fixture: makeFixture({ cases }) });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('missing holdout split'),
    ]));
  });

  it('rejects malformed protocol fields instead of inferring a policy', () => {
    const fixture = makeFixture({
      protocol: {
        tuningSplit: 'holdout',
        holdoutSplit: 'development',
        holdoutPolicy: 'tune-holdout',
        queryKey: 'query-only',
      },
    });

    const report = validateSearchGovernance({ fixture });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('protocol.tuningSplit'),
      expect.stringContaining('protocol.holdoutPolicy'),
      expect.stringContaining('protocol.queryKey'),
    ]));
  });

  it('rejects a release identity that does not match its timestamp binding', () => {
    const fixture = makeFixture({
      release: { ...release, releaseId: 'synthetic@stale' },
    });

    const report = validateSearchGovernance({
      fixture,
      expectedReleaseId: release.releaseId,
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('release identity'),
    ]));
  });

  it('keeps canonical keys and reports deterministic when input order changes', () => {
    const fixture = makeFixture();
    const reversed = makeFixture({ cases: [...fixture.cases].reverse() });

    expect(canonicalQueryKey(fixture.cases[0])).toBe(canonicalQueryKey({
      ...fixture.cases[0],
      filters: { integration: ['slack', 'google-sheets'] },
    }));
    expect(JSON.stringify(validateSearchGovernance({ fixture })))
      .toBe(JSON.stringify(validateSearchGovernance({ fixture: reversed })));
  });
});
