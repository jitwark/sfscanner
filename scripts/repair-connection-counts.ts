/**
 * Re-derive connection counts and complexity bands from the charts, and
 * re-package the corpus.
 *
 * Why this exists rather than a full `npm run corpus`: a rebuild acquires from
 * the network and calls a model, and neither is needed to correct a count. What
 * *is* needed is that the repackaging be identical to what a rebuild would
 * produce, so this calls the same `buildSearchIndex`, `buildFacets`,
 * `writeArtifacts`, `buildMetadataFromEntries` and `buildManifest` that
 * `pipeline/enrich-corpus.ts` calls, in the same order. It re-derives; it does
 * not hand-edit. `scripts/demote-source-rights.ts` is the same shape.
 *
 * Writes to a staging directory. Nothing under `data/` changes until the output
 * has been validated and promoted with `npm run prepare:release-data`, the path
 * `docs/DATA-LIFECYCLE.md` describes.
 *
 *   npx tsx scripts/repair-connection-counts.ts --dry-run
 *   npx tsx scripts/repair-connection-counts.ts --out pipeline/.work/conn-restage/data
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Entry, EntryWithChart, WorkflowChart } from '@hub/contracts';
import { repairEntry } from '../pipeline/derive/repair-connections.js';
import { buildSearchIndex } from '../pipeline/index/build-search-index.js';
import { buildFacets } from '../pipeline/index/facets.js';
import { writeArtifacts } from '../pipeline/package/write-artifacts.js';
import { buildMetadataFromEntries } from '../pipeline/package/metadata-from-entries.js';
import { buildManifest } from '../pipeline/package/manifest.js';
import { stageScannerSidecars } from '../pipeline/package/scanner-sidecars.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const dataDir = path.resolve(arg('data') ?? path.join(import.meta.dirname, '..', 'data'));
const outputDir = path.resolve(arg('out') ?? path.join(import.meta.dirname, '..', 'pipeline', '.work', 'conn-restage', 'data'));
const dryRun = process.argv.includes('--dry-run');

/** Load the packaged corpus back into the shape the packager consumes. */
function readCorpus(): { items: EntryWithChart[]; workflowsById: Map<string, unknown> } {
  const items: EntryWithChart[] = [];
  const workflowsById = new Map<string, unknown>();

  for (let shard = 0; ; shard += 1) {
    const cataloguePath = path.join(dataDir, `catalogue-${shard}.json`);
    if (!fs.existsSync(cataloguePath)) break;
    const entries: Entry[] = JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
    const charts = fs.readFileSync(path.join(dataDir, 'charts', `chart-${shard}.jsonl`), 'utf8')
      .split('\n').filter((line) => line.trim());
    if (entries.length !== charts.length) {
      throw new Error(`shard ${shard}: ${entries.length} entries but ${charts.length} charts — cannot re-pair them`);
    }
    for (let index = 0; index < entries.length; index += 1) {
      items.push({ entry: entries[index]!, chart: JSON.parse(charts[index]!) as WorkflowChart });
    }
  }

  const packCache = new Map<number, Buffer>();
  for (const { entry } of items) {
    const download = entry.download;
    if (!download) continue;
    if (!packCache.has(download.pack)) {
      packCache.set(download.pack, fs.readFileSync(path.join(dataDir, 'packs', `pack-${download.pack}.jsonl`)));
    }
    const slice = packCache.get(download.pack)!.subarray(download.offset, download.offset + download.length);
    workflowsById.set(entry.id, JSON.parse(slice.toString('utf8')));
  }

  return { items, workflowsById };
}

const { items, workflowsById } = readCorpus();

const bands = ['simple', 'medium', 'complex'] as const;
const before = { edges: 0, byBand: new Map<string, number>() };
const after = { edges: 0, byBand: new Map<string, number>() };
const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

let changed = 0;
let phantom = 0;
const repaired: EntryWithChart[] = [];
for (const item of items) {
  before.edges += item.entry.structure?.connectionCount ?? 0;
  bump(before.byBand, item.entry.structure?.complexity ?? 'unknown');

  const result = repairEntry(item.entry, item.chart);
  phantom += result.chart.unresolvedEdgeCount ?? 0;
  if (result.changed) changed += 1;

  after.edges += result.entry.structure.connectionCount;
  bump(after.byBand, result.entry.structure.complexity);
  repaired.push({ entry: result.entry, chart: result.chart });
}

console.log(`entries                ${items.length}`);
console.log(`entries changed        ${changed}`);
console.log(`connections before     ${before.edges.toLocaleString('en-US')}`);
console.log(`connections after      ${after.edges.toLocaleString('en-US')}`);
console.log(`phantom connections    ${phantom.toLocaleString('en-US')}`);
console.log('\ncomplexity band        before ->  after');
for (const band of bands) {
  console.log(`  ${band.padEnd(20)} ${String(before.byBand.get(band) ?? 0).padStart(6)} -> ${String(after.byBand.get(band) ?? 0).padStart(6)}`);
}

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

const entries = repaired.map((item) => item.entry);
const written = writeArtifacts(repaired, workflowsById, buildSearchIndex(entries), buildFacets(entries), outputDir, { legacyV1: true });

// Carry the release metadata forward: none of it is invalidated by a count
// correction, and inventing new values would misreport which sanitizer, scanner
// and model actually produced this corpus.
const previousManifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8'));
const compatibilityTarget = previousManifest.metadata?.compatibilityTarget ?? {};
const metadata = buildMetadataFromEntries(entries, outputDir, {
  version: compatibilityTarget.version,
  source: compatibilityTarget.source,
  checkedAt: compatibilityTarget.checkedAt,
}, previousManifest.generatedAt);
// The staged tree replaces `data/` wholesale on promotion, so it must carry the
// scanner sidecars the release manifest owns; without them the promotion would
// delete them and the manifest could not declare them.
const stagedSidecars = stageScannerSidecars(dataDir, outputDir);
const { manifestSha256 } = buildManifest(outputDir, written, previousManifest.generatedAt, metadata);

console.log(`\nrepackaged into        ${outputDir}`);
console.log(`artifacts written      ${written.length}`);
console.log(`scanner sidecars       ${stagedSidecars.length}`);
console.log(`manifest sha256        ${manifestSha256}`);
console.log('\nNext: validate, then promote.');
console.log(`  node scripts/validate-corpus-integrity.mjs ${path.relative(process.cwd(), outputDir)} --release`);
console.log(`  node scripts/check-graph-coherence.mjs ${path.relative(process.cwd(), outputDir)}`);
console.log(`  npm run prepare:release-data -- ${path.relative(process.cwd(), outputDir)} --replace`);
console.log('  npm run sync:data && npm run check:data-sync && npm run check:graph');
