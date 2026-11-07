/**
 * Builds the public-release dataset bundle (NDJSON, SQLite, Excel, data
 * dictionary, manifest) from the committed corpus in `data/` and writes it,
 * atomically, to `outputs/public-dataset/`.
 *
 * `pipeline/export/` already implements the writers and every invariant
 * (rights-vs-facet-count parity, per-format row-count parity, redaction);
 * this script is only the missing driver that gathers real inputs and calls
 * `writePublicRelease`. See `docs/audit/2026-09-04/TASK-EXPORT-PROGRESS.md`
 * for how each input was sourced.
 *
 * Deterministic by default: `--generated-at` defaults to the corpus
 * manifest's own `generatedAt` rather than the wall clock, so re-running
 * over an unchanged corpus reproduces the same release identity and (up to
 * genuinely time-derived bytes, of which there are none here) the same
 * bytes. The release id itself is derived from the dataset's own content
 * (`./lib/public-dataset-identity.ts`) and not from that date, so two byte
 * states cannot share one id.
 *
 * Usage: node --import tsx scripts/export-public-dataset.ts
 *          [--data <dir>] [--out <dir>] [--generated-at <iso>]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { betaDefaultRuleCatalog, betaHardenedRuleCatalog } from '@hub/scanner-core/rule-catalog';
import { SEARCH_INDEX_SERIALIZATION_VERSION } from '@hub/contracts/search-index-artifact';
import { buildPublicProjectionV4 } from '../pipeline/export/public-projection-v4.js';
import { readPreflightSidecar } from '../pipeline/export/preflight-sidecar.js';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4 } from '@hub/contracts/public-data-model';
import { writePublicRelease } from '../pipeline/export/public-release.js';
import { ADMITTED_V2_SCAN_IDENTITY } from '../pipeline/scan/v2-corpus-adapter.js';
import { certifyScanFreshness } from '../pipeline/export/scan-freshness.js';
import { assertCorpusCountsMatchAnalytics } from './lib/public-dataset-analytics-check.js';
import {
  parsePublicDatasetArguments,
  PublicDatasetUsageError,
  type PublicDatasetArguments,
} from './lib/public-dataset-arguments.js';
import { readAnalytics, readCatalogueEntries, readManifest } from './lib/public-dataset-corpus-io.js';
import { readV2ScanReceipts } from './lib/v2-scan-receipts.js';
import { buildReleaseMetadata, computeReleaseCounts, hashRuleCatalog } from './lib/public-dataset-release-metadata.js';
import { projectionSections, sealedDatasetId, verifyDatasetReleaseId } from './lib/public-dataset-identity.js';

/**
 * Stands in for the id while the content it is about to be derived from is
 * measured. It cannot leak into a bundle: `buildPublicProjection` is called a
 * second time with the derived id and only that projection is written.
 */
const PENDING_RELEASE_ID = 'release-pending';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * Printed verbatim when the command line is malformed: the grammar and the
 * three flags, never anything the operator typed.
 */
const USAGE = [
  'Usage: node --import tsx scripts/export-public-dataset.ts [--data <dir>] [--out <dir>] [--generated-at <iso>]',
  '  --data <dir>          corpus directory (default: <repo>/data)',
  '  --out <dir>           bundle destination (default: <repo>/outputs/public-dataset)',
  "  --generated-at <iso>  exact ISO-8601 UTC timestamp (default: the corpus manifest's generatedAt)",
].join('\n');

// Parsed before the first log line, the first corpus read, and the first byte
// written: a malformed command line can only ever exit 2 with the usage block,
// never fall back to the default destination and start exporting.
let args: PublicDatasetArguments;
try {
  args = parsePublicDatasetArguments(process.argv.slice(2), repoRoot);
} catch (error) {
  if (!(error instanceof PublicDatasetUsageError)) throw error;
  fs.writeSync(2, `${error.message}\n\n${USAGE}\n`);
  process.exit(2);
}
const { dataDir, outputDir } = args;

console.log(`Reading corpus from ${path.relative(repoRoot, dataDir)}...`);
const entries = readCatalogueEntries(dataDir);
const analytics = readAnalytics(dataDir);
// Refuse to publish a bundle whose counts disagree with the site's own
// analytics — a dataset that quietly disagrees with the static site is
// worse than no dataset at all.
assertCorpusCountsMatchAnalytics(entries, analytics);
console.log(`  ${entries.length.toLocaleString('en-US')} entries loaded; counts match data/analytics.json.`);

const { manifest, manifestSha256 } = readManifest(dataDir);
const generatedAt = args.generatedAt ?? manifest.generatedAt;

