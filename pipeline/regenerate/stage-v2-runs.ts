/**
 * C3 staging: two fresh sibling run directories from the same pinned inputs, the byte comparison
 * that proves they agree, the staged-bytes sweep, and the proof that nothing was promoted.
 *
 * The root operation the plan reserves for C3 is run here and nowhere else: the accepted v2 CLI
 * (`pipeline/regenerate/v2-cli.ts`, C2b-3) writes each run into `<stage>/<run>/data`, and this module
 * never writes into `data/`, `app/public/data/` or any other committed tree. Before the first run it
 * inventories those trees and saves the pre-promotion rollback identity in the stage root; after the
 * runs it re-inventories them and fails closed on any byte that moved.
 *
 * The receipt (`staging-receipt.json`) is the operation's record, not a promotion: it pins the injected
 * `generatedAt` and `sourceRevision`, the lockfile and tool digests, the inventory and body-map
 * digests, the admitted identity tuple (rules/semantics/limits), the full path+SHA-256 map of both
 * runs, the comparison between them, the staged-bytes sweep with its positive control, and the
 * approved-snapshot credential gate over the exact staged bytes. Every list is sorted and every
 * timestamp is injected, so identical inputs produce a byte-identical receipt.
 *
 * Exit codes: 0 all tripwires passed, 1 a tripwire failed or a run failed, 2 malformed command line.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { ADMITTED_V2_SCAN_IDENTITY } from '../scan/v2-corpus-adapter.js';
import { V2_REGENERATION_RUN_SCHEMA_VERSION } from './run-v2-regeneration.js';
import {
  collectStagedFiles, manifestDigest, sha256Hex, sweepStagedBytes, STAGED_BYTES_SWEEP_SCHEMA_VERSION,
  type StagedFile, type SweepSummary,
} from './staged-bytes-sweep.js';
import { compareFileMaps, pinSourceTrees, type SourcePin } from './staged-file-map.js';

export const STAGING_RECEIPT_SCHEMA_VERSION = 'c3-v2-staging-receipt-v1' as const;
export const PRE_PROMOTION_MANIFEST = 'pre-promotion-inventory.json';

export type ApprovedBodySource = Readonly<{ snapshotPath: string; bodiesDir: string }>;
export type CommandResult = Readonly<{ exitCode: number | null; stdout: string; stderr: string }>;
export type StageDeps = Readonly<{ runCommand?: (command: string[], cwd: string) => CommandResult }>;
export type TreeInventory = Readonly<{ tree: string; fileCount: number; totalBytes: number; manifestDigest: string; files: readonly StagedFile[] }>; // one committed tree before/after
export type RunRecord = Readonly<{ name: string; outDir: string; command: readonly string[]; exitCode: number; files: readonly StagedFile[]; manifestDigest: string; census: Readonly<Record<string, unknown>> }>;
export type GateRecord = Readonly<{ snapshot: string; bodiesDir: string; exitCode: number; summary: Readonly<Record<string, unknown>>; stderrTail: string }>;
export type StageV2RunsOptions = Readonly<{
  cwd: string; dataDir: string; inventoryPath: string; stageRoot: string; generatedAt: string; sourceRevision: string;
  mapPath?: string; bodiesDirs?: readonly string[]; approvedSources?: readonly ApprovedBodySource[];
  committedTrees?: readonly string[]; runNames?: readonly string[]; sourceTrees?: readonly string[];
}>;
export type StagingReceipt = Readonly<{
  schemaVersion: typeof STAGING_RECEIPT_SCHEMA_VERSION; generatedAt: string; sourceRevision: string;
  toolchain: Readonly<Record<string, unknown>>; inputs: Readonly<Record<string, unknown>>; sweep: SweepSummary;
  runs: readonly RunRecord[]; credentialGate: readonly GateRecord[];
  comparison: Readonly<{ files: number; bytes: number; identical: boolean; differences: readonly string[] }>;
  sourceTree: Readonly<{ roots: readonly string[]; before: SourcePin; after: readonly SourcePin[]; stable: boolean }>;
  committedTrees: Readonly<{ manifest: string; before: readonly TreeInventory[]; after: readonly TreeInventory[]; untouched: boolean }>;
  tripwires: Readonly<Record<string, boolean>>; passed: boolean;
}>;

const MODULE_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..'); // where node_modules/tsx resolves; children run here
/** The source trees whose bytes decide a run's output; the writer itself included. */
const DEFAULT_SOURCE_TREES = Object.freeze(['packages/scanner-core/src', 'packages/scanner-cli/src', 'contracts', 'pipeline/scan', 'pipeline/regenerate']);
/** Paths are recorded project-relative when they are inside the project, absolute otherwise. */
function display(cwd: string, target: string): string {
  const relative = path.relative(cwd, target).replace(/\\/g, '/');
  return relative === '' || relative.startsWith('..') ? target.replace(/\\/g, '/') : relative;
}

