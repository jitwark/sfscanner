/**
 * One-off P5.6 backfill from the already-packaged chart corpus. It does not
 * acquire, scan, enrich, or alter catalogue entries; it only derives the
 * static preview siblings and records their paths in the manifest.
 *
 * Follow with `node scripts/restamp-manifest.mjs` and `node scripts/sync-data.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Entry, EntryWithChart, WorkflowChart } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { SHARD_SIZE } from '../pipeline/package/write-artifacts.js';
import { writePreviewArtifacts } from '../pipeline/package/write-preview-artifacts.js';

const dataDir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', 'data'));
const catalogueFiles = fs.readdirSync(dataDir)
  .filter((name) => /^catalogue-\d+\.json$/.test(name))
  .sort((left, right) => Number(left.match(/\d+/)![0]) - Number(right.match(/\d+/)![0]));

if (catalogueFiles.length === 0) throw new Error(`No catalogue shards found in ${dataDir}.`);

const entries: Entry[] = [];
const charts: WorkflowChart[] = [];
for (const catalogueFile of catalogueFiles) {
  const shard = Number(catalogueFile.match(/\d+/)![0]);
  const shardEntries = JSON.parse(fs.readFileSync(path.join(dataDir, catalogueFile), 'utf8')) as Entry[];
  const chartFile = path.join(dataDir, 'charts', `chart-${shard}.jsonl`);
  const chartLines = fs.readFileSync(chartFile, 'utf8').split('\n').filter((line) => line.length > 0);
  if (chartLines.length !== shardEntries.length) {
    throw new Error(`Chart/catalogue count mismatch for shard ${shard}: ${chartLines.length} vs ${shardEntries.length}.`);
  }
  entries.push(...shardEntries);
  charts.push(...chartLines.map((line) => JSON.parse(line) as WorkflowChart));
}

const entriesWithCharts: EntryWithChart[] = entries.map((entry, index) => ({ entry, chart: charts[index]! }));
const previewsDir = path.join(dataDir, 'previews');
fs.rmSync(previewsDir, { recursive: true, force: true });
const written = writePreviewArtifacts(entriesWithCharts, dataDir, SHARD_SIZE);

const manifestPath = path.join(dataDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
  artifacts: Array<{ path: string; byteSize: number; sha256: string; entryCount: number; encoding?: string }>;
};
const known = new Set(manifest.artifacts.map((artifact) => artifact.path.replace(/\\/g, '/')));
for (const artifact of written) {
  const relativePath = artifact.relativePath.replace(/\\/g, '/');
  if (!known.has(relativePath)) {
    manifest.artifacts.push({ path: relativePath, byteSize: 0, sha256: '', entryCount: 0, encoding: artifact.encoding });
  }
}
manifest.artifacts.sort((left, right) => compareCanonicalStrings(left.path, right.path));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log(`Wrote ${written.length} preview artifacts for ${entries.length.toLocaleString('en-US')} entries.`);
console.log('Now run: node scripts/restamp-manifest.mjs && npm run sync:data');
