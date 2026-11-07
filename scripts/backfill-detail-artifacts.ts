/**
 * One-off backfill: generates `details/detail-{s}.jsonl` and
 * `details/detail-index-{s}.json` (P1.7's byte-addressed sibling of
 * `catalogue-{s}.json`) for an already-packaged corpus, without re-running
 * enrichment or scanning.
 *
 * Reads the existing catalogue shards in numeric order (their concatenation is
 * exactly the array `writeArtifacts` sharded originally) and re-derives the
 * detail artifacts from `write-artifacts.ts`'s own `writeDetailArtifacts` and
 * `SHARD_SIZE`, so this cannot drift from what a full repackage would produce.
 *
 * New artifact paths are appended to the manifest as placeholders, matching
 * `rebuild-index-artifacts.ts`'s convention. Follow with:
 *   node scripts/restamp-manifest.mjs
 *   node scripts/sync-data.mjs
 *
 * Usage: npx tsx scripts/backfill-detail-artifacts.ts [dataDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Entry } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { SHARD_SIZE } from '../pipeline/package/write-artifacts.js';
import { writeDetailArtifacts } from '../pipeline/package/write-detail-artifacts.js';

const dataDir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', 'data'));

const shardFiles = fs
  .readdirSync(dataDir)
  .filter((name) => /^catalogue-\d+\.json$/.test(name))
  .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));

if (shardFiles.length === 0) {
  console.error(`No catalogue shards found in ${dataDir}. Package the corpus first.`);
  process.exit(1);
}

const entries: Entry[] = [];
for (const shardFile of shardFiles) {
  entries.push(...(JSON.parse(fs.readFileSync(path.join(dataDir, shardFile), 'utf8')) as Entry[]));
}
console.log(`Read ${entries.length.toLocaleString('en-US')} entries from ${shardFiles.length} shard(s).`);

const written = writeDetailArtifacts(entries, dataDir, SHARD_SIZE);
for (const artifact of written) {
  const bytes = fs.statSync(artifact.absolutePath).size;
  console.log(`  ${artifact.relativePath.padEnd(32)} ${(bytes / 1048576).toFixed(2)} MB  entryCount=${artifact.entryCount}`);
}

const manifestPath = path.join(dataDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
  artifacts: Array<{ path: string; byteSize: number; sha256: string; entryCount: number; encoding?: string }>;
};
const known = new Set(manifest.artifacts.map((artifact) => artifact.path.replace(/\\/g, '/')));
const added = written
  .map((artifact) => ({ path: artifact.relativePath.replace(/\\/g, '/'), encoding: artifact.encoding }))
  .filter(({ path: relativePath }) => !known.has(relativePath));

if (added.length === 0) {
  console.log('\nAll detail artifact paths are already present in the manifest.');
  process.exit(0);
}

for (const { path: relativePath, encoding } of added) {
  manifest.artifacts.push({ path: relativePath, byteSize: 0, sha256: '', entryCount: 0, ...(encoding ? { encoding } : {}) });
}
manifest.artifacts.sort((left, right) => compareCanonicalStrings(left.path, right.path));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log(`\nAdded to the manifest: ${added.map((a) => a.path).join(', ')}`);
console.log('\nNow run: node scripts/restamp-manifest.mjs && node scripts/sync-data.mjs');
