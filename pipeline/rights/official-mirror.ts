import type { EntryRights } from '@hub/contracts';

/**
 * Withdraw redistribution rights from workflows that are also published in
 * n8n's own template library.
 *
 * `decideRights` applies a repository's SPDX id to every file in that
 * repository, which is only valid for work the repository owner authored. Two
 * of our sources are near-complete mirrors of n8n.io — measured at 98.0% and
 * 99.3% overlap by `pipeline/measure/mirror-overlap.ts` — and both ship a
 * permissive LICENSE file. Nobody can license someone else's workflow by
 * committing it under one.
 *
 * The test is per workflow rather than per repository on purpose. A blocklist
 * of "bad repos" is a hand-maintained list that goes stale the moment a source
 * is added, and it is wrong in both directions: it strips the 60% of
 * `murataslan1` that is not a mirror, and it misses the next mirror nobody has
 * reviewed yet. Dedup already knows, workflow by workflow, whether the same
 * thing exists on n8n.io.
 *
 * Runs **before** the election, so that when a mirror and the official
 * template meet, both are link-only and the official entry wins on metadata —
 * which points the page at n8n.io, where the workflow actually came from.
 */
export const OFFICIAL_MIRROR_REASON = 'contrary evidence: also published as an official n8n template';

export type MirrorCandidate = {
  source: { kind: string };
  rights: EntryRights;
  dedup: { structuralHash: string; fingerprint: string };
};

export type MirrorDemotion = {
  /** Candidates whose rights changed from redistributable to link-only. */
  demoted: number;
  /** Distinct structural groups that contained an official template. */
  groups: number;
};

export function demoteOfficialMirrors<T extends MirrorCandidate>(candidates: T[]): MirrorDemotion {
  const officialGroups = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.source.kind !== 'n8n_official') continue;
    // An absent hash means "we could not compute one", not "identical to every
    // other workflow that also could not". Grouping on it is the defect that
    // turned 11,490 official templates into a single entry.
    if (!candidate.dedup.structuralHash) continue;
    officialGroups.add(candidate.dedup.structuralHash);
  }

  let demoted = 0;
  for (const candidate of candidates) {
    if (candidate.source.kind === 'n8n_official') continue;
    if (candidate.rights.status !== 'redistributable') continue;
    if (!candidate.dedup.structuralHash) continue;
    if (!officialGroups.has(candidate.dedup.structuralHash)) continue;

    candidate.rights = {
      status: 'link_only',
      // Keep what the repository claimed, so the page can still report it.
      // Only our willingness to redistribute changes.
      licence: candidate.rights.licence,
      licenceUrl: candidate.rights.licenceUrl,
      reason: OFFICIAL_MIRROR_REASON,
    };
    demoted += 1;
  }

  return { demoted, groups: officialGroups.size };
}
