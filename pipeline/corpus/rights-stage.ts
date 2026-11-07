import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Candidate, SourceDef } from '@hub/contracts';
import { decideRights } from '../rights/decide.js';
import { splitLicenceFiles, type RightsEvidenceInput } from '../rights/evidence.js';
import { appendStageRecord } from '../stage-ledger.js';
import { canonicalizeJsonForHash } from '../dedup/signatures.js';
import { sha256 } from './run-context.js';
import type { RepoEvidence } from './acquire-stage.js';

export type RightsStageOptions = {
  /** Mutated in place: every later stage reads `rights` off the same candidate. */
  candidates: Candidate[];
  /** The full configured source list, consulted for a source-level `redistribute: false`. */
  sources: SourceDef[];
  repoEvidence: RepoEvidence;
  ledgerPath: string;
};

/**
 * The evidence ledger, kept beside the stage ledger so it stays inside the run's
 * work directory — outside every published output, which is where a quarantine
 * record belongs.
 *
 * Derived from `ledgerPath`'s directory rather than rebuilt from `process.cwd()`
 * for the same reason `run-context.ts` threads its paths: a stage that
 * recomputed its own location would silently disagree with the run it belongs
 * to the moment the two are not the same string. `ledgerPath` is already the
 * run's own `<workDir>/stages.jsonl`.
 */
export function rightsEvidenceLedgerPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), 'rights-evidence.jsonl');
}

/**
 * STAGE 2: RIGHTS — one call per GitHub candidate, and every answer comes from
 * evidence.
 *
 * What each decision is given is what acquisition actually recorded for that
 * workflow: the selected commit and body hash off the candidate, and the
 * repository's licence blobs split into the root, the workflow's own directory
 * and everywhere else below the root, so a subtree licence file is evidence the
 * decision can see rather than a fact that stays in the clone. An official
 * template is skipped because its rights were decided at acquisition (link-only,
 * by definition of what it is).
 *
 * A decision that comes back `excluded` is a quarantine: the candidate is
 * removed from the list every later stage reads, so it reaches no catalogue,
 * pack, search index or export, and the decision with its evidence is appended
 * to the evidence ledger. It is neither a silent drop nor a published link.
 */
export async function runRightsStage(options: RightsStageOptions): Promise<void> {
  const { candidates, sources, repoEvidence, ledgerPath } = options;
  const evidencePath = rightsEvidenceLedgerPath(ledgerPath);

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const c = candidates[index]!;
    if (c.source.kind === 'n8n_official') continue;
    const workflowPath = c.source.path ?? '';
    const recorded = repoEvidence.get(c.source.repo ?? '');
    const evidence: RightsEvidenceInput = {
      sourceCommit: c.source.commit ?? null,
      bodyHash: c.blobSha ?? null,
      ...splitLicenceFiles(workflowPath, recorded?.licenceFiles ?? []),
      licenceBasis: recorded?.licenceBasis ?? 'none',
    };
    const inputHash = sha256(c.id + ':' + (c.rights?.licence || ''));

    const decision = decideRights({
      spdxId: c.rights?.licence ?? null,
      licenceUrl: c.rights?.licenceUrl ?? null,
      workflowPath,
      sourceKind: c.source.kind,
      readmeHead: recorded?.readmeHead ?? null,
      repoOwner: recorded?.owner ?? null,
      sourceRedistribute: sources.find((s) => s.repo === c.source.repo)?.redistribute,
      expectedLicence: sources.find((s) => s.repo === c.source.repo)?.expectedLicence ?? null,
      evidence,
    });

    const quarantined = decision.rights.status === 'excluded';
    if (quarantined) {
      // Quarantine: out of the candidate list before anything downstream can
      // publish it. `excluded` is also the status the release projection
      // filters, so the two gates agree rather than one trusting the other.
      candidates.splice(index, 1);
    } else {
      // Project the four published fields explicitly. `decision` carries the
      // evidence too, and it must not reach the catalogue as part of the entry.
      c.rights = {
        status: decision.rights.status,
        licence: decision.rights.licence,
        licenceUrl: decision.rights.licenceUrl,
        reason: decision.rights.reason,
      };
    }

    await mkdir(dirname(evidencePath), { recursive: true });
    await appendFile(
      evidencePath,
      JSON.stringify({
        id: c.id,
        status: decision.rights.status,
        disposition: quarantined ? 'quarantine' : decision.rights.status === 'redistributable' ? 'publish' : 'link_only',
        reason: decision.rights.reason,
        evidence: decision.evidence,
      }) + '\n',
      'utf8',
    );

    await appendStageRecord(ledgerPath, {
      entryId: c.id,
      stage: 'rights',
      ok: true,
      inputHash,
      outputHash: sha256(canonicalizeJsonForHash(decision.rights)),
    });
  }
}
