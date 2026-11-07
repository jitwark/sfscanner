/**
 * `pipeline/regenerate/v2-cli.ts` — the v2 regeneration driver.
 *
 *   npx tsx pipeline/regenerate/v2-cli.ts --data data --inventory <file> [--out <dir>]
 *                                         [--map <file> --bodies <dir> ...]
 *
 * It reads the committed corpus and the C1 input inventory (both named on the command line, never
 * discovered), derives one retained evidence record per row through C2b-1's writer, plans every entry
 * through C2b-2, and prints the run census. **It is a dry run unless `--out` names a directory**: a
 * dry run writes nothing at all, and a run with `--out` writes exactly two files there
 * (`v2-regeneration-report.json`, the complete `v2-regeneration-run-v1` report, and
 * `v2-scan-evidence.ndjson`, one `v2-scan-evidence-v1` record per line). Nothing under `--data` — or
 * anywhere else — is written, and `--out` inside `--data` is refused at parse time.
 *
 * `--map` plus its `--bodies` folders turns the run into a scan; without it no body is read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Entry } from '@hub/contracts';
import type { CorpusV2InputInventory } from '../../scripts/lib/corpus-v2-input-inventory.js';
import type { V2Grade, V2RescanRecord } from '../scan/v2-corpus-adapter.js';
import { bodyFileByEntryId, loadOfficialBodyMap, type OfficialBodyRef } from './official-bodies.js';
import { readPackagedItems } from './read-committed-corpus.js';
import { applyV2Regeneration, assertAppliedCensus, normalizeV2Records } from './v2-apply.js';
import { hydrationCacheFileName } from '../../scripts/lib/v2-hydration-cache.js';
import { deriveCapturedBody, publicSourceId, type BodyDerivedMetadata } from '../export/body-derived-metadata.js';
import { projectFormalNodeSample, buildFormalNodeCoverage, type FormalNodeSample } from './formal-node-coverage.js';
import { formalCoverageBinding } from './formal-coverage-binding.js';
import { runV2Regeneration } from './run-v2-regeneration.js';
import type { V2RegenerationSubject } from './v2-regenerate-entry.js';
import { buildV2ScanEvidence, type V2RetainedVerdict, type V2ScanEvidenceRecord } from './v2-scan-evidence.js';

import { USAGE, V2CliUsageError, parseV2CliArguments, type V2CliArguments } from './v2-cli-arguments.js';
export { V2CliUsageError, parseV2CliArguments, type V2CliArguments } from './v2-cli-arguments.js';

function isInventoryRecord(value: unknown): value is CorpusV2InputInventory {
  return typeof value === 'object' && value !== null && 'schemaVersion' in value && 'rows' in value
    && 'inventorySha256' in value && value.schemaVersion === 'corpus-v2-input-inventory-v1';
}

function inventoryOf(parsed: unknown): CorpusV2InputInventory | null {
  if (isInventoryRecord(parsed)) return parsed;
  if (typeof parsed === 'object' && parsed !== null && 'inventory' in parsed && isInventoryRecord(parsed.inventory)) {
    return parsed.inventory;
  }
  return null;
}

/** `UNKNOWN` is a published absence, not a grade: it stays null, and never becomes `LOW`. */
const GRADE: Record<Entry['security']['grade'], V2Grade | null> = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
  UNKNOWN: null,
};

/**
 * The three producer inputs C2b-1 asks for, taken from the committed entries themselves: their rights
 * posture, their own retained verdict, and — only when a map bound a body — its bytes.
 */
