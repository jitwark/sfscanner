import { parseArgs } from 'node:util';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { EntrySecurity } from '@hub/contracts';
import { readV2RescanManifest } from './scan/v2-rescan-manifest.js';
import type { PreviousScanRun } from './corpus/scan-stage.js';

import { prepareRunContext } from './corpus/run-context.js';
import { runAcquireStage } from './corpus/acquire-stage.js';
import { runRightsStage } from './corpus/rights-stage.js';
import { runScanStage } from './corpus/scan-stage.js';
import { runDedupStage } from './corpus/dedup-stage.js';
import { writeCorpusOutputs } from './corpus/output-stage.js';
import { writeCorpusReport } from './corpus/corpus-report.js';

export type BuildCorpusOptions = {
  runId: string;
  only?: string;
  resume?: boolean; // explicit opt-in to reuse this run's existing acquire state (see acquire-resume-guard.ts)
  limit?: number;
  clean?: boolean; // also discards this run's own acquire state before starting, not just older runs' directories
  audit?: boolean;
  /**
   * Restrict the run to one class of source. The official library takes hours to
   * page politely at 2 req/s, so it is routinely acquired in its own run while
   * GitHub acquisition, which takes minutes, iterates separately.
   */
  kind?: 'github' | 'official' | 'all';
  /**
   * Record that a partial source acquisition was explicitly accepted for
   * downstream packaging.
   */
  acceptPartial?: boolean;
  previousRunId?: string;
};

/**
 * One corpus run: acquire → rights → scan/sanitize → dedup/assemble → write →
 * report. Each stage lives in `./corpus/` and owns one decision; this function
 * owns only the order they run in and the clock each is timed against.
 */
