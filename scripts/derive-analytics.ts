/**
 * Re-derives `data/analytics.json` from an already-packaged corpus.
 *
 * The packager (`pipeline/package/write-index-artifacts.ts`) is the real owner of
 * this artifact and writes it on every `npm run corpus`. This script exists for
 * the case where the corpus is already packaged and only the analytics need to
 * catch up.
 *
 * It calls the same `deriveCorpusAnalytics` as the packager *and* the same
 * `totalSearchableDocuments`. Sharing only the first was not enough: this script
 * used to read `search-index.json`'s `documentCount` alone, so once the index
 * was tiered it would have rewritten the artifact with the primary tier's 2,000
 * in place of 12,923 — reinstating a regression that had already been fixed
 * once. Calling the same function is not the same as being given the same
 * input, and only the input was wrong.
 *
 * Follow it with:
 *   node scripts/restamp-manifest.mjs      (size/sha256/entryCount)
 *   node scripts/sync-data.mjs             (copy to app/public/data)
 *
 * Usage: npx tsx scripts/derive-analytics.ts [dataDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Entry } from '@hub/contracts';
import { deriveCorpusAnalytics } from '../pipeline/derive/corpus-analytics.js';
import { SEARCH_INDEX_TIER_FILES, totalSearchableDocuments } from '../pipeline/derive/searchable-count.js';
import { readV2AnalyticsEvidence } from '../pipeline/derive/v2-analytics-evidence.js';

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
  const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, shard), 'utf8')) as Entry[];
  entries.push(...parsed);
  console.log(`  ${shard}: ${parsed.length.toLocaleString('en-US')} entries`);
}

// The measured figure, from every tier's own header — not a second derivation.
const searchableDocumentCount = totalSearchableDocuments(
  SEARCH_INDEX_TIER_FILES.map((name) => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'))),
);

const evidence = readV2AnalyticsEvidence(dataDir);
if (evidence === null) throw new Error(`No v2 analytics evidence in ${dataDir}; run the v2 apply step first.`);
const analytics = deriveCorpusAnalytics(entries, { searchableDocumentCount, ...evidence });
const outputPath = path.join(dataDir, 'analytics.json');
fs.writeFileSync(outputPath, JSON.stringify(analytics, null, 2), 'utf8');

console.log(
  `\nWrote ${path.relative(process.cwd(), outputPath)}: ` +
    `${analytics.total.toLocaleString('en-US')} entries, ` +
    `${analytics.searchable.toLocaleString('en-US')} searchable, ` +
    `${analytics.findings.policies.length} policies firing, ` +
    `${analytics.findings.totalOccurrences.toLocaleString('en-US')} findings.`,
);
// The scan states are printed because the artifact's `scanned` figure is not the
// corpus total and not the number of bodies: an operator reading only
// "11,464 entries" would ship the old illusion again.
console.log(
  `Scan coverage: ${analytics.scanCoverage.scanned.toLocaleString('en-US')} scanned ` +
    `(${analytics.scanCoverage.completed.toLocaleString('en-US')} completed, ` +
    `${analytics.scanCoverage.degraded.toLocaleString('en-US')} degraded, ` +
    `${analytics.scanCoverage.indeterminate.toLocaleString('en-US')} indeterminate), ` +
    `${analytics.scanCoverage.noBody.toLocaleString('en-US')} with no body, ` +
    `${analytics.scanCoverage.sourceUnavailable.toLocaleString('en-US')} whose body exists but whose source is unavailable, ` +
    `${analytics.scanCoverage.historical.toLocaleString('en-US')} historical/unverified; ` +
    `${analytics.findings.cleanScanned.toLocaleString('en-US')} clean scans of ` +
    `${analytics.scanCoverage.completed.toLocaleString('en-US')} completed.`,
);
console.log('Now run: node scripts/restamp-manifest.mjs && node scripts/sync-data.mjs');
