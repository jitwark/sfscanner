import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Candidate, Reject, SourceDef, StageRecord } from '@hub/contracts';
import { parseSourcesJson } from '../sources.schema.js';
import { cloneSources } from '../acquire/clone-sources.js';
import {
  makeAcquisitionManifest,
  writeAcquisitionManifest,
  type AcquisitionFailure,
} from '../acquire/acquisition-manifest.js';
import { walkGitTree } from '../acquire/walk-git-tree.js';
import { acquireOfficial } from '../acquire/n8n-official.js';
import { readWorkflowMap } from '../acquire/official-store.js';
import { filterExcludedCandidates } from '../rights/exclusion-filter.js';
import { deriveLicenceBasis, type LicenceBasis, type LicenceEvidenceFile } from '../rights/evidence.js';
import { partitionByLicenceEvidence } from '../acquire/licence-drop.js';
import { appendStageRecord, shouldSkipStage } from '../stage-ledger.js';
import { canonicalizeJsonForHash } from '../dedup/signatures.js';
import { sha256 } from './run-context.js';

/**
 * Repository-level evidence, keyed by repo, for the rights stage. `decide.ts`
 * has rules that read a README and an owner login that were never supplied, so
 * three of its four contrary-evidence rules could not fire. `licenceFiles` is
 * every licence/notice blob at the selected commit, root and nested alike;
 * `licenceBasis` names how the identifier was established there.
 */
export type RepoEvidenceRecord = {
  readmeHead: string | null;
  owner: string | null;
  licenceFiles: LicenceEvidenceFile[];
  licenceBasis: LicenceBasis;
};

export type RepoEvidence = Map<string, RepoEvidenceRecord>;

export type AcquireStageOptions = {
  runId: string;
  workDir: string;
  ledgerPath: string;
  ledger: Map<string, StageRecord>;
  only?: string;
  limit?: number;
  /**
   * Restrict the run to one class of source. The official library takes hours to
   * page politely at 2 req/s, so it is routinely acquired in its own run while
   * GitHub acquisition, which takes minutes, iterates separately.
   */
  kind: 'github' | 'official' | 'all';
  acceptPartial: boolean;
};

export type AcquireStageResult = {
  /** Post-exclusion, post-limit: what the rights and scan stages operate on. */
  candidates: Candidate[];
  rejects: Reject[];
  /** Every configured source, not just the active ones — the rights stage reads `redistribute` off them. */
  sources: SourceDef[];
  repoEvidence: RepoEvidence;
  officialBodiesMissing: number;
  officialBodiesGone: number;
};

/**
 * STAGE 1: ACQUIRE — resolve the active sources, clone the GitHub ones and page
 * the official library, then reduce both to one candidate list.
 *
 * The exclusion choke point lives here (before `limit` and rights, see
 * exclusion-filter.ts) so an excluded id is absent from acquisition output
 * itself, and the acquire journal lines are written here too: acquisition above
 * ran unconditionally, so the ledger is bookkeeping that avoids a duplicate
 * journal line on a repeat run rather than a resume shortcut.
 */
