import type { Candidate, Reject } from '@hub/contracts';
import type { LicenceBasis } from '../rights/evidence.js';

/**
 * The acquisition-time consequence of licence evidence, kept in one place
 * because `acquire-stage.ts` is at its file-size ceiling and because this rule
 * is a single decision rather than stage bookkeeping.
 *
 * A workflow whose licence cannot be established at the selected commit is
 * dropped here, before it becomes a candidate any later stage can see. That is
 * narrower than "no licence": a repository with no licence file at all still
 * yields entries whose licence is established *as absent*, which the rights
 * stage publishes as a link. What is dropped is the workflow where we cannot
 * say which case we are in — no licence instrument at the commit and no licence
 * in repository metadata — because the alternative is writing `null` into a
 * provenance field and letting a later stage read that as "no restrictions".
 *
 * A drop is recorded as a reject, never omitted silently: the corpus report
 * counts it, and `rights_evidence_missing` names why.
 */
export function partitionByLicenceEvidence(
  candidates: readonly Candidate[],
  licenceBasis: LicenceBasis,
  sourceKey: string,
): { included: Candidate[]; dropped: Reject[] } {
  if (licenceBasis !== 'none') return { included: [...candidates], dropped: [] };

  return {
    included: [],
    dropped: candidates.map((candidate) => ({
      sourceKey,
      path: candidate.source.path ?? '',
      reason: 'rights_evidence_missing',
      detail:
        'no licence instrument at the selected commit and no licence in repository metadata; the licence cannot be established',
    })),
  };
}
