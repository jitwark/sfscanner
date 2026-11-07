/**
 * Cross-checks the corpus counts the public-dataset exporter is about to
 * publish against `data/analytics.json` — the site's own, already-trusted
 * count of the same corpus (`check:docs` holds it to `pipeline/derive/
 * corpus-analytics.ts`). A dataset that quietly disagrees with the site is
 * worse than no dataset, so a mismatch here is a hard failure, not a warning.
 *
 * The four figures mirror `deriveCorpusAnalytics` exactly:
 *   - `total` is every catalogue entry, unfiltered.
 *   - `redistributable` counts `rights.status === 'redistributable'`.
 *   - `linkOnly` is `total - redistributable` (any `excluded` entry folds
 *     into this by subtraction, not a direct status match — see
 *     `pipeline/derive/corpus-analytics.ts`).
 *   - `searchable` counts `isSearchable` (`contracts/indexability.ts`), which
 *     empirically equals the summed-tier figure `analytics.json` stores.
 */
import { isSearchable, type Entry } from '@hub/contracts';

export type AnalyticsCounts = {
  total: number;
  searchable: number;
  rights: { redistributable: number; linkOnly: number };
};

export function computeCorpusCounts(entries: readonly Entry[]): AnalyticsCounts {
  const total = entries.length;
  const redistributable = entries.filter((entry) => entry.rights?.status === 'redistributable').length;
  const searchable = entries.filter(isSearchable).length;
  return { total, searchable, rights: { redistributable, linkOnly: total - redistributable } };
}

export function assertCorpusCountsMatchAnalytics(entries: readonly Entry[], analytics: AnalyticsCounts): void {
  const actual = computeCorpusCounts(entries);
  const mismatches: string[] = [];
  if (actual.total !== analytics.total) mismatches.push(`total ${actual.total}/${analytics.total}`);
  if (actual.searchable !== analytics.searchable) mismatches.push(`searchable ${actual.searchable}/${analytics.searchable}`);
  if (actual.rights.redistributable !== analytics.rights.redistributable) {
    mismatches.push(`redistributable ${actual.rights.redistributable}/${analytics.rights.redistributable}`);
  }
  if (actual.rights.linkOnly !== analytics.rights.linkOnly) mismatches.push(`linkOnly ${actual.rights.linkOnly}/${analytics.rights.linkOnly}`);
  if (mismatches.length > 0) {
    throw new Error(`Public dataset export: corpus counts disagree with data/analytics.json (computed/expected): ${mismatches.join(', ')}`);
  }
}