// This release publishes no body: the receipt sidecar is the scan evidence, and every row is
// projected link-only regardless of its source licence.
const analyticsDocument = JSON.parse(fs.readFileSync(path.join(dataDir, 'analytics.json'), 'utf8')) as { v2Evidence?: { inventorySha256?: unknown } };
const certifiedInventory = analyticsDocument.v2Evidence?.inventorySha256;
const receipts = readV2ScanReceipts(path.join(dataDir, 'scanner', 'v2-scan-evidence.ndjson'));
if (typeof certifiedInventory !== 'string' || receipts.inventorySha256 !== certifiedInventory) {
  throw new Error(`Receipts derive from inventory ${receipts.inventorySha256} but analytics certifies ${String(certifiedInventory)}; refusing a mixed snapshot.`);
}
const preflight = readPreflightSidecar(dataDir, manifest.artifacts, receipts.inventorySha256, entries.map((entry) => entry.id));
const preflightOptions = { preflight, inventorySha256: receipts.inventorySha256 };
const scanOptions = { admittedIdentity: ADMITTED_V2_SCAN_IDENTITY, scanReceiptsByWorkflowId: receipts.receiptsByWorkflowId };
const census = certifyScanFreshness(entries, scanOptions);
console.log(`  v2 receipts for inventory ${receipts.inventorySha256.slice(0, 12)}…; freshness ${JSON.stringify(census)}.`);

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { name: string; version: string };
const buildRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const policyVersion = `policy-${hashRuleCatalog({ betaDefaultRuleCatalog, betaHardenedRuleCatalog }).slice(0, 16)}`;

if (manifest.metadata.scannerVersion !== ADMITTED_V2_SCAN_IDENTITY.scannerVersion) {
  throw new Error(`Release metadata scannerVersion ${manifest.metadata.scannerVersion} is not the admitted v2 engine ${ADMITTED_V2_SCAN_IDENTITY.scannerVersion}.`);
}
const metadataInput = {
  generatedAt,
  toolVersion: `${pkg.name}@${pkg.version}`,
  scannerVersion: manifest.metadata.scannerVersion,
  policyVersion,
  searchIndexVersion: `search-index-v${SEARCH_INDEX_SERIALIZATION_VERSION}`,
  buildRevision,
  manifestSha256,
  corpusSha256: manifest.metadata.corpusSha256,
  counts: computeReleaseCounts(entries),
};

// The id is a function of the dataset, so the dataset cannot be built around
// it in one pass. `PENDING_RELEASE_ID` never ships: `datasetIdentity` seals
// every metadata field except the id, so a projection carrying it measures
// exactly the content the shipped projection will carry. The pending
// projection is not kept — it is dropped before the shipped one is built.
const pendingRelease = { ...buildReleaseMetadata({ ...metadataInput, releaseId: PENDING_RELEASE_ID }), schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4 };
const sections = projectionSections(buildPublicProjectionV4(entries, { release: pendingRelease, linkOnly: true, ...scanOptions, ...preflightOptions }));
const releaseId = sealedDatasetId(pendingRelease, sections);

const release = { ...buildReleaseMetadata({ ...metadataInput, releaseId }), schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4 };
const projection = buildPublicProjectionV4(entries, { release, linkOnly: true, ...scanOptions, ...preflightOptions });
console.log(`Dataset id ${releaseId} sealed from ${Object.keys(sections).length} content relation(s).`);
console.log(`Writing release ${release.releaseId} to ${path.relative(repoRoot, outputDir)}...`);
const bundle = writePublicRelease(projection, outputDir);

// Fail closed if the bytes that landed on disk are not the bytes the id sealed:
// the digest is computed from rows in memory, and this is the only place that
// can notice a writer serializing them differently from `canonicalRowBytes`.
const sealed = verifyDatasetReleaseId(outputDir);
if (!sealed.matches) throw new Error(`the written dataset declares ${sealed.releaseId} but its content derives ${sealed.derived}`);

console.log(`\nWrote public dataset release ${bundle.releaseId}:`);
console.log(`  relations: ${JSON.stringify(bundle.relations)}`);
console.log(`  ndjson: ${bundle.formats.ndjson.files} file(s) at ${bundle.formats.ndjson.path}/`);
console.log(`  sqlite: ${bundle.formats.sqlite.byteSize.toLocaleString('en-US')} bytes, sha256 ${bundle.formats.sqlite.sha256}`);
console.log(`  excel: ${bundle.formats.excel.byteSize.toLocaleString('en-US')} bytes, sheets ${JSON.stringify(bundle.formats.excel.sheetRowCounts)}`);
console.log(`  excel cell clipping: ${bundle.formats.excel.truncation.count} cell(s) at the ${bundle.formats.excel.truncation.limit}-character limit${bundle.formats.excel.truncation.count > 0 ? `, fields ${JSON.stringify(bundle.formats.excel.truncation.fields)}` : ''}`);
console.log(`  documentation: ${JSON.stringify(bundle.documentation)}`);
