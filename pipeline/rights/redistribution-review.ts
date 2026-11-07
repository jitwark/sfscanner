import { decideRights } from './decide.js';
import type { EntryRights, EntrySource, SourceDef } from '@hub/contracts';

/**
 * The item-level redistribution review: one row per redistributable item in the
 * frozen release, naming the source evidence the decision rests on and the
 * disposition that evidence supports.
 *
 * It is technical evidence, not a legal opinion, and it says what it does not
 * know. The frozen catalogue projection records no licence-instrument hash for
 * any entry, so `licenceBasis` here can only ever be `metadata-only` (an
 * identifier was recorded) or `none` (it was not) — never `same-commit-file`.
 * That is the finding, not a bug in this script: a redistribution claim in the
 * shipped corpus rests on repository metadata, and requirement 5 of task 6.7
 * says a metadata-only SPDX response is not same-commit proof.
 *
 * Every field is read from the frozen artifacts or computed by `decideRights`
 * itself, so the dispositions here are the ones a rebuilt corpus would produce
 * from the same recorded evidence rather than a second opinion about it.
 */

export type ReviewEntry = {
  id: string;
  rights: Pick<EntryRights, 'status' | 'licence' | 'licenceUrl' | 'reason'>;
  source: Pick<EntrySource, 'kind' | 'repo' | 'owner' | 'path' | 'commit' | 'permalink'>;
  download?: { pack: number; line: number; offset: number; length: number; sha256: string } | undefined;
};

export type RedistributionReviewItem = {
  id: string;
  /** The record the shipped corpus publishes today. */
  recordedStatus: EntryRights['status'];
  recordedReason: string;
  /** What the evidence in the frozen artifacts supports. */
  disposition: EntryRights['status'];
  dispositionReason: string;
  source: {
    kind: EntrySource['kind'];
    repo: string | null;
    commit: string | null;
    path: string | null;
    permalink: string;
    owner: string | null;
    registryStatus: 'active' | 'excluded' | 'unregistered';
    redistributionWithdrawn: boolean;
  };
  body: { pack: number; line: number; sha256: string; reDerivedFromPack: boolean } | null;
  evidence: {
    sourceCommit: string | null;
    workflowPath: string;
    bodyHash: string | null;
    rootLicence: string[];
    nestedLicence: string[];
    siblingLicence: string[];
    licenceBasis: string;
    expectedLicence: string | null;
    expectedLicenceMatch: string;
  };
  evidenceGaps: string[];
  openQuestions: string[];
};

export type RedistributionReview = {
  schemaVersion: 'redistribution-review-v1';
  /** SHA-256 of every input artifact this review was derived from. */
  inputs: Array<{ path: string; sha256: string }>;
  summary: {
    total: number;
    byDisposition: Record<string, number>;
    byRecordedStatus: Record<string, number>;
    byRepo: Record<string, number>;
    distributionSupportedByRecordedEvidence: number;
    itemsWithReverifiedBody: number;
  };
  openQuestions: string[];
  items: RedistributionReviewItem[];
};

const NO_LICENCE_INSTRUMENT_RECORDED =
  'no licence-instrument hash is recorded in the frozen release artifacts, so the licence identifier can only be attributed to repository metadata';
const NO_README_RECORDED =
  'no README text is recorded in the frozen release artifacts, so the contrary-evidence README rule could not be evaluated';

/**
 * The two facts this review cannot get from the frozen projection: the licence
 * or notice bytes at the selected commit, and the repository README. They are
 * named per item rather than left implicit, because "we found no conflict" and
 * "we could not look" are different results.
 */
const EVIDENCE_GAPS: readonly string[] = [NO_LICENCE_INSTRUMENT_RECORDED, NO_README_RECORDED];

