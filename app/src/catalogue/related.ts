import type { Entry } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { isIndexable } from '../seo/page-meta';

type Candidate = {
  entry: Entry;
  id: string;
  slug: string;
  primary: string | undefined;
  hash: string | undefined;
  trigger: string | undefined;
  complexity: string | undefined;
  qs: number;
};

/**
 * The candidate facts, derived once instead of once per page.
 *
 * `computeRelated` used to call `isIndexable` and the quality function on every
 * candidate on every page. That was affordable while publication was gated on
 * redistribution rights and the pool held 287 entries. It is not affordable at
 * 12,923: measured at 19.8 ms per page, or 4.4 minutes across the catalogue,
 * before a single page is rendered.
 *
 * This changes no answer. The comparator below is untouched and the scan is
 * still exhaustive — only the re-derivation is hoisted.
 */
export type RelatedIndex = { candidates: Candidate[] };

function defaultScore(entry: Entry): number {
  return (entry.security?.score ?? 50) + (entry.structure?.nodeCount ?? 0) * 0.1;
}

export function buildRelatedIndex(
  candidates: readonly Entry[],
  qualityScoreFn?: (entry: Entry) => number,
): RelatedIndex {
  const score = qualityScoreFn ?? defaultScore;
  const table: Candidate[] = [];
  for (const entry of candidates) {
    if (!isIndexable(entry)) continue;
    table.push({
      entry,
      id: entry.id,
      slug: entry.slug,
      primary: entry.structure?.integrations?.[0],
      hash: entry.dedup?.structuralHash,
      trigger: entry.structure?.trigger,
      complexity: entry.structure?.complexity,
      qs: score(entry),
    });
  }
  return { candidates: table };
}

type Ranked = { candidate: Candidate; samePrimary: number; sameHash: number; sameTriggerComplexity: number };

/** Positive when `a` outranks `b`. The original comparator, unchanged. */
function outranks(a: Ranked, b: Ranked): number {
  if (a.samePrimary !== b.samePrimary) return a.samePrimary - b.samePrimary;
  if (a.sameHash !== b.sameHash) return a.sameHash - b.sameHash;
  if (a.sameTriggerComplexity !== b.sameTriggerComplexity) {
    return a.sameTriggerComplexity - b.sameTriggerComplexity;
  }
  if (a.candidate.qs !== b.candidate.qs) return a.candidate.qs - b.candidate.qs;
  return compareCanonicalStrings(b.candidate.id, a.candidate.id);
}

/**
 * Compute related entries deterministically.
 * Priority:
 * 1. Same primary integration (integrations[0])
 * 2. Shared structuralHash neighbours
 * 3. Same trigger and complexity band
 * 4. Quality score (higher is better)
 * 5. Entry ID (lexicographical tie-break)
 */
export function computeRelated(
  entry: Entry,
  candidates: Entry[],
  limit = 6,
  qualityScoreFn?: (e: Entry) => number,
  index?: RelatedIndex,
): Entry[] {
  const primaryIntegration = entry.structure?.integrations?.[0];
  const targetHash = entry.dedup?.structuralHash;
  const targetTrigger = entry.structure?.trigger;
  const targetComplexity = entry.structure?.complexity;
  const table = (index ?? buildRelatedIndex(candidates, qualityScoreFn)).candidates;

  // Insertion into a `limit`-sized list rather than sorting the whole pool:
  // `limit` is 6 and the pool is the catalogue.
  const best: Ranked[] = [];
  for (const candidate of table) {
    if (candidate.id === entry.id || candidate.slug === entry.slug) continue;

    const ranked: Ranked = {
      candidate,
      samePrimary: Boolean(primaryIntegration) && candidate.primary === primaryIntegration ? 1 : 0,
      sameHash: Boolean(targetHash) && Boolean(candidate.hash) && candidate.hash === targetHash ? 1 : 0,
      sameTriggerComplexity:
        Boolean(targetTrigger) && Boolean(targetComplexity)
        && candidate.trigger === targetTrigger && candidate.complexity === targetComplexity ? 1 : 0,
    };

    if (best.length === limit && outranks(ranked, best[best.length - 1]) <= 0) continue;
    let at = best.length;
    while (at > 0 && outranks(ranked, best[at - 1]) > 0) at -= 1;
    best.splice(at, 0, ranked);
    if (best.length > limit) best.pop();
  }

  return best.map((ranked) => ranked.candidate.entry);
}
