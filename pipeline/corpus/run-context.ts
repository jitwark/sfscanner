import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { StageRecord } from '@hub/contracts';
import { loadLedger } from '../stage-ledger.js';
import { guardAcquireState } from '../acquire/acquire-resume-guard.js';
import { cleanOldRuns } from '../acquire/clean-old-runs.js';

/**
 * Everything one corpus run is: its identity, the files it reads and writes, the
 * stage ledger it journals into, and the per-stage timings its report prints.
 *
 * It is threaded through every stage rather than recomputed, because a stage
 * that rebuilt its own paths from `process.cwd()` would silently disagree with
 * the run it belongs to the moment the two are not the same string.
 */
export type CorpusRunContext = {
  runId: string;
  workDir: string;
  ledgerPath: string;
  entriesPath: string;
  rejectsPath: string;
  reportPath: string;
  /** Empty unless `--resume`; a fresh run must not read another run's journal. */
  ledger: Map<string, StageRecord>;
  stageTimes: Record<string, number>;
};

export type CorpusRunSetup = {
  runId: string;
  resume: boolean;
  clean: boolean;
};

/** The digest every stage journals and compares, so one helper means one format. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function prepareRunContext({ runId, resume, clean }: CorpusRunSetup): Promise<CorpusRunContext> {
  const pipelineDir = join(process.cwd(), 'pipeline');
  const workDir = join(pipelineDir, '.work', runId);
  const ledgerPath = join(workDir, 'stages.jsonl');

  await Promise.all([
    mkdir(workDir, { recursive: true }),
    mkdir(join(pipelineDir, 'reports'), { recursive: true }),
  ]);

  if (clean) {
    await cleanOldRuns(join(pipelineDir, '.work'), 2, runId);
  }
  await guardAcquireState(workDir, runId, { resume, clean });

  return {
    runId,
    workDir,
    ledgerPath,
    entriesPath: join(workDir, 'entries.json'),
    rejectsPath: join(workDir, 'rejects.jsonl'),
    reportPath: join(pipelineDir, 'reports', `corpus-${runId}.md`),
    ledger: resume ? await loadLedger(ledgerPath) : new Map(),
    stageTimes: {},
  };
}
