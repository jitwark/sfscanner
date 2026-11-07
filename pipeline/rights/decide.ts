import type { EntryRights, SourceKind } from '@hub/contracts';
import { REDISTRIBUTABLE_LICENCES } from '@hub/contracts';
import {
  completeEvidence,
  contraryLicenceGroups,
  expectedLicenceMatch,
  type RightsEvidence,
  type RightsEvidenceInput,
} from './evidence.js';

export type RightsInput = {
  spdxId: string | null;
  licenceUrl?: string | null;
  workflowPath: string;
  headerText?: string | null;
  repoOwner?: string | null;
  readmeHead?: string | null;
  sourceKind?: SourceKind;
  /** `redistribute: false` on the source definition. See `sources.schema.ts`. */
  sourceRedistribute?: false;
  /** The `expectedLicence` configured on the source. Compared, never applied. */
  expectedLicence?: string | null;
  /**
   * What acquisition recorded for this workflow. Absent means nothing was
   * recorded, which is filled with evidence that cannot support redistribution
   * — see `completeEvidence`.
   */
  evidence?: Partial<RightsEvidenceInput>;
};

/**
 * One rights decision: the record the pipeline may publish, and the evidence it
 * was made on.
 *
 * They are returned separately on purpose. `evidence` must never ride along
 * inside `rights`, because `rights` is the published record — a licence blob
 * hash or a source commit appearing in it would widen the public contract
 * silently, which is why the caller projects the four published fields rather
 * than forwarding this object.
 */
export type RightsDecision = {
  /**
   * `status: 'excluded'` is quarantine: the record is withheld from every
   * published output pending a rights-holder decision, and the caller removes
   * the candidate rather than publishing the link. See `rightsStage`.
   */
  rights: EntryRights;
  /** Everything the decision read, so a reviewer can re-derive it. */
  evidence: RightsEvidence;
};