function producerInputs(
  entries: readonly Entry[],
  bodies: Map<string, OfficialBodyRef> | null,
  onBytes: (entryId: string, bytes: Uint8Array) => void,
) {
  const entryOf = new Map(entries.map((entry) => [entry.id, entry]));

  const rightsClassOf = (entryId: string): V2RescanRecord['rightsClass'] => {
    const entry = entryOf.get(entryId);
    if (entry === undefined) throw new Error(`the inventory carries ${entryId}, which the committed corpus does not`);
    return entry.rights.status;
  };
  const retainedVerdictOf = (entryId: string): V2RetainedVerdict | undefined => {
    const entry = entryOf.get(entryId);
    if (entry === undefined) return undefined;
    return {
      scannerVersion: entry.security.scannerVersion,
      grade: GRADE[entry.security.grade],
      analysisStatus: entry.security.analysisStatus ?? null,
    };
  };
  const readBytes = (entryId: string): Uint8Array | undefined => {
    const ref = bodies?.get(entryId);
    if (ref === undefined) return undefined;
    try {
      // A plain Uint8Array: the adapter and the engine both refuse a Buffer, and a body that cannot
      // be read is an absence — the row keeps the state its retained evidence already supports.
      const bytes = new Uint8Array(fs.readFileSync(path.join(ref.sourceDir, ref.file)));
      onBytes(entryId, bytes);
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };

  const subjects: V2RegenerationSubject[] = entries.map((entry) => ({
    id: entry.id,
    ...(entry.readiness === undefined ? {} : { readiness: entry.readiness }),
  }));

  // `subjects` stays out of the options object: C2b-1's option set is closed, and it refuses a name
  // it does not know rather than ignoring it.
  return { options: { rightsClassOf, retainedVerdictOf, readBytes }, subjects };
}

/**
 * Replays the run's own retained-record sidecar. Used to re-apply an already scanned population
 * without a second engine pass; the inventory digest must match, so records from another binding
 * are refused rather than mixed.
 */
function readRetainedRecords(file: string, inventory: CorpusV2InputInventory): readonly V2ScanEvidenceRecord[] {
  const records = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as V2ScanEvidenceRecord);
  if (records.length !== inventory.rows.length) {
    throw new Error(`retained records ${file}: ${records.length} records for ${inventory.rows.length} inventory rows`);
  }
  for (const record of records) {
    if (record.schemaVersion !== 'v2-scan-evidence-v1' || record.inventorySha256 !== inventory.inventorySha256) {
      throw new Error(`retained records ${file}: record for ${record.entryId} belongs to another inventory or schema`);
    }
  }
  return records;
}

