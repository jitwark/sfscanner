import path from 'node:path';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { classifyOfficialBody, isWorkflowBody, readOfficialBody, stripAnnotations } from './admissible-body.js';
import { listOfficialBodyFiles } from './body-map.js';
import { assessTrimProof, type TrimEquivalenceEvidence, type TrimVerdict } from './trim-equivalence-proof.js';
import { readUnscannedCatalogue } from './unscanned-entries.js';

/**
 * How many published entries say their credential readiness is unknown, and
 * where the bodies that would answer them actually live on disk.
 *
 * The published disclaimer is not a lie: an entry with `readiness.analysis` of
 * `unscanned` really was never scanned. What was wrong is the *cause* the
 * corpus notes recorded — that the bodies were "created after the raw snapshot
 * or deleted upstream". The pipeline binds one body directory; bodies for
 * unscanned entries can still be sitting in a folder nothing reads. This module
 * measures that instead of asserting it.
 *
 * It also measures how many of those bodies are *usable*: a body carrying the
 * legacy `_security`/`_documentation` blocks has unestablished provenance and is
 * refused by `admissible-body.ts`, so the entry it would supply stays unscanned —
 * unless a cross-folder equivalence proof has shown that removing those blocks
 * reproduces the curated body exactly, in which case the body is admitted with
 * every removed key recorded. `trim-equivalence-proof.ts` owns that gate, and
 * `emit-body-coverage-census.ts --trim-proof` is the only way to hand it one.
 *
 * See `docs/audit/2026-09-28-body-coverage/census.json` for the committed run.
 */
export type CoverageCensus = {
  /** Entries (official + community) publishing readiness.analysis=unscanned. */
  unscannedTotal: number;
  /** Of those, `source.kind === 'n8n_official'`. */
  officialUnscanned: number;
  /** Of those, every other kind (today: `github`). */
  communityUnscanned: number;
  /**
   * One row per body directory, in the order given. `recovers` lists the
   * unscanned official ids whose body this source supplies and no earlier
   * source does, so the rows partition `recoverable` rather than overlapping.
   * `admissible` is the subset of `recovers` that passes the guard, and
   * `refusedKeys` histograms the keys that disqualified the rest.
   */
  perSource: Array<{
    dir: string;
    bodyCount: number;
    recovers: number[];
    admissible: number[];
    refusedKeys: Array<{ key: string; count: number }>;
  }>;
  /** Unscanned official ids with a body somewhere in `bodyDirs`. */
  recoverable: number[];
  /** Of `recoverable`, those whose body passes the cleanliness check. */
  recoverableAdmissible: number[];
  /** Of `recoverable`, those whose body was refused: the count the guard reports. */
  annotatedRecoverable: number[];
  /** Unscanned official ids with a body in none of them. */
  residual: number[];
  /** Of `residual`, the ids above the crawl cutoff — never crawled, not missed. */
  residualAboveCutoff: number;
  cutoff: number;
  /**
   * Why trimming is on or off for this run. Recomputed from the proof handed to
   * `buildCoverageCensus`, never taken from a flag: with no proof, or a proof
   * that found a content mismatch, every annotated body stays refused.
   */
  trimVerdict: TrimVerdict;
  /**
   * Bodies admitted only because a permitting proof allowed their annotations to
   * be removed, in the order the sources declare them. Each row names every key
   * removed, so a trimmed body is never indistinguishable from an authentic one.
   */
  trimmedBodyRows: Array<{ templateId: number; file: string; sourceDir: string; removedKeys: string[] }>;
};

export type CoverageCensusOptions = {
  /** Directories holding `catalogue-<n>.json` shards. Entries from all are pooled. */
  catalogueDirs: readonly string[];
  /** Body directories, most authoritative first. Duplicate ids are owned by the earlier source. */
  bodyDirs: readonly string[];
  /** The upstream crawl id above which the snapshot has no data at all. */
  idCutoff: number;
  /**
   * The cross-folder equivalence proof, when one has been run. This is the only
   * way trimming can be switched on: the census asks the proof for a verdict
   * scoped to `bodyDirs` and strips nothing until it gets one.
   */
  trimProof?: TrimEquivalenceEvidence;
};

/** Ascending numeric order. `Array#sort` defaults to string order, which would put 10000 before 999. */
function ascending(a: number, b: number): number {
  return a - b;
}

