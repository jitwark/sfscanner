import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildRedistributionReview, type ReviewEntry } from './redistribution-review.js';
import type { SourceDef } from '@hub/contracts';

/**
 * The file-reading half of the redistribution review: reads the frozen release
 * artifacts, re-verifies every packed body against its recorded digest, and
 * writes the review artifact.
 *
 * It writes only `--out`, which is the review itself. Nothing here writes into
 * `data/`: the review describes the frozen corpus, it does not touch it.
 *
 * Usage: npx tsx pipeline/rights/redistribution-review-cli.ts --out <file> [dataDir]
 */

/**
 * Re-derives a pack line's SHA-256 from the pack bytes and compares it with the
 * digest the entry claims. A mismatch is a real defect — a pointer that does not
 * resolve to the bytes it names — and it must not read as "verified".
 *
 * The pointer is in *bytes*, and its `length` covers the line's terminating
 * newline while the recorded digest covers the line's payload without it. Both
 * facts are checked rather than assumed: a span that does not end at a newline
 * or at end-of-file is not a line, so it is reported unverified instead of
 * hashing whatever bytes happened to be there.
 */
export function verifyPackedBodyLine(dataDir: string, entry: ReviewEntry): boolean {
  if (!entry.download) return false;
  const { pack, offset, length, sha256 } = entry.download;
  try {
    const file = readFileSync(path.join(dataDir, 'packs', `pack-${pack}.jsonl`));
    const end = offset + length;
    if (offset < 0 || end > file.length) return false;
    const terminator = file[end - 1];
    if (file.length !== end && terminator !== 0x0a) return false;
    const payloadEnd = terminator === 0x0a ? end - 1 : end;
    return createHash('sha256').update(file.subarray(offset, payloadEnd)).digest('hex') === sha256;
  } catch {
    return false;
  }
}

function readCatalogueEntries(dataDir: string): ReviewEntry[] {
  const entries: ReviewEntry[] = [];
  for (let shard = 0; ; shard += 1) {
    const shardPath = path.join(dataDir, `catalogue-${shard}.json`);
    if (!existsSync(shardPath)) break;
    const shardEntries = JSON.parse(readFileSync(shardPath, 'utf8')) as ReviewEntry[];
    for (const entry of shardEntries) {
      if (entry.rights.status === 'redistributable') entries.push(entry);
    }
  }
  return entries;
}

function readInputs(dataDir: string): Array<{ path: string; sha256: string }> {
  const manifestPath = path.join(dataDir, 'manifest.json');
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    artifacts?: Array<{ path: string; sha256: string }>;
  };
  return (manifest.artifacts ?? [])
    .filter((artifact) => artifact.path.startsWith('catalogue-') || artifact.path.startsWith('packs/'))
    .map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 }));
}

/** Reads the frozen release artifacts and writes the review to `--out`. */
function main(): void {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (!out) throw new Error('Usage: redistribution-review-cli.ts --out <file> [dataDir]');
  const positional = args.filter((arg, index) => !arg.startsWith('--') && index !== outIndex + 1);
  const dataDir = path.resolve(positional[0] ?? 'data');

  const entries = readCatalogueEntries(dataDir);
  const sources = JSON.parse(readFileSync(path.join('pipeline', 'sources.json'), 'utf8')) as SourceDef[];
  const review = buildRedistributionReview({
    entries,
    sources,
    inputs: readInputs(dataDir),
    verifyPackedBody: (entry) => verifyPackedBodyLine(dataDir, entry),
  });

  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(review, null, 2)}\n`, 'utf8');
  console.log(
    `Redistribution review: ${review.summary.total} redistributable item(s) — ` +
      `supported by recorded evidence: ${review.summary.distributionSupportedByRecordedEvidence}; ` +
      `bodies re-verified: ${review.summary.itemsWithReverifiedBody}.`,
  );
  console.log(JSON.stringify(review.summary.byDisposition));
}

if (process.argv[1]?.endsWith('redistribution-review-cli.ts') || process.argv[1]?.endsWith('redistribution-review-cli.js')) {
  main();
}
