/**
 * Prunes `catalogue-{s}.json` from the *shipped* export only (P6.3, depends on
 * `scanner-contract-and-calibration` P1.7).
 *
 * Nothing browser-side reads a whole catalogue shard any more (P1.7 replaced
 * that with the byte-addressed `details/detail-{s}.jsonl` + `detail-index-
 * {s}.json` pair), but the file is still real build-time input:
 * `prerender-list.ts` reads it from `app/public/data/` during `next build`'s
 * static generation, and `generate-sitemaps.mjs` reads it from `app/out/data/`
 * for page lastmod dates. So this must run strictly after both — and does not
 * touch `data/` or `app/public/data/`, only the final `app/out/` copy that
 * would otherwise ship ~180 MB nobody fetches.
 *
 * Failing loudly if nothing is found is deliberate: a silent no-op here would
 * look identical to "already pruned" and let the file quietly come back (a new
 * shard naming scheme, a moved output dir) without anyone noticing — the same
 * failure shape as the build history's "the link-graph test never ran".
 *
 * Usage: node scripts/prune-export-catalogue-shards.mjs [outDir]
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'app', 'out'));
const dataDir = path.join(outDir, 'data');

if (!fs.existsSync(dataDir)) {
  console.error(`Export data directory does not exist: ${dataDir}. Run the build first.`);
  process.exit(1);
}

const shardFiles = fs.readdirSync(dataDir).filter((name) => /^catalogue-\d+\.json$/.test(name));

if (shardFiles.length === 0) {
  console.error(
    `No catalogue-N.json files found in ${dataDir} to prune.\n` +
      'Either this already ran, or the shard naming/output location has changed — ' +
      'find out which before assuming this is a no-op.',
  );
  process.exit(1);
}

let freedBytes = 0;
for (const name of shardFiles) {
  const absolute = path.join(dataDir, name);
  freedBytes += fs.statSync(absolute).size;
  fs.unlinkSync(absolute);
}

const manifestPath = path.join(dataDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.artifacts = manifest.artifacts.filter((artifact) => !/^catalogue-\d+\.json$/.test(artifact.path));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(
  `Pruned ${shardFiles.length} catalogue shard(s) from the shipped export ` +
    `(${(freedBytes / 1048576).toFixed(1)} MB freed): ${shardFiles.join(', ')}`,
);
console.log('data/ and app/public/data/ are untouched — this only trims the final export.');