export function buildCoverageCensus(options: CoverageCensusOptions): CoverageCensus {
  const catalogue = readUnscannedCatalogue(options.catalogueDirs);
  const trimVerdict: TrimVerdict =
    options.trimProof === undefined
      ? { permitted: false, reason: 'no trim-equivalence proof was supplied, so every annotated body stays refused' }
      : assessTrimProof(options.trimProof, options.bodyDirs);
  const trimmedBodyRows: CoverageCensus['trimmedBodyRows'] = [];
  // One decision per template id: whichever source holds it first decides
  // whether it is usable, so a later source never rescues a refused body.
  const decided = new Set<number>();

  const perSource = options.bodyDirs.map((dir) => {
    const listing = listOfficialBodyFiles(dir);
    const recovers: number[] = [];
    const admissible: number[] = [];
    const refusedKeys = new Map<string, number>();
    for (const [templateId, file] of listing.byTemplate) {
      if (!catalogue.officialIds.has(templateId) || decided.has(templateId)) continue;
      decided.add(templateId);
      recovers.push(templateId);
      const bodyFile = path.join(dir, file);
      const parsed = readOfficialBody(bodyFile);
      const verdict = classifyOfficialBody(parsed);
      if (verdict.kind === 'authentic') {
        admissible.push(templateId);
        continue;
      }
      // Trimming is reached only through `trimVerdict`, and only for a body that
      // is a workflow object at all: a body that is not cannot have annotations.
      if (trimVerdict.permitted && isWorkflowBody(parsed)) {
        const { removedKeys } = stripAnnotations(parsed);
        admissible.push(templateId);
        trimmedBodyRows.push({ templateId, file, sourceDir: dir, removedKeys });
        continue;
      }
      for (const key of verdict.offendingKeys) refusedKeys.set(key, (refusedKeys.get(key) ?? 0) + 1);
    }
    return {
      dir,
      bodyCount: listing.matchingFiles,
      recovers: recovers.sort(ascending),
      admissible: admissible.sort(ascending),
      refusedKeys: [...refusedKeys]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => compareCanonicalStrings(a.key, b.key)),
    };
  });

  const recoverable = perSource.flatMap((source) => source.recovers).sort(ascending);
  const recoverableAdmissible = perSource.flatMap((source) => source.admissible).sort(ascending);
  const admissibleIds = new Set(recoverableAdmissible);
  const annotatedRecoverable = recoverable.filter((id) => !admissibleIds.has(id));
  const residual = [...catalogue.officialIds].filter((id) => !decided.has(id)).sort(ascending);

  return {
    unscannedTotal: catalogue.unscannedTotal,
    officialUnscanned: catalogue.officialUnscanned,
    communityUnscanned: catalogue.communityUnscanned,
    perSource,
    recoverable,
    recoverableAdmissible,
    annotatedRecoverable,
    residual,
    residualAboveCutoff: residual.filter((id) => id > options.idCutoff).length,
    cutoff: options.idCutoff,
    trimVerdict,
    trimmedBodyRows,
  };
}

/** Canonical serialized form, so the committed census and a re-run compare byte for byte. */
export function serializeCoverageCensus(census: CoverageCensus): string {
  return `${JSON.stringify({ schemaVersion: 'official-body-coverage-census-v1', ...census }, null, 2)}\n`;
}

/**
 * The arithmetic the census has to satisfy: every unscanned official entry is
 * either recoverable or residual, the per-source rows partition the recoverable
 * set, and the admissible and refused halves add up to it. A non-empty result
 * means the census must not be published.
 */
export function coverageCensusReconciles(census: CoverageCensus): string[] {
  const failures: string[] = [];
  if (census.recoverable.length + census.residual.length !== census.officialUnscanned) {
    failures.push(
      `recoverable ${census.recoverable.length} + residual ${census.residual.length} != official unscanned ${census.officialUnscanned}`,
    );
  }
  const owned = census.perSource.reduce((total, source) => total + source.recovers.length, 0);
  if (owned !== census.recoverable.length) {
    failures.push(`per-source recoveries ${owned} != recoverable ${census.recoverable.length}`);
  }
  const admissible = census.perSource.reduce((total, source) => total + source.admissible.length, 0);
  if (admissible !== census.recoverableAdmissible.length) {
    failures.push(`per-source admissible ${admissible} != recoverableAdmissible ${census.recoverableAdmissible.length}`);
  }
  if (census.recoverableAdmissible.length + census.annotatedRecoverable.length !== census.recoverable.length) {
    failures.push(
      `recoverableAdmissible ${census.recoverableAdmissible.length} + annotatedRecoverable ${census.annotatedRecoverable.length} != recoverable ${census.recoverable.length}`,
    );
  }
  if (census.residualAboveCutoff > census.residual.length) {
    failures.push(`residualAboveCutoff ${census.residualAboveCutoff} > residual ${census.residual.length}`);
  }
  if (census.unscannedTotal !== census.officialUnscanned + census.communityUnscanned) {
    failures.push(
      `unscannedTotal ${census.unscannedTotal} != official ${census.officialUnscanned} + community ${census.communityUnscanned}`,
    );
  }
  const admissibleIds = new Set(census.recoverableAdmissible);
  for (const row of census.trimmedBodyRows) {
    if (!admissibleIds.has(row.templateId)) failures.push(`trimmed row ${row.templateId} is not one of the admissible ids`);
  }
  if (!census.trimVerdict.permitted && census.trimmedBodyRows.length > 0) {
    failures.push(`${census.trimmedBodyRows.length} body row(s) were trimmed without a permitting proof`);
  }
  return failures;
}