/** The complete report is on disk; the terminal gets the census, without 11k plans. */
function execute(args: V2CliArguments): number {
  const inventory = inventoryOf(JSON.parse(fs.readFileSync(args.inventoryPath, 'utf8')));
  if (inventory === null) {
    throw new Error(`inventory ${args.inventoryPath} carries no corpus-v2-input-inventory-v1 record.`);
  }
  const formalBinding = args.mapPath === undefined ? undefined : formalCoverageBinding(inventory, args.inventoryPath, args.mapPath);

  const items = readPackagedItems(args.dataDir);
  const entries = items.map((item) => item.entry);
  let bodies = args.mapPath === undefined ? null : bodyFileByEntryId(loadOfficialBodyMap(args.mapPath, args.bodySources));
  if (args.hydratedDir !== undefined) bodies ??= new Map();
  if (bodies !== null && args.hydratedDir !== undefined) {
    const entryOf = new Map(entries.map((entry) => [entry.id, entry]));
    for (const row of inventory.rows) {
      if (row.bodySha256 === null || row.identityKind !== 'GITHUB') continue;
      const source = entryOf.get(row.entryId)?.source;
      if (!source?.repo || !source.commit || !source.path) continue;
      const file = hydrationCacheFileName(row.entryId, source.repo, source.commit, source.path);
      if (fs.existsSync(path.join(args.hydratedDir, file))) bodies.set(row.entryId, { file, sourceDir: args.hydratedDir });
    }
  }
  const derived = new Map<string, BodyDerivedMetadata>();
  const formalSamples: FormalNodeSample[] = [];
  const receiptOf = new Map(inventory.rows.map((row) => [row.entryId, row]));
  const entryOf = new Map(entries.map((entry) => [entry.id, entry]));
  if (receiptOf.size !== inventory.rows.length || entryOf.size !== entries.length
    || receiptOf.size !== entryOf.size || entries.some((entry) => !receiptOf.has(entry.id))) {
    throw new Error('Corpus inventory population is missing or duplicated.');
  }
  const inputs = producerInputs(entries, bodies, (entryId, bytes) => {
    const receipt = receiptOf.get(entryId)!;
    const entry = entryOf.get(entryId)!;
    derived.set(entryId, deriveCapturedBody(receipt, inventory.inventorySha256, publicSourceId(entry), bytes, entry.readiness?.analysis === 'unscanned'));
    if (formalBinding) formalSamples.push(projectFormalNodeSample(entryId, bytes));
  });
  // Replay and scan both capture each source once. Only derived metadata survives the call.
  for (const receipt of inventory.rows) {
    const entry = entryOf.get(receipt.entryId)!;
    if (receipt.bodySha256 === null) {
      derived.set(receipt.entryId, deriveCapturedBody(receipt, inventory.inventorySha256, publicSourceId(entry)));
    } else if (args.recordsPath !== undefined || receipt.status !== 'AVAILABLE') {
      const bytes = inputs.options.readBytes(receipt.entryId);
      if (bytes === undefined) throw new Error('Inventory-bound source body is unavailable; rerun maintenance with body sources.');
    }
  }
  const replayed = args.recordsPath === undefined ? undefined : readRetainedRecords(args.recordsPath, inventory);
  const records = replayed === undefined ? buildV2ScanEvidence(inventory, inputs.options) : normalizeV2Records(replayed, inventory).records;
  if (args.applyDataDir !== undefined && derived.size !== entries.length) {
    throw new Error('Every applied workflow needs verified source-derived metadata.');
  }
  const nodeSamples = [...derived.values()].flatMap((metadata) => metadata.sample ? [metadata.sample] : []);
  const applied = args.applyDataDir !== undefined && args.generatedAt !== undefined
    ? applyV2Regeneration({ items, inventory, records, nodeSamples, dataDir: args.dataDir,
        outputDir: args.applyDataDir, generatedAt: args.generatedAt, bodyDerived: derived })
    : undefined;
  // The report is computed from the same applied subjects the candidate was written from; a report
  // that disagrees with the published tree is a failure, not a footnote.
  const run = { ...runV2Regeneration({ inventory, subjects: applied?.subjects ?? inputs.subjects, records: applied?.records ?? records }),
    formalCoverage: formalBinding ? buildFormalNodeCoverage(inventory, formalSamples,
      formalCoverageBinding(inventory, args.inventoryPath, args.mapPath!), formalBinding) : null };
  if (applied !== undefined) {
    assertAppliedCensus(run.states, applied.states);
  }
  // The terminal gets the census, not 11k plans; the complete report is what `--out` writes.
  process.stdout.write(`${JSON.stringify({
    schemaVersion: run.schemaVersion,
    inventorySha256: run.inventorySha256,
    entryCount: run.entryCount,
    states: run.states,
    reasons: run.reasons,
    artifactGroups: run.artifactGroups,
    currentVerdicts: run.currentVerdicts,
  }, null, 2)}\n`);
  if (args.outDir === undefined) {
    process.stdout.write('Dry run: nothing written. Pass --out <dir> to write the report and the retained records.\n');
    return 0;
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  const reportPath = path.join(args.outDir, 'v2-regeneration-report.json');
  const recordsPath = path.join(args.outDir, 'v2-scan-evidence.ndjson');
  fs.writeFileSync(reportPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  fs.writeFileSync(recordsPath, records.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');
  process.stdout.write(`Report: ${reportPath}\nRetained records: ${recordsPath}\n`);
  if (applied !== undefined) process.stdout.write(`${JSON.stringify({ applied }, null, 2)}\n`);
  return 0;
}

/** The CLI entry point: 0 completed (dry or written), 2 malformed command line, 1 any other failure. */
export function runV2Cli(argv: readonly string[], cwd: string): number {
  let args: V2CliArguments;
  try {
    args = parseV2CliArguments(argv, cwd);
  } catch (error) {
    if (!(error instanceof V2CliUsageError)) throw error;
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }

  try {
    return execute(args);
  } catch (error) {
    process.stderr.write(`v2 regeneration: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runV2Cli(process.argv.slice(2), process.cwd());
}
