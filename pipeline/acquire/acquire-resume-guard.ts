import { access, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * On-disk state that `acquireOfficial` and `cloneSources` read and continue
 * from **unconditionally** — neither takes a `resume` parameter. Both were
 * built to survive a kill mid-acquisition: the official-library pager writes
 * a cursor plus its accumulated entries/bodies after every page, and a clone
 * directory that already has a `.git` gets a shallow `fetch` instead of a
 * fresh `clone`. That is real, working resume behaviour, but it is keyed only
 * on `--run <runId>` — reusing a runId always continues whatever is on disk,
 * whether or not the caller meant to.
 */
const ACQUIRE_STATE_FILES = ['official-cursor.json', 'official-entries.json', 'official-workflows.jsonl'];

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function hasClones(workDir: string): Promise<boolean> {
  try {
    const entries = await readdir(join(workDir, 'clones'));
    return entries.length > 0;
  } catch {
    return false;
  }
}

/** List the acquire-stage artifacts present under `workDir`, if any. */
export async function findAcquireState(workDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of ACQUIRE_STATE_FILES) {
    if (await pathExists(join(workDir, name))) found.push(name);
  }
  if (await hasClones(workDir)) found.push('clones/');
  return found;
}

/**
 * Refuse to silently continue a prior invocation's acquire state.
 *
 * `resume: true` is the caller's explicit opt-in to reuse it. Anything else
 * that finds existing state on disk is a run reusing a `runId` by accident —
 * without this guard it would silently mix a prior (possibly partial, possibly
 * unrelated) acquisition into what looks like a fresh build.
 */
export async function assertAcquireStateReusable(
  workDir: string,
  runId: string,
  resume: boolean,
): Promise<void> {
  if (resume) return;
  const found = await findAcquireState(workDir);
  if (found.length === 0) return;
  throw new Error(
    `pipeline/.work/${runId} already has acquire state from a previous run (${found.join(', ')}). ` +
      'Pass --resume to continue it, --clean to discard it, or pick a new --run id.',
  );
}

/** Discard this run's own acquire state: the official cursor/entries/body store and cloned repos. */
export async function resetAcquireState(workDir: string): Promise<void> {
  for (const name of ACQUIRE_STATE_FILES) {
    await rm(join(workDir, name), { force: true });
  }
  await rm(join(workDir, 'clones'), { recursive: true, force: true });
}

/**
 * Single entry point `build-corpus.ts` calls before acquisition starts.
 * `--clean` wins outright: it discards this run's acquire state and proceeds.
 * Otherwise, existing state must be explicitly accepted via `--resume`.
 */
export async function guardAcquireState(
  workDir: string,
  runId: string,
  options: { resume: boolean; clean: boolean },
): Promise<void> {
  if (options.clean) {
    await resetAcquireState(workDir);
    return;
  }
  await assertAcquireStateReusable(workDir, runId, options.resume);
}
