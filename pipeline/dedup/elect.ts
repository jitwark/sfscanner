import type { Candidate, EntryDedup } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { fingerprint, structuralHash } from './signatures.js';

export type CandidateWithDedup = Candidate & {
  dedup?: EntryDedup;
  tags?: string[];
};

export type ElectResult<T extends CandidateWithDedup = CandidateWithDedup> = {
  canonical: T[];
  duplicates: T[];
  stats: {
    candidates: number;
    exactDuplicates: number;
    structuralDuplicates: number;
    canonicals: number;
  };
};

function getMetadataScore(c: CandidateWithDedup): number {
  let score = 0;
  if (c.upstreamDescription && c.upstreamDescription.trim().length > 0) score++;
  if (c.source?.author?.name && c.source.author.name.trim().length > 0) score++;
  if (Array.isArray(c.tags) && c.tags.length > 0) score++;
  return score;
}

function compareCandidates(a: CandidateWithDedup, b: CandidateWithDedup): number {
  // Rule 1: redistributable beats link_only
  const rightsA = a.rights?.status === 'redistributable' ? 1 : 0;
  const rightsB = b.rights?.status === 'redistributable' ? 1 : 0;
  if (rightsA !== rightsB) return rightsB - rightsA;

  // Rule 2: richer metadata
  const metaA = getMetadataScore(a);
  const metaB = getMetadataScore(b);
  if (metaA !== metaB) return metaB - metaA;

  // Rule 3: higher repo stars
  const starsA = a.source?.stars ?? 0;
  const starsB = b.source?.stars ?? 0;
  if (starsA !== starsB) return starsB - starsA;

  // Rule 4: more recent commit
  const commitA = a.source?.committedAt ?? '';
  const commitB = b.source?.committedAt ?? '';
  if (commitA !== commitB) return compareCanonicalStrings(commitB, commitA);

  // Rule 5: lexicographic entry id
  return compareCanonicalStrings(a.id, b.id);
}

export function elect<T extends CandidateWithDedup>(candidates: T[]): ElectResult<T> {
  if (candidates.length === 0) {
    return {
      canonical: [],
      duplicates: [],
      stats: { candidates: 0, exactDuplicates: 0, structuralDuplicates: 0, canonicals: 0 },
    };
  }

  // Honour hashes the caller already computed. `build-corpus` derives a
  // per-template fingerprint for any candidate that has no `json`, and this
  // function used to discard it and recompute from `c.json` — which was
  // `undefined` for all 11,490 official templates on run rederive-62, so every
  // one of them hashed identically, formed a single exact-duplicate group, and
  // 11,489 were dropped. Two hash paths that can silently disagree is the
  // defect; the supplied value wins.
  const items = candidates.map((c) => ({
    candidate: c,
    fp: c.dedup?.fingerprint || fingerprint(c.json),
    sh: c.dedup?.structuralHash || structuralHash(c.json),
  }));

  const fpGroups = new Map<string, typeof items>();
  for (const item of items) {
    const list = fpGroups.get(item.fp) ?? [];
    list.push(item);
    fpGroups.set(item.fp, list);
  }

  let exactDuplicatesCount = 0;
  const fpWinners: typeof items = [];
  const fpDuplicates = new Map<string, typeof items>();

  for (const [, group] of fpGroups) {
    group.sort((a, b) => compareCandidates(a.candidate, b.candidate));
    const winner = group[0];
    fpWinners.push(winner);

    const dupes = group.slice(1);
    exactDuplicatesCount += dupes.length;
    fpDuplicates.set(winner.candidate.id, dupes);
  }

  const shGroups = new Map<string, typeof items>();
  for (const item of fpWinners) {
    const list = shGroups.get(item.sh) ?? [];
    list.push(item);
    shGroups.set(item.sh, list);
  }

  const canonicalResults: T[] = [];
  const duplicateResults: T[] = [];
  let structuralDuplicatesCount = 0;

  for (const [, group] of shGroups) {
    group.sort((a, b) => compareCandidates(a.candidate, b.candidate));
    const canonicalItem = group[0];
    const canonicalId = canonicalItem.candidate.id;

    const permalinksSet = new Set<string>();

    const structDupes = group.slice(1);
    structuralDuplicatesCount += structDupes.length;

    const allInGroup = group.flatMap((g) => [g, ...(fpDuplicates.get(g.candidate.id) ?? [])]);

    for (const item of allInGroup) {
      if (item.candidate.source?.permalink && item.candidate.id !== canonicalId) {
        permalinksSet.add(item.candidate.source.permalink);
      }
    }

    const alsoFoundIn = Array.from(permalinksSet).sort();

    const canonicalCandidate: T = {
      ...canonicalItem.candidate,
      dedup: {
        fingerprint: canonicalItem.fp,
        structuralHash: canonicalItem.sh,
        canonical: true,
        alsoFoundIn,
      },
    };
    canonicalResults.push(canonicalCandidate);

    for (const item of allInGroup) {
      if (item.candidate.id === canonicalId) continue;

      const dupCandidate: T = {
        ...item.candidate,
        dedup: {
          fingerprint: item.fp,
          structuralHash: item.sh,
          canonical: false,
          duplicateOf: canonicalId,
          alsoFoundIn: [],
        },
      };
      duplicateResults.push(dupCandidate);
    }
  }

  canonicalResults.sort((a, b) => compareCanonicalStrings(a.id, b.id));
  duplicateResults.sort((a, b) => compareCanonicalStrings(a.id, b.id));

  return {
    canonical: canonicalResults,
    duplicates: duplicateResults,
    stats: {
      candidates: candidates.length,
      exactDuplicates: exactDuplicatesCount,
      structuralDuplicates: structuralDuplicatesCount,
      canonicals: canonicalResults.length,
    },
  };
}
