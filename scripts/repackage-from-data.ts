/**
 * Re-package the committed corpus from `data/` itself, through the real packager.
 *
 * `data/` was packaged before `prepareCatalogueClaims` existed, so it still
 * published 1,757 entries whose graph cannot render — the release blocker
 * REL-01, which `check:catalogue-claim-freshness` failed on.
 *
 * Re-running the pipeline was not the fast path. The acquisition state that
 * produced this corpus is not in `pipeline/.work` (it was cleaned) and was
 * believed lost; it was later found intact inside a 2026-08-15 backup, at
 * `_backups/community-hub-20260815-203643/pipeline/.work/prod-gh3/`, whose
 * 262 MB `entries.json` is the `EntryWithChart[]` that `run-enrichment` reads.
 * Re-deriving from it is possible and is the right route for a change that
 * needs the raw workflow bodies — but it is a multi-hour run that also needs
 * the description model, and this change needed neither.
 *
 * Hand-filtering the artifacts is not an option either: `search-index.json` is
 * an ordinal-keyed inverted index, and `details/` and `previews/` are read by
 * byte range through offset indexes. Removing a record means recomputing all of
 * it. So this reads the packaged corpus back into the shapes the packager takes
 * and calls `writeArtifacts`, which partitions, writes the quarantine report,
 * and regenerates every projection consistently by construction.
 *
 * Writes to a staging directory. Promote deliberately with
 * `node scripts/prepare-release-data.mjs <staging> --replace`, which keeps a
 * rollback copy of the current `data/`.
 *
 *   node --max-old-space-size=6144 --import tsx scripts/repackage-from-data.ts \
 *     --out pipeline/.work/repackage/data [--data data] [--generated-at <iso>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { isIndexable, resolvePrerenderLimit, type Entry, type EntryWithChart, type WorkflowChart } from '@hub/contracts';
import { buildSearchIndex } from '../pipeline/index/build-search-index.js';
import { buildFacets } from '../pipeline/index/facets.js';
import { buildManifest } from '../pipeline/package/manifest.js';
import { stageScannerSidecars } from '../pipeline/package/scanner-sidecars.js';
import { writeArtifacts } from '../pipeline/package/write-artifacts.js';
import { buildMetadataFromEntries } from '../pipeline/package/metadata-from-entries.js';
import { selectPrerenderedIds } from '../pipeline/index/prerender.js';
import { assertIndexableFloor, indexableFloorReport } from '../pipeline/index/indexable-floor.js';
import { partitionCatalogueClaims } from '../pipeline/derive/catalogue-claim-freshness.js';
import compatibilityTarget from '../pipeline/config/n8n-compatibility-target.json';

const NEWLINE = String.fromCharCode(10);

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dataDir = path.resolve(flag('data') ?? 'data');
const outputDir = path.resolve(flag('out') ?? path.join('pipeline', '.work', 'repackage', 'data'));
const generatedAt = flag('generated-at') ?? new Date().toISOString();

if (path.resolve(outputDir) === path.resolve(dataDir)) {
  console.error('Refusing to write over the source corpus. The packager clears its output directory first.');
  process.exit(1);
}

/**
 * Read the shards and their charts together. Charts are stored one JSONL line
 * per catalogue entry, positionally aligned — the same pairing the freshness
 * gate relies on, so a count mismatch is a hard error here rather than a
 * silently misaligned graph.
 */
function readItems(): EntryWithChart[] {
  const items: EntryWithChart[] = [];
  for (let shard = 0; ; shard += 1) {
    const cataloguePath = path.join(dataDir, `catalogue-${shard}.json`);
    if (!fs.existsSync(cataloguePath)) break;
    const entries = JSON.parse(fs.readFileSync(cataloguePath, 'utf8')) as Entry[];
    const chartPath = path.join(dataDir, 'charts', `chart-${shard}.jsonl`);
    const lines = fs.readFileSync(chartPath, 'utf8').split('\n').filter(Boolean);
    if (lines.length !== entries.length) {
      throw new Error(`shard ${shard}: ${entries.length} entries but ${lines.length} charts`);
    }
    for (let index = 0; index < entries.length; index += 1) {
      items.push({ entry: entries[index]!, chart: JSON.parse(lines[index]!) as WorkflowChart });
    }
  }
  return items;
}

/**
 * Rebuild the redistributable workflow bodies from the packs.
 *
 * `entry.download` carries exact coordinates — `{ pack, line, offset, length }` —
 * so the body is read by position rather than matched by id. The pack record's
 * own `id` is the workflow's n8n id, which is a different id space from the
 * catalogue entry id; pairing on it would silently recover nothing.
 *
 * The packager throws if a redistributable canonical entry has no workflow,
 * which is the behaviour we want: a re-package that quietly emptied 288
 * downloads would be worse than one that refuses to run.
 */
function readWorkflows(items: EntryWithChart[]): Map<string, unknown> {
  const packs = new Map<number, string>();
  const workflowsById = new Map<string, unknown>();
  for (const item of items) {
    const download = item.entry.download;
    if (!download) continue;
    if (!packs.has(download.pack)) {
      const packPath = path.join(dataDir, 'packs', `pack-${download.pack}.jsonl`);
      if (!fs.existsSync(packPath)) continue;
      packs.set(download.pack, fs.readFileSync(packPath, 'utf8'));
    }
    const lines = packs.get(download.pack)!.split(NEWLINE);
    const line = lines[download.line];
    if (line === undefined) continue;
    try {
      workflowsById.set(item.entry.id, JSON.parse(line));
    } catch {
      // A malformed pack line leaves the entry without a body, and the packager
      // then refuses the run by name rather than shipping an empty download.
    }
  }
  return workflowsById;
}

const items = readItems();
console.log(`Read ${items.length.toLocaleString('en-US')} packaged entries.`);

const workflowsById = readWorkflows(items);
console.log(`Recovered ${workflowsById.size} redistributable workflow bodies from packs.`);

const partition = partitionCatalogueClaims(items);
console.log(`Catalogue claim freshness: ${partition.published.length} publishable, ${partition.quarantined.length} quarantined.`);

const published = partition.published.map((item) => item.entry);
for (const entry of published) {
  (entry as unknown as Record<string, unknown>).indexable = isIndexable(entry);
}
const prerenderedIds = selectPrerenderedIds(published.filter(isIndexable), resolvePrerenderLimit(process.env));
for (const entry of published) entry.isPrerendered = prerenderedIds.has(entry.id);

console.log(indexableFloorReport(published));
assertIndexableFloor(published);

fs.mkdirSync(outputDir, { recursive: true });
const written = writeArtifacts(items, workflowsById, buildSearchIndex(published), buildFacets(published), outputDir, { legacyV1: true });
const metadata = buildMetadataFromEntries(published, outputDir, {
  version: compatibilityTarget.version,
  source: compatibilityTarget.source,
  checkedAt: compatibilityTarget.checkedAt,
}, generatedAt);
// The staged tree is promoted over `data/` wholesale, so it has to be a complete
// release tree: without the scanner sidecars the manifest cannot own them and the
// promotion would delete them from the release.
const stagedSidecars = stageScannerSidecars(dataDir, outputDir);
const { manifestSha256 } = buildManifest(outputDir, written, generatedAt, metadata);

console.log(`Wrote ${written.length} artifacts to ${outputDir}`);
console.log(`staged scanner sidecars ${stagedSidecars.length}`);
console.log(`manifest sha256 ${manifestSha256}`);
console.log(`Promote with: node scripts/prepare-release-data.mjs ${path.relative(process.cwd(), outputDir)} --replace`);
