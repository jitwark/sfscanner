import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertAppliedCensus } from './v2-apply.js';
import { parseV2CliArguments, runV2Cli, V2CliUsageError } from './v2-cli.js';
import type { Q02FormalCoverageV1 } from './formal-node-coverage.js';

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const BODY = new TextEncoder().encode('{"nodes":[],"connections":{}}');
const BODY_FILE = 'official__1_one.json';

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-cli-'));
  scratchDirs.push(dir);
  return dir;
}

/** Every file under `root`, with its digest: the proof that a run did not mutate its inputs. */
function treeHashes(root: string): string[] {
  const hashes: string[] = [];
  for (const name of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!name.isFile()) continue;
    const file = path.join(name.parentPath, name.name);
    hashes.push(`${path.relative(root, file)} ${sha256(fs.readFileSync(file))}`);
  }
  return hashes.sort();
}

/** The committed-corpus shape `readPackagedItems` reads: one catalogue shard and its aligned chart shard. */
function writeCorpus(root: string): string {
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(dataDir, 'charts'), { recursive: true });
  const entries = [
    { id: 'entry-current', source: { kind: 'n8n_official', permalink: 'https://n8n.io/workflows/1' }, rights: { status: 'link_only' }, readiness: { analysis: 'derived' }, security: { scannerVersion: 'scanner-beta-1', grade: 'MEDIUM', analysisStatus: 'COMPLETE' } },
    { id: 'entry-ruled', source: { kind: 'github', repo: 'owner/repo', permalink: 'https://github.com/owner/repo' }, rights: { status: 'link_only' }, readiness: { analysis: 'unscanned' }, security: { scannerVersion: 'scanner-beta-1', grade: 'LOW', analysisStatus: 'COMPLETE' } },
  ];
  fs.writeFileSync(path.join(dataDir, 'catalogue-0.json'), JSON.stringify(entries), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'charts', 'chart-0.jsonl'), entries.map(() => '{}').join('\n'), 'utf8');
  return dataDir;
}

/** The `C1-real-inventory.json` shape: a report wrapping the inventory it was derived from. */
function writeInventory(root: string, body = BODY): string {
  const file = path.join(root, 'inventory.json');
  const inventory = {
    schemaVersion: 'corpus-v2-input-inventory-v1',
    counts: { AVAILABLE: 1, MISSING: 0, SOURCE_UNAVAILABLE: 1, UNPARSEABLE: 0, REJECTED: 0 },
    rows: [
      { entryId: 'entry-current', identityKind: 'OFFICIAL_TEMPLATE', status: 'AVAILABLE', bodySha256: sha256(body), byteLength: body.byteLength, sourceCommit: null, sourcePath: null, reasonCode: null },
      { entryId: 'entry-ruled', identityKind: 'GITHUB', status: 'SOURCE_UNAVAILABLE', bodySha256: null, byteLength: null, sourceCommit: 'dcb67e5b', sourcePath: null, reasonCode: 'RULING-1' },
    ],
    inventorySha256: 'a'.repeat(64),
  };
  fs.writeFileSync(file, JSON.stringify({ generatedFrom: 'map.json', entries: 2, sources: 2, inventory }, null, 2), 'utf8');
  return file;
}

/** A reconciled body map plus the one body it bound, so `--map`/`--bodies` can read real bytes. */
function writeBodyMap(root: string, body = BODY): { mapPath: string; sourceDir: string } {
  const sourceDir = path.join(root, 'bodies');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, BODY_FILE), body, 'utf8');
  const mapPath = path.join(root, 'map.json');
  fs.writeFileSync(mapPath, JSON.stringify({
    schemaVersion: 'official-body-map-v1',
    rows: [{ templateId: 1, entryId: 'entry-current', file: BODY_FILE, sourceDir, provenance: 'curated_official_folder' }],
    withoutBody: [],
    refusedBodies: [],
    orphanBodies: [],
    counts: {
      catalogueOfficial: 1, bodyFiles: 1, ignoredBodyFiles: 0, matched: 1, withoutBody: 0, refused: 0,
      shadowedBodyFiles: 0, orphanBodyFiles: 0, duplicateCatalogueTemplateIds: 0, duplicateBodyTemplateIds: 0,
      entriesWithoutTemplateId: 0, malformedBodyFileNames: 0,
    },
  }), 'utf8');
  return { mapPath, sourceDir };
}

