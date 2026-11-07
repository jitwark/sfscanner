import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../pipeline/__fixtures__/make-entry.js';
import { assertCorpusCountsMatchAnalytics, computeCorpusCounts } from './public-dataset-analytics-check.js';

// Searchable requires dedup.canonical, nodeCount >= 3, and >= 1 integration
// (contracts/indexability.ts's `isSearchable`) — mirrored here so the fixture
// entries below exercise both a searchable and a non-searchable shape.
const searchableEntry = (id: string, overrides: Parameters<typeof makeEntry>[0] = {}) =>
  makeEntry({
    id,
    dedup: { canonical: true },
    structure: { nodeCount: 3, integrations: ['webhook'] },
    ...overrides,
  });

describe('computeCorpusCounts', () => {
  it('counts total, searchable, redistributable and link-only entries', () => {
    const entries = [
      searchableEntry('a', { rights: { status: 'redistributable' } }),
      searchableEntry('b', { rights: { status: 'link_only' } }),
      // Not searchable: only 2 nodes and no integrations.
      makeEntry({ id: 'c', rights: { status: 'link_only' }, structure: { nodeCount: 2, integrations: [] } }),
    ];
    expect(computeCorpusCounts(entries)).toEqual({
      total: 3,
      searchable: 2,
      rights: { redistributable: 1, linkOnly: 2 },
    });
  });

  it('folds excluded entries into linkOnly, matching pipeline/derive/corpus-analytics.ts', () => {
    const entries = [
      searchableEntry('a', { rights: { status: 'redistributable' } }),
      searchableEntry('b', { rights: { status: 'excluded' } }),
    ];
    expect(computeCorpusCounts(entries).rights).toEqual({ redistributable: 1, linkOnly: 1 });
  });
});

describe('assertCorpusCountsMatchAnalytics', () => {
  const entries = [
    searchableEntry('a', { rights: { status: 'redistributable' } }),
    searchableEntry('b', { rights: { status: 'link_only' } }),
  ];

  it('does not throw when the derived counts match analytics.json', () => {
    expect(() =>
      assertCorpusCountsMatchAnalytics(entries, { total: 2, searchable: 2, rights: { redistributable: 1, linkOnly: 1 } }),
    ).not.toThrow();
  });

  it('throws naming every mismatched figure', () => {
    expect(() =>
      assertCorpusCountsMatchAnalytics(entries, { total: 3, searchable: 1, rights: { redistributable: 2, linkOnly: 1 } }),
    ).toThrow(/total 2\/3.*searchable 2\/1.*redistributable 1\/2/s);
  });

  it('throws on a linkOnly mismatch alone', () => {
    expect(() =>
      assertCorpusCountsMatchAnalytics(entries, { total: 2, searchable: 2, rights: { redistributable: 1, linkOnly: 99 } }),
    ).toThrow(/linkOnly 1\/99/);
  });
});