function treeInventory(cwd: string, tree: string): TreeInventory {
  const files = collectStagedFiles(tree);
  let totalBytes = 0;
  for (const file of files) totalBytes += file.bytes;
  return { tree: display(cwd, tree), fileCount: files.length, totalBytes, manifestDigest: manifestDigest(files), files };
} // before/after forms are compared by their whole manifest, not one size or count

function runCommandDefault(command: string[], cwd: string): CommandResult {
  const result = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function fileDigest(file: string): Readonly<{ file: string; sha256: string }> | null {
  return fs.existsSync(file) ? { file: file.replace(/\\/g, '/'), sha256: sha256Hex(fs.readFileSync(file)) } : null;
}

export function stageV2Runs(options: StageV2RunsOptions, deps: StageDeps = {}): StagingReceipt {
  const cwd = path.resolve(options.cwd);
  const dataDir = path.resolve(cwd, options.dataDir);
  const inventoryPath = path.resolve(cwd, options.inventoryPath);
  const stageRoot = path.resolve(cwd, options.stageRoot);
  const trees = (options.committedTrees ?? ['data', 'app/public/data']).map((tree) => path.resolve(cwd, tree));
  const runNames = options.runNames ?? ['run-a', 'run-b'];
  const mapPath = options.mapPath === undefined ? undefined : path.resolve(cwd, options.mapPath);
  const bodiesDirs = (options.bodiesDirs ?? []).map((dir) => path.resolve(cwd, dir));
  const approvedSources = options.approvedSources ?? [];
  const run = deps.runCommand ?? runCommandDefault;
  const sourceTrees = options.sourceTrees === undefined
    ? DEFAULT_SOURCE_TREES.map((root) => path.resolve(REPO_ROOT, root))
    : options.sourceTrees.map((root) => path.resolve(cwd, root));

  if (runNames.length !== 2) throw new Error('exactly two run directories are staged: the comparison needs a pair');
  if (stageRoot === dataDir || stageRoot.startsWith(`${dataDir}${path.sep}`)) throw new Error('--stage must not be inside --data: staged bytes are never written into the corpus');
  for (const tree of trees) if (stageRoot === tree || stageRoot.startsWith(`${tree}${path.sep}`)) throw new Error(`--stage must not be inside the committed tree ${display(cwd, tree)}`);
  if (fs.existsSync(stageRoot)) throw new Error("--stage must not exist: a run stages into fresh directories, never over an old run's bytes");
  if (!fs.existsSync(inventoryPath)) throw new Error(`--inventory not found: ${display(cwd, inventoryPath)}`);
  if ((mapPath === undefined) !== (bodiesDirs.length === 0)) throw new Error('--map and at least one --bodies are given together');
  for (const source of approvedSources) {
    if (!fs.existsSync(source.snapshotPath)) throw new Error(`approved snapshot not found: ${source.snapshotPath}`);
    if (!fs.existsSync(source.bodiesDir)) throw new Error(`approved body directory not found: ${source.bodiesDir}`);
  } // fail before any run, so a partial staging never impersonates an approved one

  const before = trees.map((tree) => treeInventory(cwd, tree));
  const sourceBefore = pinSourceTrees(sourceTrees);
  const sourcePins: SourcePin[] = [];
  fs.mkdirSync(stageRoot, { recursive: true });
  fs.writeFileSync(path.join(stageRoot, PRE_PROMOTION_MANIFEST), `${JSON.stringify({ schemaVersion: 'c3-pre-promotion-inventory-v1', generatedAt: options.generatedAt, trees: before }, null, 2)}\n`, 'utf8');

  const runs: RunRecord[] = runNames.map((name) => {
    const outDir = path.join(stageRoot, name, 'data');
    const command = [
      process.execPath, '--import', 'tsx', 'pipeline/regenerate/v2-cli.ts', '--data', display(REPO_ROOT, dataDir),
      '--inventory', display(REPO_ROOT, inventoryPath), '--out', display(REPO_ROOT, outDir),
      ...(mapPath === undefined ? [] : ['--map', display(REPO_ROOT, mapPath), ...bodiesDirs.flatMap((dir) => ['--bodies', display(REPO_ROOT, dir)])]),
    ];
    const result = run(command, REPO_ROOT);
    if (result.exitCode !== 0) throw new Error(`v2 run ${name} exited ${String(result.exitCode)}: ${result.stderr.trim().split('\n').slice(-2).join(' ')}`);
    sourcePins.push(pinSourceTrees(sourceTrees));
    const files = collectStagedFiles(outDir);
    const report = JSON.parse(fs.readFileSync(path.join(outDir, 'v2-regeneration-report.json'), 'utf8')) as Record<string, unknown>;
    const { schemaVersion, inventorySha256, entryCount, states, reasons, currentVerdicts } = report;
    return {
      name, outDir: display(cwd, outDir), command: Object.freeze(command), exitCode: result.exitCode, files,
      manifestDigest: manifestDigest(files), census: Object.freeze({ schemaVersion, inventorySha256, entryCount, states, reasons, currentVerdicts }),
    };
  });

  const comparison = compareFileMaps(runs[0].files, runs[1].files);
  const sweep = sweepStagedBytes({
    roots: runs.map((record) => ({ label: record.name, dir: path.join(cwd, record.outDir) })),
    privateRoots: [inventoryPath, ...(mapPath === undefined ? [] : [mapPath]), ...bodiesDirs, ...approvedSources.flatMap((source) => [source.snapshotPath, source.bodiesDir]), stageRoot],
  });

  const credentialGate: GateRecord[] = approvedSources.map((source) => {
    const command = [
      process.execPath, path.join(REPO_ROOT, 'scripts', 'check-published-secret-leak.mjs'), '--bodies', source.bodiesDir,
      '--snapshot', source.snapshotPath, '--artifacts', runs.map((record) => path.join(cwd, record.outDir)).join(';'), '--json',
    ];
    const result = run(command, REPO_ROOT);
    let summary: Record<string, unknown>;
    try { summary = JSON.parse(result.stdout) as Record<string, unknown>; } catch { summary = { unparsable: true }; }
    return {
      snapshot: display(cwd, source.snapshotPath), bodiesDir: display(cwd, source.bodiesDir),
      exitCode: result.exitCode ?? -1, summary: Object.freeze(summary), stderrTail: result.stderr.trim().split('\n').slice(-1).join(''),
    };
  });

  const sourceStable = sourcePins.every((pin) => pin.manifestDigest === sourceBefore.manifestDigest);
  const after = trees.map((tree) => treeInventory(cwd, tree));
  const untouched = before.every((inventory, index) => inventory.manifestDigest === after[index].manifestDigest);
  const tripwires: Record<string, boolean> = {
    stagedTwoRuns: runs.length === 2, byteIdentical: comparison.identical,
    runFilesPresent: runs.every((record) => ['v2-regeneration-report.json', 'v2-scan-evidence.ndjson'].every((name) => record.files.some((file) => file.path === name))),
    structuralSweepClean: sweep.findings.length === 0, sweepControlsDetected: sweep.positiveControl.ok,
    credentialGateClean: credentialGate.length > 0 && credentialGate.every((gate) => gate.exitCode === 0), sourceTreeStable: sourceStable, committedTreesUntouched: untouched,
  };
  const passed = Object.values(tripwires).every(Boolean);
  const receipt: StagingReceipt = {
    schemaVersion: STAGING_RECEIPT_SCHEMA_VERSION, generatedAt: options.generatedAt, sourceRevision: options.sourceRevision,
    toolchain: Object.freeze({
      node: process.version, writerSchema: V2_REGENERATION_RUN_SCHEMA_VERSION, sweepSchema: STAGED_BYTES_SWEEP_SCHEMA_VERSION,
      lockfile: fileDigest(path.join(cwd, 'package-lock.json')),
      sweepTool: fileDigest(path.join(MODULE_DIR, 'staged-bytes-sweep.ts')),
      gateTool: fileDigest(path.join(REPO_ROOT, 'scripts', 'check-published-secret-leak.mjs')),
    }),
    inputs: Object.freeze({
      corpus: display(cwd, dataDir), bodyDirectories: bodiesDirs.map((dir) => display(cwd, dir)),
      inventory: { file: display(cwd, inventoryPath), sha256: sha256Hex(fs.readFileSync(inventoryPath)) },
      sourceMapping: mapPath === undefined ? null : { file: display(cwd, mapPath), sha256: sha256Hex(fs.readFileSync(mapPath)) },
      admittedIdentity: ADMITTED_V2_SCAN_IDENTITY,
    }),
    runs, comparison, sweep, credentialGate,
    sourceTree: { roots: sourceTrees.map((root) => display(cwd, root)), before: sourceBefore, after: sourcePins, stable: sourceStable },
    committedTrees: { manifest: PRE_PROMOTION_MANIFEST, before, after, untouched },
    tripwires: Object.freeze(tripwires), passed,
  };
  fs.writeFileSync(path.join(stageRoot, 'staging-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return receipt;
}

const ALLOWED: Readonly<Record<string, true>> = Object.freeze({
  '--data': true, '--inventory': true, '--stage': true, '--generated-at': true, '--source-revision': true,
  '--map': true, '--bodies': true, '--approved': true, '--committed-tree': true,
});
const USAGE = Object.freeze([
  'Usage: node --import tsx pipeline/regenerate/stage-v2-runs.ts --data <dir> --inventory <file> --stage <fresh-dir> --generated-at <iso> --source-revision <rev>',
  '        [--map <file> --bodies <dir> ...] [--approved <snapshot>=<bodiesDir> ...] [--committed-tree <dir> ...]',
  '  --stage <dir>         fresh directory for both sibling runs and the receipt; never committed data',
  '  --generated-at <iso>  injected timestamp pinned in the receipt (no clock is read)',
  '  --approved <s>=<b>    an approved raw input receipt and the body directory it binds (repeatable)',
].join('\n'));

export function runStageCli(argv: readonly string[], cwd: string): number {
  const values = new Map<string, string[]>();
  let parsed: StageV2RunsOptions;
  try {
    for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index];
      const value = argv[index + 1];
      if (ALLOWED[flag] === undefined || value === undefined || value.startsWith('--')) throw new Error(`unknown or valueless option: ${/^--[a-z][a-z0-9-]{0,61}$/.test(flag) ? flag : '(a bare argument)'}`);
      values.set(flag, [...(values.get(flag) ?? []), value]);
      index += 1;
    }
    const required = (flag: string): string => {
      const found = values.get(flag)?.[0];
      if (found === undefined) throw new Error(`${flag} is required: the receipt pins it rather than guessing`);
      return found;
    };
    parsed = {
      cwd,
      dataDir: required('--data'), inventoryPath: required('--inventory'), stageRoot: required('--stage'),
      generatedAt: required('--generated-at'), sourceRevision: required('--source-revision'),
      ...(values.get('--map')?.[0] === undefined ? {} : { mapPath: values.get('--map')?.[0] as string }),
      ...(values.get('--bodies') === undefined ? {} : { bodiesDirs: values.get('--bodies') as string[] }),
      ...(values.get('--committed-tree') === undefined ? {} : { committedTrees: values.get('--committed-tree') as string[] }), // repeatable
      approvedSources: (values.get('--approved') ?? []).map((pair) => {
        const separator = pair.indexOf('=');
        if (separator <= 0) throw new Error('--approved must read <snapshot>=<bodiesDir>');
        return { snapshotPath: path.resolve(cwd, pair.slice(0, separator)), bodiesDir: path.resolve(cwd, pair.slice(separator + 1)) };
      }),
    };
  } catch (error) {
    process.stderr.write(`C3 staging: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }
  try {
    const receipt = stageV2Runs(parsed);
    process.stdout.write(`${JSON.stringify({ passed: receipt.passed, tripwires: receipt.tripwires, receipt: 'staging-receipt.json' }, null, 2)}\n`);
    return receipt.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`C3 staging failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runStageCli(process.argv.slice(2), process.cwd());
}
