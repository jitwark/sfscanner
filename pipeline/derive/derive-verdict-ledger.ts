/**
 * Derive the 288-row changed-verdict ledger from the committed corpus.
 *
 * Run from the workspace root:
 *
 *   node --import tsx pipeline/derive/derive-verdict-ledger.ts
 *
 * Every input is committed: the catalogue shards, the pack bodies each row points
 * at, the corpus manifest and the scanner-result freshness record. The scanner is
 * the one on disk, so the ledger says what the current engine makes of the rows
 * that are actually shipped. Nothing is fetched and nothing is hand-written.
 *
 * `--reconcile <path>` additionally compares the derivation against a recorded
 * rescan report (a scratch measurement) and prints where the two populations agree
 * and where one supersedes the other. It never changes the ledger bytes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Candidate, Entry, EntrySecurity } from '@hub/contracts';
import { scanCandidate, getScannerVersion } from '../scan/scan-entry.js';
import { scanWorkflowWithCore } from '../scan/scanner-core-adapter.js';
import { buildVerdictLedger, type ResolvedBody, type VerdictLedger } from './verdict-ledger.js';

const LEDGER_PATH = 'docs/audit/2026-09-25-verdict-ledger/verdict-ledger.json';
const FRESHNESS_RECORD_PATH = 'scripts/scanner-result-freshness.json';
const MANIFEST_PATH = 'data/manifest.json';
const CATALOGUE_SHARD_LIMIT = 64;

/**
 * The superseded population: the same 288 bodies measured against the engine
 * revision *before* the credential-plumbing fix. Recorded here so the ledger
 * states which population each reported number came from.
 */
const SUPERSEDED_POPULATION = {
  reported: 20,
  source: 'pipeline/.work/rescan-run1.txt (gitignored scratch; not a committed input)',
  basis: 'the same 288 committed bodies, stored verdict vs the engine revision before packages/scanner-core/src/policies/secret-indicators.ts stopped classifying nodeCredentialType as secret-bearing — measured while those false positives were still live in the engine',
  resolution: 'the current engine re-derivation on the same 288 bodies reports 41 verdict changes, not 20. 19 of the 20 are also in the 41. The 20th (1ae2123eca2f28cf) drifted only under the pre-fix engine — the fix removes the 11 credential-plumbing false positives that had escalated it to CRITICAL/100, and its stored HIGH/64 reproduces exactly. The 41 additionally contain 22 rows whose stored verdicts carried those same false positives, so they compared identical while the bug was live and differ once it is removed. The 20 is therefore a pre-fix measurement of a different engine, not a different corpus.',
};

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readCatalogueEntries(): Entry[] {
  const entries: Entry[] = [];
  for (let shard = 0; shard < CATALOGUE_SHARD_LIMIT; shard += 1) {
    const file = path.join('data', `catalogue-${shard}.json`);
    if (!fs.existsSync(file)) break;
    entries.push(...(readJson<Entry[]>(file)));
  }
  if (entries.length === 0) throw new Error('no catalogue shards found under data/ — run from the workspace root');
  return entries;
}

/** Pack lines are read once per pack and cached; the body digest is the line's own sha256. */
function makeBodyResolver(): (entry: Entry) => ResolvedBody | null {
  const packs = new Map<number, string[]>();
  return (entry) => {
    const download = entry.download;
    if (download === undefined) return null;
    if (!packs.has(download.pack)) {
      const file = path.join('data', 'packs', `pack-${download.pack}.jsonl`);
      packs.set(download.pack, fs.readFileSync(file, 'utf8').split('\n'));
    }
    const line = packs.get(download.pack)?.[download.line];
    if (line === undefined) return null;
    const bodySha256 = sha256Hex(line);
    if (download.sha256 !== undefined && download.sha256 !== bodySha256) {
      throw new Error(`body digest mismatch for ${entry.id}: download pointer says ${download.sha256}, pack line hashes to ${bodySha256}`);
    }
    const parsed = JSON.parse(line) as { workflow?: unknown };
    return { body: parsed.workflow ?? parsed, bodySha256 };
  };
}

function makeScanner(): (entry: Entry, body: unknown) => Promise<EntrySecurity> {
  const scannerVersion = getScannerVersion();
  return (entry, body) => {
    // `Candidate` is wider than the fields the scanner reads (`id`, `json`,
    // `rights.status`); the cast is the documented pipeline boundary, the same one
    // pipeline/corpus/scan-stage.ts crosses.
    const candidate = { id: entry.id, json: body, rights: entry.rights } as unknown as Candidate;
    return scanCandidate(candidate, {
      scan: (workflow, options) => scanWorkflowWithCore(workflow, options),
      scannerVersion,
    });
  };
}

