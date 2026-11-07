import { isIndexable, type Entry } from '@hub/contracts';

const FLOOR = 0.6;

function counts(entries: readonly Entry[]): { canonical: number; indexable: number } {
  return {
    canonical: entries.filter((entry) => entry.dedup?.canonical === true).length,
    indexable: entries.filter(isIndexable).length,
  };
}

/** One line for the build log, naming the numbers the gate decided on. */
export function indexableFloorReport(entries: readonly Entry[]): string {
  const { canonical, indexable } = counts(entries);
  const ratio = canonical > 0 ? indexable / canonical : 1;
  return `[Phase 3 / SEO-3 Gate] Total entries: ${entries.length} | Indexable: ${indexable} `
    + `(${(ratio * 100).toFixed(1)}% of ${canonical} canonical entries) | Noindex: ${entries.length - indexable}`;
}

/**
 * The floor SEO-3 was always protecting: a mass loss of publishable pages.
 *
 * It used to divide indexable entries by *redistributable canonicals*, which
 * stopped being a meaningful denominator the moment publication stopped asking
 * about rights — 12,923 over 288 is 4,487%, a number no regression can push
 * below 60%. A gate that cannot fail reads as protection while providing none.
 *
 * Canonical entries is the denominator that matches the claim: of the workflows
 * we elected to publish, most should be publishable.
 */
export function assertIndexableFloor(entries: readonly Entry[]): void {
  const { canonical, indexable } = counts(entries);
  if (canonical === 0) return;

  const ratio = indexable / canonical;
  if (ratio < FLOOR) {
    throw new Error(
      `[SEO-3 Gate Failed] Indexable pages ratio (${(ratio * 100).toFixed(1)}%) `
      + `dropped below ${FLOOR * 100}% of ${canonical} canonical entries`,
    );
  }
}