export async function runAcquireStage(options: AcquireStageOptions): Promise<AcquireStageResult> {
  const { runId, workDir, ledgerPath, ledger, only, limit, kind, acceptPartial } = options;

  const sourcesText = await readFile(join(process.cwd(), 'pipeline', 'sources.json'), 'utf8');
  const allSources = parseSourcesJson(sourcesText);
  let activeSources = allSources.filter((s) => s.status === 'active');
  if (only) {
    activeSources = activeSources.filter((s) => s.key === only);
    if (activeSources.length === 0) {
      throw new Error(`Source key "${only}" not found or not active in sources.json`);
    }
  }
  if (kind !== 'all') {
    const wanted = kind === 'github' ? 'github' : 'n8n_official';
    activeSources = activeSources.filter((s) => s.kind === wanted);
  }
  const activeSourceKeys = activeSources.map((source) => source.key);

  let rawCandidates: Candidate[] = [];
  const allRejects: Reject[] = [];

  const githubSources = activeSources.filter((s) => s.kind === 'github');
  const officialSource = activeSources.find((s) => s.kind === 'n8n_official');
  const acquiredSourceKeys: string[] = [];
  const acquisitionFailures: AcquisitionFailure[] = [];
  let officialBodiesMissing = 0;
  let officialBodiesGone = 0;
  const repoEvidence: RepoEvidence = new Map();

  if (githubSources.length > 0) {
    const acquisition = await cloneSources(githubSources, { runId, only });
    acquiredSourceKeys.push(...acquisition.repos.map((repo) => repo.source.key));
    acquisitionFailures.push(...acquisition.failures);
    for (const acquired of acquisition.repos) {
      const licenceFiles = acquired.metadata.licenceEvidence?.files ?? [];
      const licenceBasis = deriveLicenceBasis({ apiLicencePresent: acquired.metadata.license !== null, licenceFiles });
      repoEvidence.set(acquired.source.repo ?? acquired.source.key, {
        readmeHead: acquired.metadata.licenceEvidence?.readmeSnippet ?? null,
        owner: acquired.metadata.owner?.login ?? null,
        licenceFiles,
        licenceBasis,
      });
      const cloneDir = join(workDir, 'clones', acquired.source.key);
      const walkRes = await walkGitTree(cloneDir, {
        sourceKey: acquired.source.key,
        repo: acquired.source.repo ?? '',
        ownerLogin: acquired.metadata.owner.login,
        stars: acquired.metadata.stargazers_count,
        spdxId: acquired.metadata.license?.spdx_id ?? null,
        licenceUrl: acquired.metadata.license?.url ?? null,
        commitSha: acquired.commit,
        committedAt: acquired.committedAt,
        include: acquired.source.include,
        exclude: acquired.source.exclude,
      });
      const walk = partitionByLicenceEvidence(walkRes.candidates, licenceBasis, acquired.source.key);
      rawCandidates.push(...walk.included);
      allRejects.push(...walk.dropped, ...walkRes.rejects);
    }
  }

  if (officialSource) {
    try {
      const officialRes = await acquireOfficial({
        runId,
        limit,
        workDir,
      });
      acquiredSourceKeys.push(officialSource.key);
      // The workflow bodies are retained for analysis — dedup hashes, the
      // security scan, readiness, hostnames. Rights stay `link_only`, so the
      // sanitize and packaging stages still never publish one. Passing
      // `json: null` here is what produced run rederive-62's result: 11,490
      // templates, 1 canonical entry, every one of them ungraded.
      const officialBodies = await readWorkflowMap(officialRes.workflowsPath);
      let officialWithoutBody = 0;

      // Official acquisition yields `EntryWithChart`; the corpus pipeline works in
      // `Candidate`s, so unwrap the entry and keep the chart travelling with it.
      for (const { entry: officialEntry, chart } of officialRes.entries) {
        const body = officialBodies.get(officialEntry.source.templateId ?? -1) ?? null;
        if (!body) {
          // The template is listed in search but its detail is gone (n8n.io
          // returns 404 for the public page too), so publishing it would be a
          // metadata-only entry behind a dead permalink. Dropped, not defaulted.
          officialWithoutBody += 1;
          allRejects.push({
            sourceKey: officialSource.key,
            path: officialEntry.source.permalink,
            reason: 'fetch_failed',
            detail: 'official template detail unavailable; no workflow body retained',
          });
          continue;
        }
        const candidate: Candidate = {
          id: officialEntry.id,
          source: officialEntry.source,
          rights: officialEntry.rights,
          title: officialEntry.title,
          upstreamDescription: officialEntry.description,
          json: body,
          bytes: body ? Buffer.byteLength(JSON.stringify(body), 'utf8') : 0,
        };
        (candidate as unknown as Record<string, unknown>).structure = officialEntry.structure;
        (candidate as unknown as Record<string, unknown>).security = officialEntry.security;
        (candidate as unknown as Record<string, unknown>).chart = chart;
        rawCandidates.push(candidate);
      }

      officialBodiesMissing = officialWithoutBody;
      officialBodiesGone = officialRes.bodiesGone;
      // A template deleted upstream is upstream's business. A template we
      // failed to fetch is ours, and a run full of those produces a corpus that
      // looks complete and is not — so only the second kind aborts the build.
      const ourFailures = Math.max(0, officialWithoutBody - officialRes.bodiesGone);
      const failureShare = officialRes.entries.length > 0 ? ourFailures / officialRes.entries.length : 0;
      if (failureShare > 0.01) {
        throw new Error(
          `official acquisition failed to fetch ${ourFailures} of ${officialRes.entries.length} workflow bodies for reasons other than a 404 (${(failureShare * 100).toFixed(1)}%, limit 1%)`,
        );
      }
    } catch (error) {
      acquisitionFailures.push({
        key: officialSource.key,
        error: error instanceof Error ? error.message : String(error),
      });
      await writeAcquisitionManifest(
        workDir,
        makeAcquisitionManifest(
          runId,
          activeSourceKeys,
          acquiredSourceKeys,
          acquisitionFailures,
          acceptPartial,
          activeSourceKeys,
        ),
      );
      throw error;
    }
  }

  await writeAcquisitionManifest(
    workDir,
    makeAcquisitionManifest(
      runId,
      activeSourceKeys,
      acquiredSourceKeys,
      acquisitionFailures,
      acceptPartial,
      activeSourceKeys,
    ),
  );

  // Single exclusion choke point (see exclusion-filter.ts): before `limit` and rights, so an excluded id is absent from acquisition output itself.
  rawCandidates = filterExcludedCandidates(rawCandidates).included;

  if (typeof limit === 'number' && limit > 0) {
    rawCandidates = rawCandidates.slice(0, limit);
  }

  // Bookkeeping only: acquisition above already ran unconditionally, so this just avoids a duplicate journal line on a repeat run.
  for (const c of rawCandidates) {
    const hash = sha256(c.id + ':acquire'); const outputHash = sha256(canonicalizeJsonForHash(c));
    if (!shouldSkipStage(ledger, c.id, 'acquire', hash, outputHash)) {
      await appendStageRecord(ledgerPath, { entryId: c.id, stage: 'acquire', ok: true, inputHash: hash, outputHash });
    }
  }

  return {
    candidates: rawCandidates,
    rejects: allRejects,
    sources: allSources,
    repoEvidence,
    officialBodiesMissing,
    officialBodiesGone,
  };
}