export function decideRights(input: RightsInput): RightsDecision {
  const licenceUrl = input.licenceUrl ?? null;
  const recorded = completeEvidence(input.evidence);
  const evidence: RightsEvidence = {
    ...recorded,
    workflowPath: input.workflowPath,
    expectedLicence: input.expectedLicence ?? null,
    expectedLicenceMatch: expectedLicenceMatch(input.spdxId, input.expectedLicence),
  };
  const decide = (rights: EntryRights): RightsDecision => ({ rights, evidence });

  // A registry-level withdrawal outranks the licence file, because the licence
  // file is exactly what is in doubt: it can only cover work its owner authored.
  // Checked first so no later branch can hand back redistribution.
  if (input.sourceRedistribute === false) {
    return decide({
      status: 'link_only',
      licence: input.spdxId ?? null,
      licenceUrl,
      reason: 'contrary evidence: a collection of workflows the uploader did not author',
    });
  }

  if (input.sourceKind === 'n8n_official') {
    return decide({
      status: 'link_only',
      licence: null,
      licenceUrl,
      reason: 'official n8n template — linked, not redistributed',
    });
  }

  const spdx = input.spdxId;

  if (spdx === null || spdx === undefined) {
    return decide({
      status: 'link_only',
      licence: null,
      licenceUrl,
      reason: 'no licence file',
    });
  }

  if (!REDISTRIBUTABLE_LICENCES[spdx]) {
    return decide({
      status: 'link_only',
      licence: spdx,
      licenceUrl,
      reason: `repository licence: ${spdx}`,
    });
  }

  // Repository licence is allowlisted — check contrary evidence rules

  // Rule 1: A licence file beside, or above, the workflow that does not restate
  // the repository's own licence instrument. The terms for this subtree are not
  // the terms we decided on, so the record is quarantined rather than published.
  const contrary = contraryLicenceGroups(
    input.workflowPath,
    [...evidence.siblingLicence, ...evidence.nestedLicence],
    evidence.rootLicence,
  );
  if (contrary.sibling.length > 0) {
    return decide({
      status: 'excluded',
      licence: spdx,
      licenceUrl,
      reason: `rights evidence conflict: licence file ${contrary.sibling[0]!.filename} beside the workflow differs from the repository licence instrument — withheld pending a rights-holder decision`,
    });
  }
  if (contrary.ancestor.length > 0) {
    return decide({
      status: 'excluded',
      licence: spdx,
      licenceUrl,
      reason: `rights evidence conflict: licence file ${contrary.ancestor[0]!.filename} in an ancestor directory differs from the repository licence instrument — withheld pending a rights-holder decision`,
    });
  }

  // Rule 2: The configured expectation for this source disagrees with the
  // licence acquisition actually recorded. A policy that no longer matches the
  // evidence is not a settled decision, so it is quarantined for review.
  if (evidence.expectedLicenceMatch === 'mismatch') {
    return decide({
      status: 'excluded',
      licence: spdx,
      licenceUrl,
      reason: `rights evidence conflict: acquired licence ${spdx} does not match the configured expectedLicence ${evidence.expectedLicence} — withheld pending a rights-holder decision`,
    });
  }

  // Rule 3: Header text containing Copyright notice for a different owner
  if (input.headerText && /copyright/i.test(input.headerText)) {
    const owner = input.repoOwner;
    if (owner && !input.headerText.toLowerCase().includes(owner.toLowerCase())) {
      return decide({
        status: 'excluded',
        licence: spdx,
        licenceUrl,
        reason: 'rights evidence conflict: file header contains copyright notice for different owner',
      });
    }
  }

  // Rule 4: Path under vendor/, third_party/, or mirror/
  const pathLower = input.workflowPath.toLowerCase();
  const dirMatch = pathLower.match(/(?:^|\/)(vendor|third_party|mirror)\//);
  if (dirMatch) {
    const matchedDir = dirMatch[1];
    return decide({
      status: 'excluded',
      licence: spdx,
      licenceUrl,
      reason: `rights evidence conflict: file path under ${matchedDir}/`,
    });
  }

  // Rule 5: README head stating the collection is taken from n8n.io.
  //
  // Note the limit of this rule, so nobody mistakes it for the safeguard it
  // looks like: it only catches a repository that says so in words a list
  // anticipated. The two near-complete mirrors we actually import describe
  // themselves as "all templates" and "synchronized and updated every 2
  // months" without naming a source, and neither matches anything below. What
  // catches them is `official-mirror.ts`, which compares workflows instead of
  // prose.
  if (input.readmeHead) {
    const readmeLower = input.readmeHead.toLowerCase();
    if (
      readmeLower.includes('scraped from n8n') ||
      readmeLower.includes('scraped from n8n.io') ||
      readmeLower.includes('downloaded from n8n.io') ||
      readmeLower.includes('extracted from n8n') ||
      readmeLower.includes('crawled from n8n') ||
      readmeLower.includes('copied from n8n') ||
      readmeLower.includes('mirror of n8n') ||
      readmeLower.includes('mirrored from n8n') ||
      readmeLower.includes('synced from n8n') ||
      readmeLower.includes('synchronized from n8n')
    ) {
      return decide({
        status: 'excluded',
        licence: spdx,
        licenceUrl,
        reason: 'rights evidence conflict: README states collection is scraped from n8n.io',
      });
    }
  }

  // No conflict, but no same-commit licence instrument either: the identifier
  // came from repository metadata, which cannot carry a redistribution claim.
  // The link is still published — that claim is the one being withheld.
  if (evidence.licenceBasis !== 'same-commit-file') {
    return decide({
      status: 'link_only',
      licence: spdx,
      licenceUrl,
      reason: `redistribution withheld: licence ${spdx} came from repository metadata (${evidence.licenceBasis}), not a same-commit licence file`,
    });
  }

  return decide({
    status: 'redistributable',
    licence: spdx,
    licenceUrl,
    reason: `repository licence: ${spdx}`,
  });
}