/** The CLI's two streams, captured so a run prints nothing into the test output. */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { err.push(String(chunk)); return true; });
  return { stdout: () => out.join(''), stderr: () => err.join('') };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseV2CliArguments', () => {
  it('resolves the required inputs against the process cwd', () => {
    const args = parseV2CliArguments(['--data', 'data', '--inventory', 'docs/inventory.json'], 'C:/repo');

    expect(args).toEqual({
      dataDir: path.resolve('C:/repo', 'data'),
      inventoryPath: path.resolve('C:/repo', 'docs/inventory.json'),
      bodySources: [],
    });
  });

  it('parses the explicit output directory and the body sources', () => {
    const args = parseV2CliArguments(
      ['--data', 'data', '--inventory', 'i.json', '--out', 'staging', '--map', 'm.json', '--bodies', 'D:/bodies', '--bodies', 'D:/more'],
      'C:/repo',
    );

    expect(args.outDir).toBe(path.resolve('C:/repo', 'staging'));
    expect(args.mapPath).toBe(path.resolve('C:/repo', 'm.json'));
    expect(args.bodySources).toEqual([path.resolve('D:/bodies'), path.resolve('D:/more')]);
  });

  it('rejects an unknown option and never echoes a supplied value', () => {
    expect(() => parseV2CliArguments(['--data', 'data', '--inventory', 'secret-token.json', '--dat', 'x'], 'C:/repo'))
      .toThrow(/unknown option: --dat/);
    try {
      parseV2CliArguments(['--data', 'data', '--inventory', 'secret-token.json', '--dat', 'x'], 'C:/repo');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-token');
    }
    expect(() => parseV2CliArguments(['--data'], 'C:/repo')).toThrow(/--data requires a value/);
    expect(() => parseV2CliArguments(['--data', '--inventory', 'i.json'], 'C:/repo')).toThrow(/--data requires a value/);
    expect(() => parseV2CliArguments(['--data', 'a', '--data', 'b', '--inventory', 'i.json'], 'C:/repo'))
      .toThrow(/--data was given twice/);
  });

  it('requires the two inputs the run cannot guess and refuses an --out inside --data', () => {
    expect(() => parseV2CliArguments([], 'C:/repo')).toThrow(/--data is required/);
    expect(() => parseV2CliArguments(['--data', 'data'], 'C:/repo')).toThrow(/--inventory is required/);
    expect(() => parseV2CliArguments(['--data', 'data', '--inventory', 'i.json', '--out', 'data/nested'], 'C:/repo'))
      .toThrow(/--out must not be inside --data/);
    expect(() => parseV2CliArguments(['--data', 'data', '--inventory', 'i.json', '--map', 'm.json'], 'C:/repo'))
      .toThrow(/--map requires at least one --bodies/);
    expect(() => parseV2CliArguments(['--data', 'data', '--inventory', 'i.json', '--bodies', 'D:/bodies'], 'C:/repo'))
      .toThrow(/--bodies requires --map/);
    expect(new V2CliUsageError('x')).toBeInstanceOf(Error);
  });
});

