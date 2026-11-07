import fs from 'node:fs';
import path from 'node:path';
import { auditCatalogueClaimFreshness } from './lib/catalogue-claim-freshness.mjs';
import {
  auditScannerResultFreshness,
  readScannerVersionFromSource,
} from './lib/scanner-result-freshness.mjs';
import { resultsDigest, scopeCounts } from './lib/scanner-result-digest.mjs';
import { derivationCoverage } from './lib/scanner-result-derivation.mjs';

/**
 * Two questions about the catalogue's claims:
 *
 *   1. Is a graph claim still complete? (a published entry whose chart cannot be
 *      drawn must not stay public)
 *   2. Are the security claims still bound to a scanner? The verdicts are claims
 *      about code we did not write, and until this check existed nothing tied
 *      them to the scanner that produced them: a scanner change could leave
 *      stale grades in the catalogue and every gate would stay green.
 *
 * Question 2 is answered against `scanner-result-freshness.json`, which records
 * the engine identity, the declared stamp present on the shipped results, a
 * digest of the bound verdicts, the rescan evidence, and the link-only scope
 * that could not be rescanned. See `lib/scanner-result-freshness.mjs`.
 *
 *   node scripts/check-catalogue-claim-freshness.mjs [dataDir] [--record <path>] [--refresh]
 */
const args = process.argv.slice(2);
const recordFlag = args.indexOf('--record');
const refresh = args.includes('--refresh');
const recordIndex = recordFlag >= 0 ? recordFlag + 1 : -1;
const positional = args.filter((argument, index) => !argument.startsWith('--') && index !== recordIndex);
const dataDir = path.resolve(positional[0] ?? 'data');
const recordPath = path.resolve(
  recordIndex >= 0 && args[recordIndex] ? args[recordIndex] : path.join(import.meta.dirname, 'scanner-result-freshness.json'),
);
const versionSourcePath = path.resolve(import.meta.dirname, '..', 'packages/scanner-core/src/scanner-version.ts');

const entries = [];
const chartsById = new Map();
const projectionIds = [];
const searchableIds = new Set();
let chartMismatches = 0;

function readJson(file) { return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')); }
function addProjectionIds(ids) { projectionIds.push(...ids.filter((id) => typeof id === 'string')); }

for (let shard = 0; ; shard += 1) {
  const cataloguePath = path.join(dataDir, `catalogue-${shard}.json`);
  if (!fs.existsSync(cataloguePath)) break;
  const shardEntries = readJson(`catalogue-${shard}.json`);
  entries.push(...shardEntries);
  const chartPath = path.join(dataDir, 'charts', `chart-${shard}.jsonl`);
  const chartLines = fs.existsSync(chartPath) ? fs.readFileSync(chartPath, 'utf8').split('\n').filter(Boolean) : [];
  for (let index = 0; index < Math.min(shardEntries.length, chartLines.length); index += 1) {
    try { chartsById.set(shardEntries[index].id, JSON.parse(chartLines[index])); } catch { /* classified as missing */ }
  }
  if (chartLines.length !== shardEntries.length) {
    chartMismatches += 1;
    console.error(`Chart/catalogue count mismatch in shard ${shard}.`);
  }
}

for (const name of ['search-index.json', 'search-index-extended.json']) {
  const file = path.join(dataDir, name);
  if (fs.existsSync(file)) {
    const documentIds = Object.values(readJson(name).documentIds ?? {});
    addProjectionIds(documentIds);
    for (const id of documentIds) if (typeof id === 'string') searchableIds.add(id);
  }
}
const facetsPath = path.join(dataDir, 'facets.json');
const facets = fs.existsSync(facetsPath) ? readJson('facets.json') : undefined;
if (facets) addProjectionIds(facets.ordinals ?? []);
const semanticPath = path.join(dataDir, 'semantic-index.json');
if (fs.existsSync(semanticPath)) addProjectionIds((readJson('semantic-index.json').documents ?? []).map((document) => document.id));
for (const relativeDir of ['details', 'previews']) {
  const directory = path.join(dataDir, relativeDir);
  if (!fs.existsSync(directory)) continue;
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(directory, name), 'utf8').split('\n').filter(Boolean)) {
      try { addProjectionIds([JSON.parse(line).id]); } catch { /* malformed artifact is handled by corpus gate */ }
    }
  }
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith('-index.json'))) {
    addProjectionIds(Object.keys(readJson(path.join(relativeDir, name))));
  }
}
const reportPath = path.join(dataDir, 'quarantine-report.json');
const report = fs.existsSync(reportPath) ? readJson('quarantine-report.json') : undefined;
const result = auditCatalogueClaimFreshness(entries, chartsById, report, projectionIds);
if (chartMismatches > 0) result.violations.push(`${chartMismatches} chart/catalogue shard count mismatch(es)`);

