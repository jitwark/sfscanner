import { describe, expect, it } from 'vitest';
import { SEARCH_INDEX_TIER_FILES, totalSearchableDocuments } from './searchable-count.js';

const tier = (documentCount: number) => ({ documentCount });

describe('totalSearchableDocuments', () => {
  it('sums documentCount across every tier', () => {
    expect(totalSearchableDocuments([tier(2000), tier(10923)])).toBe(12923);
  });

  /**
   * The regression this function exists to make impossible. Reporting only the
   * primary tier understated the catalogue by 10,923 on every page that states
   * a count, and it shipped twice — once from `layout.tsx` reading the index
   * directly, once from `derive-analytics.ts` reading a single file. Both were
   * "read documentCount", which is correct-looking and wrong.
   */
  it('does not report the primary tier alone', () => {
    const both = totalSearchableDocuments([tier(2000), tier(10923)]);
    expect(both).not.toBe(2000);
  });

  it('treats a tier with no documentCount as contributing nothing', () => {
    expect(totalSearchableDocuments([tier(2000), {}])).toBe(2000);
  });

  it('is zero when there are no tiers', () => {
    expect(totalSearchableDocuments([])).toBe(0);
  });

  it('names every tier file that contributes to the searchable total', () => {
    expect([...SEARCH_INDEX_TIER_FILES]).toEqual(['search-index.json', 'search-index-extended.json']);
  });
});
