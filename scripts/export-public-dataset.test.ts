import { createHash } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The driver runs as a real child process here: the defect these tests guard
// is a malformed command line reaching the corpus and the bundle writer, and
// the only honest way to observe that is a bundle that must stay
// byte-identical and a default output tree that must stay untouched.
const repoRoot = path.resolve(import.meta.dirname, '..');
const driver = path.join(repoRoot, 'scripts', 'export-public-dataset.ts');
const SENTINEL_TEXT = '{"sentinel":"a malformed command line must not touch this bundle"}\n';

const runDriver = (argv: readonly string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', driver, ...argv], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const makeBundleFixture = () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-dataset-args-'));
  const bundleDir = path.join(tmpDir, 'bundle');
  const sentinel = path.join(bundleDir, 'ndjson', 'sentinel.ndjson');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, SENTINEL_TEXT);
  // `dataDir` is deliberately left absent: a driver that got past the parser
  // would fail with ENOENT instead of writing anything.
  return { tmpDir, bundleDir, dataDir: path.join(tmpDir, 'data') };
};

const expectUsageExit = (result: SpawnSyncReturns<string>, forbidden: readonly string[]) => {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Usage:');
  for (const value of forbidden) expect(result.stderr).not.toContain(value);
};

const expectBundleUntouched = (bundleDir: string) => {
  expect(fs.readFileSync(path.join(bundleDir, 'ndjson', 'sentinel.ndjson'), 'utf8')).toBe(SENTINEL_TEXT);
  expect(fs.readdirSync(bundleDir)).toEqual(['ndjson']);
  expect(fs.readdirSync(path.join(bundleDir, 'ndjson'))).toEqual(['sentinel.ndjson']);
};

/** Sorted `relative path + sha256` for every file under `dir`, or null if absent. */
const snapshotTree = (dir: string): string[] | null => {
  if (!fs.existsSync(dir)) return null;
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((relative) => fs.statSync(path.join(dir, relative)).isFile())
    .sort()
    .map(
      (relative) =>
        `${relative} ${createHash('sha256').update(fs.readFileSync(path.join(dir, relative))).digest('hex')}`,
    );
};

/** Sorted `relative path + content` for a small fixture tree; mtime is never compared. */
const snapshotFixtureTree = (dir: string): string[] =>
  fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((relative) => fs.statSync(path.join(dir, relative)).isFile())
    .sort()
    .map((relative) => `${relative}\n${fs.readFileSync(path.join(dir, relative), 'utf8')}`);

describe('export-public-dataset command line', () => {
  it('exits 2 with usage and leaves the whole temp tree untouched on an unknown option', () => {
    const { tmpDir, bundleDir, dataDir } = makeBundleFixture();
    try {
      const before = snapshotFixtureTree(tmpDir);

      const result = runDriver(['--data', dataDir, '--out', bundleDir, '--bogus']);

      expectUsageExit(result, [tmpDir]);
      expectBundleUntouched(bundleDir);
      expect(snapshotFixtureTree(tmpDir)).toEqual(before);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('exits 2 with usage and leaves the whole temp tree untouched on a non-ISO --generated-at', () => {
    const { tmpDir, bundleDir } = makeBundleFixture();
    try {
      const before = snapshotFixtureTree(tmpDir);

      const result = runDriver(['--out', bundleDir, '--generated-at', 'nope']);

      expectUsageExit(result, [tmpDir, 'nope']);
      expectBundleUntouched(bundleDir);
      expect(snapshotFixtureTree(tmpDir)).toEqual(before);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('slices argv: a well-formed command line reaches corpus I/O instead of the usage exit', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-dataset-argv-'));
    try {
      const before = snapshotFixtureTree(tmpDir);

      // Well-formed flags over an absent corpus: the parser must let this
      // through so the run dies in `readCatalogueEntries` (exit 1). A driver
      // that parsed the whole `process.argv` would reject argv[0] — the node
      // executable path — and exit 2 with the usage block instead.
      const result = runDriver(['--data', path.join(tmpDir, 'absent'), '--out', path.join(tmpDir, 'bundle')]);

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(2);
      expect(result.stdout).toContain('Reading corpus from');
      expect(result.stderr).not.toContain('Usage:');
      expect(result.stderr).toContain('no catalogue shards found');
      expect(snapshotFixtureTree(tmpDir)).toEqual(before);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('leaves the default output directory byte-identical when --out has no value', () => {
    const defaultOutput = path.join(repoRoot, 'outputs', 'public-dataset');
    const before = snapshotTree(defaultOutput);

    const result = runDriver(['--out']);

    expectUsageExit(result, []);
    const after = snapshotTree(defaultOutput);
    if (before === null) {
      // A clean checkout has no output tree (`.gitignore` ignores `outputs/`),
      // so the only claim left to make is that this run did not create one.
      expect(after).toBeNull();
      return;
    }
    expect(before.length).toBeGreaterThan(0);
    expect(after).toEqual(before);
  }, 120_000);
});