export async function buildCorpus(options: BuildCorpusOptions) {
  const {
    runId,
    only,
    resume = false,
    limit,
    clean = false,
    audit = true,
    kind = 'all',
    acceptPartial = false,
    previousRunId,
  } = options;
  if (clean && previousRunId) {
    throw new Error('Cannot combine --clean with --previous-run: cleanup discards previous cache state.');
  }
  if (previousRunId && previousRunId === runId) {
    throw new Error('previousRunId cannot be identical to current runId.');
  }
  if (previousRunId && !/^[a-zA-Z0-9_-]+$/.test(previousRunId)) {
    throw new Error(`Invalid previousRunId: ${previousRunId}`);
  }
  if (previousRunId) {
    const currentWorkDir = path.join(process.cwd(), 'pipeline', '.work', runId);
    const previousWorkDir = path.join(path.dirname(currentWorkDir), previousRunId);
    if (path.resolve(previousWorkDir) === path.resolve(currentWorkDir)) {
      throw new Error('Ambiguous or self-referential previous run path.');
    }
  }
  const startTime = Date.now();
  const context = await prepareRunContext({ runId, resume, clean });

  const acquireStart = Date.now();
  const acquired = await runAcquireStage({
    runId,
    workDir: context.workDir,
    ledgerPath: context.ledgerPath,
    ledger: context.ledger,
    only,
    limit,
    kind,
    acceptPartial,
  });
  context.stageTimes['acquire'] = Date.now() - acquireStart;

  const rightsStart = Date.now();
  await runRightsStage({
    candidates: acquired.candidates,
    sources: acquired.sources,
    repoEvidence: acquired.repoEvidence,
    ledgerPath: context.ledgerPath,
  });
  context.stageTimes['rights'] = Date.now() - rightsStart;

  // Sanitize and scan are one pass over the same body, so they report the same
  // span. The two clocks that used to bracket them started on adjacent
  // statements, which measured the same work twice.
  const scanStart = Date.now();
  let previousRun: PreviousScanRun | undefined;
  if (previousRunId) {
    const prevWorkDir = path.join(path.dirname(context.workDir), previousRunId);
    const manifestPath = path.join(prevWorkDir, 'v2-rescan-manifest.json');
    const entriesPath = path.join(prevWorkDir, 'entries.json');
    const manifest = await readV2RescanManifest(manifestPath);
    const entriesRaw = JSON.parse(await readFile(entriesPath, 'utf8')) as Array<{ id: string; security?: EntrySecurity }>;
    const manifestRecords = new Map(manifest.records.map((r) => [r.entryId, r]));
    const securitySummaries = new Map(entriesRaw.filter((e) => e.security).map((e) => [e.id, e.security!]));
    previousRun = { manifestRecords, securitySummaries, receipt: manifest.receipt };
  }
  await runScanStage({
    runId,
    workDir: context.workDir,
    candidates: acquired.candidates,
    ledgerPath: context.ledgerPath,
    previousRun,
  });
  context.stageTimes['sanitize'] = Date.now() - scanStart;
  context.stageTimes['scan'] = Date.now() - scanStart;

  const dedupStart = Date.now();
  const deduped = await runDedupStage({
    candidates: acquired.candidates,
    ledgerPath: context.ledgerPath,
  });
  context.stageTimes['dedup'] = Date.now() - dedupStart;

  const { crossCheck } = await writeCorpusOutputs({
    candidates: deduped.candidates,
    entriesWithChart: deduped.entriesWithChart,
    rejects: acquired.rejects,
    workDir: context.workDir,
    entriesPath: context.entriesPath,
    rejectsPath: context.rejectsPath,
  });

  const totalTime = Date.now() - startTime;
  const { privacyOk } = await writeCorpusReport({
    runId,
    reportPath: context.reportPath,
    entriesPath: context.entriesPath,
    candidateCount: deduped.candidates.length,
    entriesWithChart: deduped.entriesWithChart,
    rejects: acquired.rejects,
    stageTimes: context.stageTimes,
    totalTime,
    electionStats: deduped.electionStats,
    mirrorDemotion: deduped.mirrorDemotion,
    crossCheck,
    officialBodiesMissing: acquired.officialBodiesMissing,
    officialBodiesGone: acquired.officialBodiesGone,
    audit,
  });

  return {
    runId,
    candidates: deduped.candidates.length,
    canonicals: deduped.electionStats.canonicals,
    rejects: acquired.rejects.length,
    stageTimes: context.stageTimes,
    totalTime,
    reportPath: context.reportPath,
    privacyOk,
  };
}

if (process.argv[1]?.endsWith('build-corpus.ts') || process.argv[1]?.endsWith('build-corpus.js')) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      run: { type: 'string' },
      only: { type: 'string' },
      resume: { type: 'boolean', default: false }, // explicitly reuse this run's existing acquire state instead of refusing it (see acquire-resume-guard.ts)
      limit: { type: 'string' },
      clean: { type: 'boolean', default: false }, // also discards this run's own acquire state before starting, not just older runs' directories
      audit: { type: 'boolean', default: true },
      kind: { type: 'string', default: 'all' },
      'accept-partial': { type: 'boolean', default: false },
      'previous-run': { type: 'string' },
    },
  });

  if (!values.run) {
    console.error('Error: --run <runId> is required');
    process.exit(1);
  }

  const limitNum = values.limit ? Number(values.limit) : undefined;

  buildCorpus({
    runId: values.run,
    only: values.only,
    resume: values.resume,
    limit: limitNum,
    clean: values.clean,
    audit: values.audit,
    kind: values.kind as 'github' | 'official' | 'all',
    acceptPartial: values['accept-partial'],
    previousRunId: values['previous-run'],
  })
    .then((res) => {
      console.log(`\nCorpus build complete! Run: ${res.runId}`);
      console.log(`Candidates: ${res.candidates} | Canonicals: ${res.canonicals} | Rejects: ${res.rejects}`);
      console.log(`Total time: ${res.totalTime} ms`);
      console.log(`Report written to: ${res.reportPath}`);
    })
    .catch((err) => {
      console.error('\nCorpus build failed:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