// --- Scanner-result freshness -------------------------------------------------
const record = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, 'utf8')) : undefined;
if (refresh) {
  if (!record) {
    console.error(`Cannot refresh: ${path.relative(process.cwd(), recordPath)} does not exist.`);
    process.exit(1);
  }
  // Every number written here is measured from the artifacts just read; the
  // statuses and reasons are evidence and are preserved, so a refresh cannot
  // invent a reason for a scope it does not understand.
  const coverage = derivationCoverage(entries);
  const derived = record.derivation?.verified ?? {};
  const unscanned = record.derivation?.unscanned ?? {};
  const unverifiedScopes = Array.isArray(record.unverified) ? record.unverified : [];
  const next = {
    ...record,
    resultsDigest: resultsDigest(entries),
    scope: { ...record.scope, ...scopeCounts(entries), searchable: searchableIds.size },
    derivation: {
      ...record.derivation,
      verified: { ...derived, count: coverage.derived },
      unscanned: {
        ...unscanned,
        count: coverage.unscanned,
        byScope: {
          ...(unscanned.byScope ?? {}),
          official_without_body: coverage.unscannedOfficial,
          community_link_only_without_body: coverage.unscannedLinkOnly - coverage.unscannedOfficial,
        },
      },
    },
    unverified: unverifiedScopes.map((item) => item?.scope === 'link_only' ? { ...item, count: coverage.unscannedLinkOnly } : item),
  };
  const changes = ['resultsDigest', 'scope', 'derivation', 'unverified']
    .filter((key) => JSON.stringify(record[key]) !== JSON.stringify(next[key]));
  if (changes.length === 0) {
    console.log('Freshness record is already consistent with the shipped artifacts.');
    process.exit(0);
  }
  fs.writeFileSync(recordPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`Freshness record re-stamped: ${changes.join(', ')}.`);
  console.log('scannerVersion, recordedResultStamps, rescan and every status/reason are evidence and were left untouched.');
  process.exit(0);
}
const currentScannerVersion = fs.existsSync(versionSourcePath)
  ? readScannerVersionFromSource(fs.readFileSync(versionSourcePath, 'utf8'))
  : null;
const manifestPath = path.join(dataDir, 'manifest.json');
const manifestScannerVersion = fs.existsSync(manifestPath) ? readJson('manifest.json')?.metadata?.scannerVersion : undefined;
const facetsOrdinals = Array.isArray(facets?.ordinals) ? facets.ordinals.length : undefined;
if (facetsOrdinals !== undefined && facetsOrdinals !== searchableIds.size) {
  result.violations.push(`searchable projection does not reconcile: ${searchableIds.size} search-index ids vs ${facetsOrdinals} facet ordinals`);
}
const freshness = auditScannerResultFreshness({
  entries,
  record,
  currentScannerVersion,
  manifestScannerVersion,
  searchableCount: searchableIds.size,
});
result.violations.push(...freshness.violations);

console.log(`Catalogue claims checked: ${entries.length}`);
console.log(`Quarantine candidates still in catalogue: ${result.quarantinedCount}`);
if (record) {
  console.log(`Scanner-result freshness record: ${path.relative(process.cwd(), recordPath)}`);
  for (const [label, detail] of freshness.report) console.log(`  ${label}: ${detail}`);
} else {
  console.log(`Scanner-result freshness record: missing at ${path.relative(process.cwd(), recordPath)}`);
}
if (result.violations.length) {
  console.error(`Catalogue claim freshness gate failed: ${result.violations.length} violation(s).`);
  for (const violation of result.violations.slice(0, 25)) console.error(`  ${violation}`);
  if (result.violations.length > 25) console.error(`  ... ${result.violations.length - 25} more`);
  process.exit(1);
}
console.log('Catalogue claim freshness gate passed.');
