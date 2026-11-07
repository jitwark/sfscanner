import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PRE_PROMOTION_MANIFEST, stageV2Runs } from './stage-v2-runs.js';
import { compareFileMaps } from './staged-file-map.js';
import { collectStagedFiles, manifestDigest } from './staged-bytes-sweep.js';

const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const BODY = '{"nodes":[],"connections":{}}';
const BODY_FILE = 'official__1_one.json';
const ENTRY_A = '0000000000000001';
const ENTRY_B = '0000000000000002';
const scratchDirs: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-v2-runs-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A miniature committed repository: the corpus shape `readPackagedItems` reads, its public mirror,
 * a C1-shaped inventory receipt, a body map with one bound body, and the approved-snapshot record
 * for that body directory. The snapshot's own digest is rebuilt here from the committed algorithm
 * (`inventoryDigest`, `scripts/lib/published-secret-input-inventory.mjs`); the gate re-derives and
 * verifies it, so a drifted fixture fails closed instead of passing.
 */
function fixtureRepo(): Readonly<{ root: string; bodiesDir: string; snapshotPath: string }> {
  const root = scratch();
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(dataDir, 'charts'), { recursive: true });
  const entries = [
    { id: ENTRY_A, source: { kind: 'n8n_official', permalink: 'https://fixture.invalid/n8n/1', templateId: 1, fetchedAt: '2026-10-17T00:00:00.000Z' }, rights: { status: 'link_only' }, readiness: { analysis: 'derived' }, security: { scannerVersion: 'scanner-beta-1', grade: 'MEDIUM', analysisStatus: 'COMPLETE' } },
    { id: ENTRY_B, source: { kind: 'github', repo: 'fixture/repository', commit: 'dcb67e5b', permalink: 'https://fixture.invalid/github/repository', fetchedAt: '2026-10-17T00:00:00.000Z' }, rights: { status: 'link_only' }, readiness: { analysis: 'unscanned' }, security: { scannerVersion: 'scanner-beta-1', grade: 'LOW', analysisStatus: 'COMPLETE' } },
  ];
  fs.writeFileSync(path.join(dataDir, 'catalogue-0.json'), JSON.stringify(entries), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'charts', 'chart-0.jsonl'), entries.map(() => '{}').join('\n'), 'utf8');
  fs.mkdirSync(path.join(root, 'app', 'public', 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'engine.ts'), '// the code whose bytes decide a run output\n', 'utf8');
  fs.writeFileSync(path.join(root, 'app', 'public', 'data', 'analytics.json'), '{"mirror":true}\n', 'utf8');

  fs.writeFileSync(path.join(root, 'inventory.json'), JSON.stringify({
    generatedFrom: 'map.json', entries: 2, sources: 2,
    inventory: {
      schemaVersion: 'corpus-v2-input-inventory-v1',
      counts: { AVAILABLE: 1, MISSING: 0, SOURCE_UNAVAILABLE: 1, UNPARSEABLE: 0, REJECTED: 0 },
      rows: [
        { entryId: ENTRY_A, identityKind: 'OFFICIAL_TEMPLATE', status: 'AVAILABLE', bodySha256: sha256(BODY), byteLength: BODY.length, sourceCommit: null, sourcePath: null, reasonCode: null },
        { entryId: ENTRY_B, identityKind: 'GITHUB', status: 'SOURCE_UNAVAILABLE', bodySha256: null, byteLength: null, sourceCommit: 'dcb67e5b', sourcePath: null, reasonCode: 'RULING-1' },
      ],
      inventorySha256: 'a'.repeat(64),
    },
  }, null, 2), 'utf8');

  const bodiesDir = path.join(root, 'bodies');
  fs.mkdirSync(bodiesDir, { recursive: true });
  fs.writeFileSync(path.join(bodiesDir, BODY_FILE), BODY, 'utf8');
  fs.writeFileSync(path.join(root, 'map.json'), JSON.stringify({
    schemaVersion: 'official-body-map-v1',
    rows: [{ templateId: 1, entryId: ENTRY_A, file: BODY_FILE, sourceDir: bodiesDir, provenance: 'curated_official_folder' }],
    withoutBody: [], refusedBodies: [], orphanBodies: [],
    counts: {
      catalogueOfficial: 1, bodyFiles: 1, ignoredBodyFiles: 0, matched: 1, withoutBody: 0, refused: 0,
      shadowedBodyFiles: 0, orphanBodyFiles: 0, duplicateCatalogueTemplateIds: 0, duplicateBodyTemplateIds: 0,
      entriesWithoutTemplateId: 0, malformedBodyFileNames: 0,
    },
  }), 'utf8');

  const names = fs.readdirSync(bodiesDir).filter((name) => /^official__\d+_.+\.json$/.test(name)).sort();
  const files = names.map((name) => {
    const bytes = fs.readFileSync(path.join(bodiesDir, name));
    return { name, bytes: bytes.byteLength, sha256: sha256(bytes) };
  });
  const snapshotPath = path.join(root, 'snapshot.json');
  fs.writeFileSync(snapshotPath, JSON.stringify({
    schemaVersion: 1,
    algorithm: 'sha256',
    inventoryDigest: `sha256:${sha256(JSON.stringify(files.map((file) => [file.name, file.bytes, file.sha256])))}`,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  }), 'utf8');
  return { root, bodiesDir, snapshotPath };
}

