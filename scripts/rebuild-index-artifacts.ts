/**
 * Rebuilds the whole-corpus index artifacts from an already-packaged corpus:
 * `search-index.json`, `facets.json`, `semantic-index.json`, `stats.json` and
 * `analytics.json`.
 *
 * The packager (`pipeline/package/write-index-artifacts.ts`) owns these and
 * writes them on every `npm run corpus`. This exists for the case where the
 * corpus is already packaged and only the index shape changed — it calls the
 * *same* builders, so it cannot drift from what a rebuild would produce.
 *
 * Shard and pack counts are carried over from the existing `stats.json`,
 * because this script does not re-shard the catalogue; it only rebuilds what is
 * derived from it.
 *
 * Follow it with:
 *   node scripts/restamp-manifest.mjs
 *   node scripts/sync-data.mjs
 *
 * Usage: npx tsx scripts/rebuild-index-artifacts.ts [dataDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Entry } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { buildSearchIndex } from '../pipeline/index/build-search-index.js';
import { buildFacets } from '../pipeline/index/facets.js';
import { writeIndexArtifacts } from '../pipeline/package/write-index-artifacts.js';

const dataDir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', 'data'));

const shards = fs
  .readdirSync(dataDir)
  .filter((name) => /^catalogue-\d+\.json$/.test(name))
  .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));

if (shards.length === 0) {
  console.error(`No catalogue shards found in ${dataDir}. Package the corpus first.`);
  process.exit(1);
}

const entries: Entry[] = [];
for (const shard of shards) {
  entries.push(...(JSON.parse(fs.readFileSync(path.join(dataDir, shard), 'utf8')) as Entry[]));
}
console.log(`Read ${entries.length.toLocaleString('en-US')} entries from ${shards.length} shard(s).`);

const previousStats = JSON.parse(fs.readFileSync(path.join(dataDir, 'stats.json'), 'utf8')) as {
  shardCount?: number;
  packCount?: number;
};

const searchIndexResult = buildSearchIndex(entries);
const facetsData = buildFacets(entries);
const written = writeIndexArtifacts(entries, searchIndexResult, facetsData, dataDir, {
  totalEntries: entries.length,
  redistributableCount: entries.filter((entry) => entry.rights?.status === 'redistributable').length,
  shardCount: previousStats.shardCount ?? shards.length,
  packCount: previousStats.packCount ?? 0,
});

for (const artifact of written) {
  const bytes = fs.statSync(artifact.absolutePath).size;
  console.log(`  ${artifact.relativePath.padEnd(26)} ${(bytes / 1048576).toFixed(2)} MB  entryCount=${artifact.entryCount}`);
}

// A rebuild can introduce an artifact the manifest has never seen — the
// extended index tier did exactly that. `restamp-manifest.mjs` only corrects
// entries that already exist, so without this the new file sits on disk unowned
// and `check:data-sync` fails it as an extra. Sizes and hashes are left at zero
// deliberately: restamp is the one place that computes them.
const manifestPath = path.join(dataDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
  artifacts: Array<{ path: string; byteSize: number; sha256: string; entryCount: number }>;
};
const known = new Set(manifest.artifacts.map((artifact) => artifact.path.replace(/\\/g, '/')));
const added = written
  .map((artifact) => artifact.relativePath.replace(/\\/g, '/'))
  .filter((relativePath) => !known.has(relativePath));
if (added.length > 0) {
  for (const relativePath of added) {
    manifest.artifacts.push({ path: relativePath, byteSize: 0, sha256: '', entryCount: 0 });
  }
  manifest.artifacts.sort((left, right) => compareCanonicalStrings(left.path, right.path));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\nAdded to the manifest: ${added.join(', ')}`);
}

console.log('\nNow run: node scripts/restamp-manifest.mjs && node scripts/sync-data.mjs');
