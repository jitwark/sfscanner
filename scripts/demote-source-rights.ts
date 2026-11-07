/**
 * Re-decide redistribution rights for one source, and re-package the corpus.
 *
 * Why this exists rather than a full `npm run corpus`: a rebuild acquires from
 * the network and calls a model, and neither is needed to change a rights
 * decision. What *is* needed is that the repackaging be identical to what a
 * rebuild would produce — so this calls the same `buildSearchIndex`,
 * `buildFacets`, `writeArtifacts`, `buildMetadataFromEntries` and
 * `buildManifest` that `pipeline/enrich-corpus.ts` calls, in the same order.
 * It re-derives; it does not hand-edit.
 *
 * That matters most for the packs. Removing a workflow body shifts every byte
 * offset after it, and `entry.download` is a byte range. `writeArtifacts` owns
 * that assignment and drops `download` for anything no longer redistributable,
 * so flipping `rights.status` and re-running is the whole operation.
 *
 * Writes to a staging directory. Nothing under `data/` changes until the output
 * has been validated and promoted with `npm run prepare:release-data`, which is
 * the path `docs/DATA-LIFECYCLE.md` describes.
 *
 * It republishes every claim it does not demote, so it reads the recorded
 * per-item licence evidence from the rights-evidence journal —
 * `<dataDir>/rights-evidence.jsonl`, or `--rights-evidence <path>` — and refuses
 * to write when a carried-forward `redistributable` entry has no evidence behind
 * it. `--dry-run` writes nothing and is not held to that.
 *
 *   npx tsx scripts/demote-source-rights.ts --repo <owner/name> --reason "<why>" --out <dir>
 *   npx tsx scripts/demote-source-rights.ts --repo Zie619/n8n-workflows --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Entry, EntryWithChart, WorkflowChart } from '@hub/contracts';
import { buildSearchIndex } from '../pipeline/index/build-search-index.js';
import { buildFacets } from '../pipeline/index/facets.js';
import { writeArtifacts } from '../pipeline/package/write-artifacts.js';
import { buildMetadataFromEntries } from '../pipeline/package/metadata-from-entries.js';
import { buildManifest } from '../pipeline/package/manifest.js';
import { stageScannerSidecars } from '../pipeline/package/scanner-sidecars.js';
import { checkRedistributionEvidence, type RedistributionEvidenceCheck } from '../pipeline/rights/recorded-evidence.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const repo = arg('repo');
const reason = arg('reason')
  ?? 'contrary evidence: repository licence cannot cover workflows the uploader did not author';
const dataDir = path.resolve(arg('data') ?? path.join(import.meta.dirname, '..', 'data'));
const outputDir = path.resolve(arg('out') ?? path.join(import.meta.dirname, '..', 'pipeline', '.work', 'rights-restage', 'data'));
const dryRun = process.argv.includes('--dry-run');

if (!repo) {
  console.error('Usage: tsx scripts/demote-source-rights.ts --repo <owner/name> [--reason "..."] [--out <dir>] [--dry-run]');
  process.exit(1);
}

/** Load the packaged corpus back into the shape the packager consumes. */
function readCorpus(): { items: EntryWithChart[]; workflowsById: Map<string, unknown> } {
  const items: EntryWithChart[] = [];
  const workflowsById = new Map<string, unknown>();

  for (let shard = 0; ; shard += 1) {
    const cataloguePath = path.join(dataDir, `catalogue-${shard}.json`);
    if (!fs.existsSync(cataloguePath)) break;
    const chartPath = path.join(dataDir, 'charts', `chart-${shard}.jsonl`);
    const entries: Entry[] = JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
    const charts = fs.readFileSync(chartPath, 'utf8').split('\n').filter((line) => line.trim());
    if (entries.length !== charts.length) {
      throw new Error(`shard ${shard}: ${entries.length} entries but ${charts.length} charts — cannot re-pair them`);
    }
    for (let index = 0; index < entries.length; index += 1) {
      items.push({ entry: entries[index]!, chart: JSON.parse(charts[index]!) as WorkflowChart });
    }
  }

  // Workflow bodies come out of the packs by the byte range the entry records.
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
const matches = (entry: Entry) => (entry.source?.permalink ?? '').includes(`github.com/${repo}/`);

const before = {
  total: items.length,
  redistributable: items.filter((item) => item.entry.rights?.status === 'redistributable').length,
  fromRepo: items.filter((item) => matches(item.entry)).length,
};

function demote(entry: Entry, why: string): void {
  entry.rights = {
    status: 'link_only',
    // Keep what the repository claimed; only our willingness to redistribute changes.
    licence: entry.rights?.licence ?? null,
    licenceUrl: entry.rights?.licenceUrl ?? null,
    reason: why,
  };
}

const isAnnotation = (node: { type?: string; isAnnotation?: boolean }) =>
  node?.isAnnotation === true || String(node?.type ?? '').toLowerCase().includes('stickynote');

/** Does data actually pass between this workflow's nodes? */
function hasResolvableFlow(chart: WorkflowChart): boolean {
  const functional = (chart.nodes ?? []).filter((node) => !isAnnotation(node));
  if (functional.length < 2) return true;
  const refs = new Set(functional.flatMap((node) => [node.id, node.name]).filter(Boolean));
  return (chart.edges ?? []).some((edge) => refs.has(edge.from) && refs.has(edge.to));
}

let demoted = 0;
for (const { entry } of items) {
  if (!matches(entry) || entry.rights?.status !== 'redistributable') continue;
  demote(entry, reason);
  demoted += 1;
}

/**
 * A rule rather than a special case: whatever the licence says, a workflow whose
 * connections resolve to nothing is not a thing to hand someone as a file. It
 * will not import, and its security grade was computed over a graph that is not
 * there. Catches the stragglers a per-source decision leaves behind.
 */
let demotedBroken = 0;
if (process.argv.includes('--demote-broken-graphs')) {
  for (const { entry, chart } of items) {
    if (entry.rights?.status !== 'redistributable' || hasResolvableFlow(chart)) continue;
    demote(entry, 'contrary evidence: the workflow declares connections that match none of its nodes');
    demotedBroken += 1;
  }
}

const after = {
  redistributable: items.filter((item) => item.entry.rights?.status === 'redistributable').length,
};

console.log(`source                 ${repo}`);
console.log(`entries from it        ${before.fromRepo}`);
console.log(`redistributable before ${before.redistributable}`);
console.log(`demoted                ${demoted}`);
console.log(`demoted, broken graph  ${demotedBroken}`);
console.log(`redistributable after  ${after.redistributable}`);

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

const entries = items.map((item) => item.entry);

// This script republishes every entry it does not demote, `rights.status`
// included, so it can publish a redistribution claim exactly as
// `run-regeneration` can — and the claim is checked the same way, by the same
// function, before anything is written.
let redistributionEvidence: RedistributionEvidenceCheck;
try {
  redistributionEvidence = checkRedistributionEvidence(entries, dataDir, arg('rights-evidence'));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
console.log(`redistribution claims  ${redistributionEvidence.evidenced} of ${redistributionEvidence.claims} evidenced`);

const searchIndexResult = buildSearchIndex(entries);
const facetsData = buildFacets(entries);
const written = writeArtifacts(items, workflowsById, searchIndexResult, facetsData, outputDir, { legacyV1: true });

// Carry the release metadata forward: none of it is invalidated by a rights
// change, and inventing new values would misreport which sanitizer, scanner and
// model actually produced this corpus.
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
console.log(`  npm run prepare:release-data -- ${path.relative(process.cwd(), outputDir)} --replace`);
console.log('  npm run sync:data && npm run check:data-sync && npm run check:graph');
