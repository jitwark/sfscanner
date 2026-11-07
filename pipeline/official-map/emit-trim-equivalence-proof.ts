import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  measureTrimEquivalence,
  serializeTrimEquivalenceProof,
  trimEquivalenceReconciles,
} from './trim-equivalence-proof.js';

/**
 * Runs the cross-folder trim equivalence proof and writes the report the census
 * takes its trimming verdict from.
 *
 * `npx tsx pipeline/official-map/emit-trim-equivalence-proof.ts --curated <dir> --master <dir> --out <file>`
 *
 * The exit code is the gate itself: 0 only when the proof reconciled **and** its
 * verdict permits trimming, so a build step that invokes this cannot carry on
 * past a refusal it did not read. A refused proof still writes its report — the
 * measurement is the evidence, and it is more useful than an empty run.
 */
type Args = { curated: string; master: string; out: string };

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`);
    values.set(key.slice(2), value);
    index += 1;
  }
  const curated = values.get('curated');
  const master = values.get('master');
  if (curated === undefined || master === undefined) {
    throw new Error('--curated <dir> and --master <dir> are both required: the proof is over two declared folders');
  }
  return {
    curated: path.resolve(curated),
    master: path.resolve(master),
    out: path.resolve(values.get('out') ?? path.join('pipeline', '.work', 'trim-equivalence-proof.json')),
  };
}

function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  const proof = measureTrimEquivalence({ curatedDir: args.curated, masterDir: args.master });
  writeFileSync(args.out, serializeTrimEquivalenceProof(proof));

  const failures = trimEquivalenceReconciles(proof);
  const { curatedDir, masterDir, pairsCompared, canonicalMatches, rawByteMatches, formatOnlyMatches, contentMismatchIds, verdict, verdictReason } = proof;
  const summary = {
    out: args.out,
    curatedDir,
    masterDir,
    pairsCompared,
    canonicalMatches,
    rawByteMatches,
    formatOnlyMatches,
    contentMismatches: contentMismatchIds.length,
    mismatchingTemplateIds: contentMismatchIds.slice(0, 20),
    sampleMismatches: proof.sampleMismatches,
    encoderFidelity: proof.encoderFidelity,
    verdict,
    verdictReason,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  for (const failure of failures) process.stderr.write(`reconciliation failed: ${failure}\n`);
  return failures.length > 0 || verdict !== 'trim-permitted' ? 1 : 0;
}

if (process.argv[1]?.endsWith('emit-trim-equivalence-proof.ts') || process.argv[1]?.endsWith('emit-trim-equivalence-proof.js')) {
  process.exitCode = run(process.argv.slice(2));
}
