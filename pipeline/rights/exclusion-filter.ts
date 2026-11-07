import type { Candidate, ExclusionRecord, ExclusionRegistry } from '@hub/contracts';
import { createExclusionRegistry } from '@hub/contracts';
import exclusionRecords from './exclusions.json';

/**
 * The production exclusion registry, loaded from `exclusions.json`.
 *
 * Empty today: the retention/deletion/exclusion policy that would populate it
 * with real ids is still an owner decision — see
 * `openspec/changes/legal-rights-and-release-integrity/tasks.md`'s `[B]`
 * item. This module, `exclusions.json`, and their tests are the engineering
 * scaffolding that decision plugs into: once an id is added to
 * `exclusions.json` with a reason and date, the very next `npm run corpus`
 * drops it before rights are decided, with no further code change.
 */
export const PRODUCTION_EXCLUSION_REGISTRY: ExclusionRegistry = createExclusionRegistry(
  exclusionRecords as ExclusionRecord[],
);

export type ExclusionFilterResult = {
  included: Candidate[];
  excluded: Candidate[];
};

/**
 * Removes every candidate whose id the registry recognizes, before rights are
 * decided or any later stage runs.
 *
 * This is the single choke point for exclusion: see `build-corpus.ts`'s call
 * site, applied to `rawCandidates` immediately after acquisition assembles
 * it and before the rights/sanitize/scan/dedup/index/package stages see
 * anything. Filtering this early — rather than at rights decision, or at
 * packaging — is what makes "absent from acquisition output" literally true
 * instead of merely "absent from the published release", and it means none
 * of the later stages need to know the registry exists at all.
 */
export function filterExcludedCandidates(
  candidates: readonly Candidate[],
  registry: ExclusionRegistry = PRODUCTION_EXCLUSION_REGISTRY,
): ExclusionFilterResult {
  const included: Candidate[] = [];
  const excluded: Candidate[] = [];
  for (const candidate of candidates) {
    (registry.isExcluded(candidate.id) ? excluded : included).push(candidate);
  }
  return { included, excluded };
}