function options(root: string, bodiesDir: string, snapshotPath: string, stage = 'stage') {
  return {
    cwd: root, dataDir: 'data', inventoryPath: 'inventory.json', stageRoot: stage,
    generatedAt: '2026-10-17T00:00:00.000Z', sourceRevision: 'c005c9162bb28b35',
    mapPath: 'map.json', bodiesDirs: [bodiesDir], approvedSources: [{ snapshotPath, bodiesDir }], sourceTrees: ['src'],
  } as const;
}

describe('C3 staging', () => {
  it('stages two sibling runs, proves them byte-identical and passes every tripwire', { timeout: 15_000 }, () => {
    const { root, bodiesDir, snapshotPath } = fixtureRepo();
    const catalogueBefore = fs.readFileSync(path.join(root, 'data', 'catalogue-0.json'));
    const receipt = stageV2Runs(options(root, bodiesDir, snapshotPath));

    expect(receipt.schemaVersion).toBe('c3-v2-staging-receipt-v1');
    expect(receipt.runs.map((record) => record.outDir)).toEqual(['stage/run-a/data', 'stage/run-b/data']);
    for (const record of receipt.runs) {
      expect(record.exitCode).toBe(0);
      expect(record.files.map((file) => file.path)).toEqual(['v2-regeneration-report.json', 'v2-scan-evidence.ndjson']);
      expect(record.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
    }
    expect(receipt.comparison).toMatchObject({ identical: true, differences: [] });
    expect(receipt.comparison.files).toBe(2);
    expect(receipt.sweep.findings).toEqual([]);
    expect(receipt.sweep.positiveControl.ok).toBe(true);
    expect(receipt.credentialGate).toHaveLength(1);
    expect(receipt.credentialGate[0].exitCode).toBe(0);
    expect(receipt.tripwires).toEqual({
      stagedTwoRuns: true, byteIdentical: true, runFilesPresent: true, structuralSweepClean: true,
      sweepControlsDetected: true, credentialGateClean: true, sourceTreeStable: true, committedTreesUntouched: true,
    });
    expect(receipt.passed).toBe(true);
    expect(receipt.sourceTree.stable).toBe(true);
    expect(receipt.sourceTree.after).toHaveLength(2);
    expect(receipt.sourceTree.before.manifestDigest).toBe(receipt.sourceTree.after[0].manifestDigest);

    expect(fs.existsSync(path.join(root, 'stage', PRE_PROMOTION_MANIFEST))).toBe(true);
    expect(fs.existsSync(path.join(root, 'stage', 'staging-receipt.json'))).toBe(true);
    expect(receipt.committedTrees.before.map((tree) => tree.tree)).toEqual(['data', 'app/public/data']);
    expect(receipt.committedTrees.before[0].manifestDigest).toBe(receipt.committedTrees.after[0].manifestDigest);
    expect(fs.readFileSync(path.join(root, 'data', 'catalogue-0.json')).equals(catalogueBefore)).toBe(true);

    // The saved rollback identity has to be usable: re-deriving every digest from
    // disk against the written manifest is what a restore check would do.
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'stage', PRE_PROMOTION_MANIFEST), 'utf8')) as {
      trees: readonly { tree: string; manifestDigest: string; fileCount: number; files: readonly { path: string; sha256: string }[] }[];
    };
    for (const tree of manifest.trees) {
      const files = collectStagedFiles(path.join(root, tree.tree));
      expect(manifestDigest(files)).toBe(tree.manifestDigest);
      expect(files.map((file) => [file.path, file.sha256])).toEqual(tree.files.map((file) => [file.path, file.sha256]));
      expect(tree.fileCount).toBe(files.length);
    }
  });

  it('writes a byte-identical receipt for the same inputs staged again', { timeout: 15_000 }, () => {
    const { root, bodiesDir, snapshotPath } = fixtureRepo();
    stageV2Runs(options(root, bodiesDir, snapshotPath));
    const first = fs.readFileSync(path.join(root, 'stage', 'staging-receipt.json'));
    fs.rmSync(path.join(root, 'stage'), { recursive: true, force: true });
    stageV2Runs(options(root, bodiesDir, snapshotPath));
    const second = fs.readFileSync(path.join(root, 'stage', 'staging-receipt.json'));

    expect(second.equals(first)).toBe(true);
  });

  /**
   * The rollback tripwire: a run that changes a committed byte must not be able to report success.
   * The injected runner stands in for the v2 CLI so the mutation happens mid-run, deterministically.
   */
  it('fails the committed-trees tripwire when a run mutates the corpus', () => {
    const { root, bodiesDir, snapshotPath } = fixtureRepo();
    let mutated = false;
    const receipt = stageV2Runs(options(root, bodiesDir, snapshotPath), {
      runCommand: (command) => {
        if (command[1] === '--import') {
          const outDir = command[command.indexOf('--out') + 1];
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, 'v2-regeneration-report.json'), '{"schemaVersion":"v2-regeneration-run-v1"}\n');
          fs.writeFileSync(path.join(outDir, 'v2-scan-evidence.ndjson'), '');
          if (!mutated) {
            mutated = true;
            fs.appendFileSync(path.join(command[command.indexOf('--data') + 1], 'catalogue-0.json'), ' ');
            fs.appendFileSync(path.join(root, 'src', 'engine.ts'), ' ');
          }
        }
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });

    expect(receipt.tripwires.committedTreesUntouched).toBe(false);
    expect(receipt.tripwires.sourceTreeStable).toBe(false);
    expect(receipt.passed).toBe(false);
    expect(receipt.committedTrees.before[0].manifestDigest).not.toBe(receipt.committedTrees.after[0].manifestDigest);
  });

  it('refuses a stage root inside the corpus, an existing stage root and an unpaired map', () => {
    const { root, bodiesDir, snapshotPath } = fixtureRepo();
    expect(() => stageV2Runs({ ...options(root, bodiesDir, snapshotPath), stageRoot: path.join('data', 'stage') })).toThrow(/inside --data/);
    fs.mkdirSync(path.join(root, 'stage'));
    expect(() => stageV2Runs(options(root, bodiesDir, snapshotPath))).toThrow(/must not exist/);
    fs.rmSync(path.join(root, 'stage'), { recursive: true, force: true });
    expect(() => stageV2Runs({ ...options(root, bodiesDir, snapshotPath), bodiesDirs: [] })).toThrow(/given together/);
  });

  it('names every difference between two path+SHA-256 maps', () => {
    const same = compareFileMaps(
      [{ file: 'a', path: 'one.json', bytes: 1, sha256: 'a'.repeat(64) }],
      [{ file: 'a', path: 'one.json', bytes: 1, sha256: 'a'.repeat(64) }],
    );
    expect(same).toMatchObject({ identical: true, files: 1, differences: [] });
    const differing = compareFileMaps(
      [{ file: 'a', path: 'one.json', bytes: 1, sha256: 'a'.repeat(64) }],
      [{ file: 'a', path: 'one.json', bytes: 2, sha256: 'b'.repeat(64) }, { file: 'b', path: 'two.json', bytes: 2, sha256: 'c'.repeat(64) }],
    );
    expect(differing.identical).toBe(false);
    expect(differing.differences).toEqual(['content-differs one.json', 'only-in-right two.json']);
  });
});