describe('runV2Cli', () => {
  it('defaults to a dry run that writes nothing and mutates none of its inputs', () => {
    const root = scratch();
    writeCorpus(root);
    writeInventory(root);
    const before = treeHashes(root);
    const io = capture();

    expect(runV2Cli(['--data', 'data', '--inventory', 'inventory.json'], root)).toBe(0);

    expect(treeHashes(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, 'out'))).toBe(false);
    expect(fs.readdirSync(root).sort()).toEqual(['data', 'inventory.json']);
    const summary = JSON.parse(io.stdout().split('\nDry run:')[0] ?? '') as { states: Record<string, number>; entryCount: number };
    expect(summary.entryCount).toBe(2);
    expect(summary.states).toEqual({ CURRENT: 0, NO_RESULT: 0, HISTORICAL: 1, UNSCANNED: 0, SOURCE_UNAVAILABLE: 1 });
    expect(io.stdout()).toContain('Dry run: nothing written');
  });

  it('refuses --records with --apply-data when no body source can supply node coverage', () => {
    const root = scratch();
    writeCorpus(root);
    writeInventory(root);
    const io = capture();
    expect(runV2Cli(['--data', 'data', '--inventory', 'inventory.json', '--out', 'run'], root)).toBe(0);
    expect(runV2Cli([
      '--data', 'data', '--inventory', 'inventory.json', '--records', 'run/v2-scan-evidence.ndjson',
      '--apply-data', 'candidate', '--generated-at', '2026-10-20T00:00:00.000Z',
    ], root)).toBe(1);
    expect(io.stderr()).toContain('source body is unavailable');
    expect(fs.existsSync(path.join(root, 'candidate'))).toBe(false);
  });

  it('writes the report and the retained records to an explicit --out, byte-identically twice', () => {
    const root = scratch();
    writeCorpus(root);
    writeInventory(root);
    const io = capture();

    expect(runV2Cli(['--data', 'data', '--inventory', 'inventory.json', '--out', 'first'], root)).toBe(0);
    expect(runV2Cli(['--data', 'data', '--inventory', 'inventory.json', '--out', 'second'], root)).toBe(0);

    const read = (dir: string, file: string) => fs.readFileSync(path.join(root, dir, file), 'utf8');
    const report = JSON.parse(read('first', 'v2-regeneration-report.json')) as {
      schemaVersion: string;
      plans: { entryId: string }[];
      currentVerdicts: { count: number };
    };
    const records = read('first', 'v2-scan-evidence.ndjson').trim().split('\n').map((line) => JSON.parse(line) as { schemaVersion: string; entryId: string });

    expect(report.schemaVersion).toBe('v2-regeneration-run-v1');
    expect(report.plans.map((plan) => plan.entryId)).toEqual(['entry-current', 'entry-ruled']);
    expect(report.currentVerdicts).toEqual({ count: 0, producingIdentities: [] });
    expect(records.map((record) => record.entryId)).toEqual(['entry-current', 'entry-ruled']);
    expect(records.every((record) => record.schemaVersion === 'v2-scan-evidence-v1')).toBe(true);
    expect(read('second', 'v2-regeneration-report.json')).toBe(read('first', 'v2-regeneration-report.json'));
    expect(read('second', 'v2-scan-evidence.ndjson')).toBe(read('first', 'v2-scan-evidence.ndjson'));
    expect(io.stdout()).toContain(path.join(root, 'first', 'v2-regeneration-report.json'));
  });

  it('scans a bound body into a CURRENT plan carrying the body and result digests', () => {
    const root = scratch();
    writeCorpus(root);
    writeInventory(root);
    const { mapPath, sourceDir } = writeBodyMap(root);
    capture();

    expect(runV2Cli([
      '--data', 'data', '--inventory', 'inventory.json', '--out', 'out',
      '--map', path.relative(root, mapPath), '--bodies', sourceDir,
    ], root)).toBe(0);

    const report = JSON.parse(fs.readFileSync(path.join(root, 'out', 'v2-regeneration-report.json'), 'utf8')) as {
      plans: { entryId: string; state: string; bodySha256: string | null; assessment: { label: string } | null }[];
      currentVerdicts: { count: number; producingIdentities: string[] };
      formalCoverage: Q02FormalCoverageV1;
    };
    const current = report.plans.find((plan) => plan.entryId === 'entry-current');

    expect(current).toMatchObject({ state: 'CURRENT', bodySha256: sha256(BODY), assessment: { label: 'CURRENT' } });
    expect(report.currentVerdicts).toEqual({ count: 1, producingIdentities: ['2.0.0'] });
    expect(report.formalCoverage.schemaVersion).toBe('q02-formal-coverage-v1');
    expect(report.formalCoverage.counts.executableInstances).toBe(0);
    expect(report.formalCoverage.rates.reviewedExecutableInstances.ratio).toBeNull();
    expect(report.formalCoverage.binding.bodyMapSha256).toBe(sha256(fs.readFileSync(mapPath)));
    expect(report.formalCoverage.exclusions).toEqual([
      { entryId: 'entry-current', reason: 'NO_EXECUTABLE_NODE' }, { entryId: 'entry-ruled', reason: 'SOURCE_UNAVAILABLE' },
    ]);
    expect(runV2Cli([
      '--data', 'data', '--inventory', 'inventory.json', '--out', 'replay', '--records', 'out/v2-scan-evidence.ndjson',
      '--map', path.relative(root, mapPath), '--bodies', sourceDir,
    ], root)).toBe(0);
    const replay = JSON.parse(fs.readFileSync(path.join(root, 'replay', 'v2-regeneration-report.json'), 'utf8')) as { formalCoverage: Q02FormalCoverageV1 };
    expect(JSON.stringify(replay.formalCoverage)).toBe(JSON.stringify(report.formalCoverage));
  });

  it.each([false, true])('retains nonempty scan/replay and generation with resource refusal=%s', (overLimit) => {
    const root = scratch(); writeCorpus(root);
    const body = new TextEncoder().encode(JSON.stringify({ nodes: Array.from({ length: overLimit ? 5001 : 1 },
      () => overLimit ? { type: 'n8n-nodes-base.future', typeVersion: 1 }
        : { type: 'n8n-nodes-base.gmail', typeVersion: 2.2, parameters: { operation: 'send' } }), connections: {} }));
    writeInventory(root, body);
    const { sourceDir } = writeBodyMap(root, body); capture();
    const args = ['--data', 'data', '--inventory', 'inventory.json', '--map', 'map.json', '--bodies', sourceDir];
    expect(runV2Cli([...args, '--out', 'scan'], root)).toBe(0);
    expect(runV2Cli([...args, '--out', 'replay', '--records', 'scan/v2-scan-evidence.ndjson'], root)).toBe(0);
    const readReport = (dir: string) => JSON.parse(fs.readFileSync(path.join(root, dir, 'v2-regeneration-report.json'), 'utf8')) as {
      formalCoverage: Q02FormalCoverageV1; entryCount: number;
    };
    const report = readReport('scan');
    expect(report.entryCount).toBe(2);
    expect(readReport('replay').formalCoverage).toEqual(report.formalCoverage);
    expect(report.formalCoverage.status).toBe(overLimit ? 'INCOMPLETE' : 'COMPLETE');
    expect(report.formalCoverage.wholeCorpus.malformed).toBe(0);
    expect(report.formalCoverage.wholeCorpus.measurementUnknown).toBe(overLimit ? 1 : 0);
    expect(report.formalCoverage.rates.reviewedExecutableInstances.ratio).toBe(overLimit ? null : 1);
    expect(fs.readFileSync(path.join(root, 'scan/v2-scan-evidence.ndjson'), 'utf8').trim().split('\n')).toHaveLength(2);
  }, 20000);

  it('fails private measurement when the named body map changes during source capture', () => {
    const root = scratch(); writeCorpus(root); writeInventory(root);
    const { mapPath, sourceDir } = writeBodyMap(root); const io = capture();
    const original = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      const value = original(...args);
      if (String(args[0]) === path.join(sourceDir, BODY_FILE)) fs.appendFileSync(mapPath, ' ');
      return value;
    });
    expect(runV2Cli(['--data', 'data', '--inventory', 'inventory.json', '--map', 'map.json', '--bodies', sourceDir, '--out', 'out'], root)).toBe(1);
    expect(io.stderr()).toContain('binding mismatch');
    expect(fs.existsSync(path.join(root, 'out'))).toBe(false);
  });

  it('exits 2 on a malformed command line and 1 on an inventory it cannot read', () => {
    const root = scratch();
    writeCorpus(root);
    const io = capture();

    expect(runV2Cli(['--nope', 'secret'], root)).toBe(2);
    expect(io.stderr()).toContain('Usage:');
    expect(io.stderr()).not.toContain('secret');
    fs.writeFileSync(path.join(root, 'inventory.json'), JSON.stringify({ schemaVersion: 'corpus-v2-input-inventory-v2' }), 'utf8');
    expect(runV2Cli(['--data', 'data', '--inventory', 'inventory.json', '--out', 'out'], root)).toBe(1);
    expect(io.stderr()).toContain('carries no corpus-v2-input-inventory-v1 record');
    expect(fs.existsSync(path.join(root, 'out'))).toBe(false);
  });
});

describe('applied census agreement', () => {
  it('rejects a report that disagrees with the applied candidate', () => {
    const applied = { current: 1, noResult: 0, historical: 0, unscanned: 0, sourceUnavailable: 0 } as const;
    expect(() => assertAppliedCensus({ CURRENT: 1, NO_RESULT: 0, HISTORICAL: 0, UNSCANNED: 0, SOURCE_UNAVAILABLE: 0 }, applied)).not.toThrow();
    expect(() => assertAppliedCensus({ CURRENT: 2, NO_RESULT: 0, HISTORICAL: 0, UNSCANNED: 0, SOURCE_UNAVAILABLE: 0 }, applied)).toThrow(/disagrees/);
  });
});
