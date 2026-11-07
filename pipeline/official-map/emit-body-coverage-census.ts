import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildCoverageCensus,
  coverageCensusReconciles,
  serializeCoverageCensus,
  type CoverageCensus,
} from './body-coverage-census.js';
import type { TrimEquivalenceEvidence } from './trim-equivalence-proof.js';

/**
 * The census run: read the folders, measure, write the artifact, report.
 *
 * `npx tsx pipeline/official-map/emit-body-coverage-census.ts --data data --bodies <dir> [--bodies <dir>] --cutoff <id> --out <file> [--trim-proof <file>]`
 *
 * `--trim-proof` is the only way a trimmed body can enter the count, and it is a
 * proof read off disk: there is deliberately no `--trim` flag, because a caller
 * that could ask for trimming without a proof would make the proof decorative.
 */
type Args = { dataDirs: string[]; bodyDirs: string[]; cutoff: number; out: string; trimProofPath?: string };

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  const bodyDirs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`);
    if (key === '--bodies') bodyDirs.push(value);
    else values.set(key.slice(2), value);
    index += 1;
  }
  if (bodyDirs.length === 0) {
    throw new Error('--bodies <dir> is required at least once: the census cannot guess where the bodies live');
  }
  const cutoff = Number(values.get('cutoff'));
  if (!Number.isSafeInteger(cutoff) || cutoff < 0) {
    throw new Error('--cutoff <id> is required: the crawl cutoff is a measured fact, not a default');
  }
  const trimProofPath = values.get('trim-proof');
  return {
    dataDirs: [path.resolve(values.get('data') ?? 'data')],
    bodyDirs: bodyDirs.map((dir) => path.resolve(dir)),
    cutoff,
    out: path.resolve(values.get('out') ?? path.join('pipeline', '.work', 'official-body-coverage-census.json')),
    trimProofPath: trimProofPath === undefined ? undefined : path.resolve(trimProofPath),
  };
}

/**
 * The run's own one-screen summary. The census artifact carries the ids
 * themselves; a multi-thousand-line list on stdout would bury them.
 */
function summarize(census: CoverageCensus, out: string): Record<string, unknown> {
  return {
    out,
    unscannedTotal: census.unscannedTotal,
    officialUnscanned: census.officialUnscanned,
    communityUnscanned: census.communityUnscanned,
    recoverable: census.recoverable.length,
    recoverableAdmissible: census.recoverableAdmissible.length,
    annotatedRecoverable: census.annotatedRecoverable.length,
    residual: census.residual.length,
    residualAboveCutoff: census.residualAboveCutoff,
    trimVerdict: census.trimVerdict,
    trimmedBodyRows: census.trimmedBodyRows.length,
    perSource: census.perSource.map(({ dir, bodyCount, recovers, admissible, refusedKeys }) => ({
      dir,
      bodyCount,
      recovers: recovers.length,
      admissible: admissible.length,
      refusedKeys,
    })),
  };
}

function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  const census = buildCoverageCensus({
    catalogueDirs: args.dataDirs,
    bodyDirs: args.bodyDirs,
    idCutoff: args.cutoff,
    // Only a proof read off disk can switch trimming on; there is no `--trim` flag.
    ...(args.trimProofPath === undefined
      ? {}
      : { trimProof: JSON.parse(readFileSync(args.trimProofPath, 'utf8')) as TrimEquivalenceEvidence }),
  });
  writeFileSync(args.out, serializeCoverageCensus(census));
  process.stdout.write(`${JSON.stringify(summarize(census, args.out), null, 2)}\n`);

  const failures = coverageCensusReconciles(census);
  for (const failure of failures) process.stderr.write(`reconciliation failed: ${failure}\n`);
  return failures.length > 0 ? 1 : 0;
}

if (process.argv[1]?.endsWith('emit-body-coverage-census.ts') || process.argv[1]?.endsWith('emit-body-coverage-census.js')) {
  process.exitCode = run(process.argv.slice(2));
}