type FreshnessRecord = {
  scannerVersion: string;
  recordedResultStamps: Array<{ value: string; kind: string }>;
  rescan: { bodies: number; identical: number; different: number; differentIds: string[] };
};

type Manifest = { generatedAt: string; totalEntries: number; metadata: { scannerVersion: string; corpusSha256: string } };

/** Informational only: compare the derivation against a scratch rescan report. */
function reconcile(populationPath: string, ledger: VerdictLedger): void {
  const text = fs.readFileSync(populationPath, 'utf8');
  const header = /identical=(\d+) different=(\d+)/.exec(text);
  if (header === null) throw new Error(`no "identical=… different=…" line in ${populationPath}`);
  const different = Number(header[2]);
  const ids = [...text.matchAll(/^\{"id":"([0-9a-f]+)"/gm)].map((match) => match[1]);
  if (ids.length !== different) throw new Error(`${populationPath} names ${ids.length} ids but reports different=${different}`);
  if (different !== SUPERSEDED_POPULATION.reported) {
    throw new Error(`${populationPath} reports different=${different}, but the ledger records the superseded population as ${SUPERSEDED_POPULATION.reported}`);
  }
  const derived = ledger.rows.filter((row) => row.changed.verdict).map((row) => row.id);
  const derivedSet = new Set(derived);
  const recordedSet = new Set(ids);
  console.log(`reconcile: ${populationPath} reports ${different} changed; the ledger derives ${derived.length}`);
  console.log(`reconcile: shared ${ids.filter((id) => derivedSet.has(id)).length}, only-in-superseded ${ids.filter((id) => !derivedSet.has(id)).join(', ') || 'none'}, only-in-current ${derived.filter((id) => !recordedSet.has(id)).length}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outPath = outIndex === -1 ? LEDGER_PATH : args[outIndex + 1]!;
  const reconcileIndex = args.indexOf('--reconcile');

  const manifest = readJson<Manifest>(MANIFEST_PATH);
  const freshness = readJson<FreshnessRecord>(FRESHNESS_RECORD_PATH);
  const entries = readCatalogueEntries();

  const ledger = await buildVerdictLedger({
    entries,
    resolveBody: makeBodyResolver(),
    scan: makeScanner(),
    scanner: { value: getScannerVersion(), kind: freshness.recordedResultStamps.find((stamp) => stamp.value === getScannerVersion())?.kind ?? 'engine-identity' },
    recordedStamps: freshness.recordedResultStamps.map((stamp) => ({ value: stamp.value, kind: stamp.kind })),
    derivedAt: manifest.generatedAt,
    corpus: { manifestSha256: manifest.metadata.corpusSha256, totalEntries: manifest.totalEntries, linkOnly: entries.filter((entry) => entry.rights.status !== 'redistributable').length },
    recordedRescan: { path: FRESHNESS_RECORD_PATH, ...freshness.rescan },
    superseded: SUPERSEDED_POPULATION,
  });

  const bodyless = ledger.rows.filter((row) => row.new === null).length;
  if (bodyless > 0) throw new Error(`${bodyless} redistributable row(s) had no committed body to rescan`);
  if (ledger.reconciliation.recordedEvidence?.match !== true) {
    throw new Error(`the derivation does not reconcile with ${FRESHNESS_RECORD_PATH}: derived ${ledger.adjudication.changed} changed, recorded ${freshness.rescan.different}`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(`ledger: ${ledger.adjudication.rows} rows, ${ledger.adjudication.changed} changed verdicts, ${ledger.adjudication.stampOnly} stamp-only`);
  console.log(`ledger: by class ${JSON.stringify(ledger.adjudication.byClass)}`);
  console.log(`ledger: by disposition ${JSON.stringify(ledger.adjudication.byDisposition)}`);
  console.log(`ledger: grade transitions ${JSON.stringify(ledger.adjudication.gradeTransitions)}`);
  console.log(`ledger: recorded rescan ${freshness.rescan.identical} identical / ${freshness.rescan.different} different — reconciled`);
  console.log(`ledger: wrote ${outPath}`);
  if (reconcileIndex !== -1) reconcile(args[reconcileIndex + 1]!, ledger);
}

await main();