export function buildRedistributionReview(input: {
  entries: readonly ReviewEntry[];
  sources: readonly SourceDef[];
  inputs?: Array<{ path: string; sha256: string }>;
  verifyPackedBody?: (entry: ReviewEntry) => boolean;
}): RedistributionReview {
  const { entries, sources, inputs = [], verifyPackedBody } = input;

  const items = [...entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry): RedistributionReviewItem => {
      const source = sources.find((candidate) => candidate.repo === entry.source.repo);
      const workflowPath = entry.source.path ?? '';
      const recordedLicence = entry.rights.licence;
      const decision = decideRights({
        spdxId: recordedLicence,
        licenceUrl: entry.rights.licenceUrl,
        workflowPath,
        sourceKind: entry.source.kind,
        repoOwner: entry.source.owner ?? null,
        sourceRedistribute: source?.redistribute,
        expectedLicence: source?.expectedLicence ?? null,
        evidence: {
          sourceCommit: entry.source.commit ?? null,
          bodyHash: entry.download?.sha256 ?? null,
          // No licence-instrument hash is recorded in the frozen projection, so
          // the identifier cannot be attributed to a same-commit file.
          licenceBasis: recordedLicence ? 'metadata-only' : 'none',
        },
      });

      const openQuestions: string[] = [];
      if (entry.rights.status === 'redistributable' && decision.rights.status !== 'redistributable') {
        openQuestions.push(
          `shipped as redistributable but the recorded evidence supports ${decision.rights.status}`,
        );
      }
      if (source?.status === 'excluded') {
        openQuestions.push(
          'the source is excluded in the active registry, so this row predates that decision and must not be reacquired',
        );
      }
      if (source?.redistribute === false) {
        openQuestions.push('the source records a redistribution withdrawal');
      }
      if (source === undefined) {
        openQuestions.push('the source repo is not in the active registry');
      }

      return {
        id: entry.id,
        recordedStatus: entry.rights.status,
        recordedReason: entry.rights.reason,
        disposition: decision.rights.status,
        dispositionReason: decision.rights.reason,
        source: {
          kind: entry.source.kind,
          repo: entry.source.repo ?? null,
          commit: entry.source.commit ?? null,
          path: entry.source.path ?? null,
          permalink: entry.source.permalink,
          owner: entry.source.owner ?? null,
          registryStatus: source ? source.status : 'unregistered',
          redistributionWithdrawn: source?.redistribute === false,
        },
        body: entry.download
          ? {
              pack: entry.download.pack,
              line: entry.download.line,
              sha256: entry.download.sha256,
              reDerivedFromPack: verifyPackedBody ? verifyPackedBody(entry) : false,
            }
          : null,
        evidence: {
          sourceCommit: decision.evidence.sourceCommit,
          workflowPath: decision.evidence.workflowPath,
          bodyHash: decision.evidence.bodyHash,
          rootLicence: decision.evidence.rootLicence.map((file) => file.filename),
          nestedLicence: decision.evidence.nestedLicence.map((file) => file.filename),
          siblingLicence: decision.evidence.siblingLicence.map((file) => file.filename),
          licenceBasis: decision.evidence.licenceBasis,
          expectedLicence: decision.evidence.expectedLicence,
          expectedLicenceMatch: decision.evidence.expectedLicenceMatch,
        },
        evidenceGaps: [...EVIDENCE_GAPS],
        openQuestions,
      };
    });

  const byDisposition: Record<string, number> = {};
  const byRecordedStatus: Record<string, number> = {};
  const byRepo: Record<string, number> = {};
  for (const item of items) {
    byDisposition[item.disposition] = (byDisposition[item.disposition] ?? 0) + 1;
    byRecordedStatus[item.recordedStatus] = (byRecordedStatus[item.recordedStatus] ?? 0) + 1;
    const repo = item.source.repo ?? item.source.kind;
    byRepo[repo] = (byRepo[repo] ?? 0) + 1;
  }
  if (Object.values(byDisposition).reduce((sum, count) => sum + count, 0) !== items.length) {
    throw new Error('Redistribution review: dispositions do not reconcile with the item count.');
  }

  const openQuestions = [
    'the frozen release artifacts record no same-commit licence-instrument hash for any item, so no item can be re-justified as redistributable from them alone; a rights-holder decision or a re-acquisition with recorded licence evidence is required',
    'the frozen release artifacts record no README head, so the contrary-evidence README rule could not be evaluated for any item',
  ];

  return {
    schemaVersion: 'redistribution-review-v1',
    inputs,
    summary: {
      total: items.length,
      byDisposition,
      byRecordedStatus,
      byRepo,
      distributionSupportedByRecordedEvidence: byDisposition['redistributable'] ?? 0,
      itemsWithReverifiedBody: items.filter((item) => item.body?.reDerivedFromPack).length,
    },
    openQuestions,
    items,
  };
}
