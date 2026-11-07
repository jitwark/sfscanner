import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { comparePackageTrees, runReproducibilityCheck } from './check-scanner-reproducibility.mjs';
import { requiredArtifactEntries } from './lib/scanner-packed-artifact.mjs';

const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

// Builds a throwaway tree from a relative-path -> content map, so each case states only its own difference.
function tree(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-repro-'));
  temporaryDirectories.push(root);
  for (const [relativePath, content] of Object.entries(files)) write(root, relativePath, content);
  return root;
}

const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');
const BUNDLE = 'bundle\n';

// Creating symlinks needs privileges on Windows (developer mode or elevation); record the reason and skip there.
function probeSymlinkSupport() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-repro-link-'));
  try {
    fs.symlinkSync('target.txt', path.join(directory, 'link.txt'));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.code ?? error.message };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const symlinkSupport = probeSymlinkSupport();
const symlinkCase = (context) => context.skip(!symlinkSupport.ok, `platform cannot create symlinks (${symlinkSupport.reason})`);

describe('comparePackageTrees', () => {
  it('reports ok for two identical trees', () => {
    const left = tree({ 'package/dist/main.js': BUNDLE, 'package/README.md': '# readme\n' });
    const right = tree({ 'package/dist/main.js': BUNDLE, 'package/README.md': '# readme\n' });
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.observations.join('\n')).toContain('left: 2 files');
  });

  it('fails when a path exists only in the left tree', () => {
    const left = tree({ 'package/dist/main.js': BUNDLE, 'package/dist/extra.js': 'only-left\n' });
    const right = tree({ 'package/dist/main.js': BUNDLE });
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['missing-from-right: package/dist/extra.js']);
  });

  it('fails when a path exists only in the right tree', () => {
    const left = tree({ 'package/dist/main.js': BUNDLE });
    const right = tree({ 'package/dist/main.js': BUNDLE, 'package/dist/extra.js': 'only-right\n' });
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['missing-from-left: package/dist/extra.js']);
  });

  it('fails when the same path holds different bytes', () => {
    const left = tree({ 'package/dist/main.js': 'first build\n' });
    const right = tree({ 'package/dist/main.js': 'second build\n' });
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['content-mismatch: package/dist/main.js']);
  });

  it('fails when a recorded path is missing from disk', () => {
    const left = tree({ 'package/dist/main.js': BUNDLE });
    const right = tree({ 'package/dist/main.js': BUNDLE });
    const expected = { 'package/dist/main.js': sha256(BUNDLE), 'package/dist/recorded.js': sha256('absent\n') };
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right, expected });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['missing-from-disk: package/dist/recorded.js']);
  });

  it('fails when disk holds a file the manifest does not record', () => {
    const left = tree({ 'package/dist/main.js': BUNDLE, 'package/dist/stray.js': 'stray\n' });
    const right = tree({ 'package/dist/main.js': BUNDLE });
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right, expected: { 'package/dist/main.js': sha256(BUNDLE) } });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['missing-from-right: package/dist/stray.js', 'unexpected-file: package/dist/stray.js']);
  });

  it('fails when a recorded sha256 does not match the bytes on disk', () => {
    const left = tree({ 'package/dist/main.js': BUNDLE });
    const right = tree({ 'package/dist/main.js': BUNDLE });
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right, expected: { 'package/dist/main.js': sha256('tampered\n') } });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['expected-sha256-mismatch: package/dist/main.js']);
  });

  it('fails when the manifest records a regular file but disk holds a symlink', (context) => {
    symlinkCase(context);
    const left = tree({ 'package/real.js': BUNDLE });
    const right = tree({ 'package/real.js': BUNDLE });
    fs.symlinkSync('real.js', path.join(left, 'package/link.js'));
    fs.symlinkSync('real.js', path.join(right, 'package/link.js'));
    const expected = { 'package/real.js': sha256(BUNDLE), 'package/link.js': sha256(BUNDLE) };
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right, expected });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['expected-regular-file-but-symlink: package/link.js']);
  });

  it('fails when the manifest records a symlink but disk holds a regular file', () => {
    const left = tree({ 'package/link.js': BUNDLE });
    const right = tree({ 'package/link.js': BUNDLE });
    const expected = { 'package/link.js': { kind: 'symlink', target: '../dist/real.js' } };
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right, expected });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['expected-symlink-but-regular-file: package/link.js']);
  });

  it('accepts symlinks that match the recorded target', (context) => {
    symlinkCase(context);
    const left = tree({ 'package/real.js': BUNDLE });
    const right = tree({ 'package/real.js': BUNDLE });
    fs.symlinkSync('real.js', path.join(left, 'package/link.js'));
    fs.symlinkSync('real.js', path.join(right, 'package/link.js'));
    const expected = { 'package/real.js': sha256(BUNDLE), 'package/link.js': { kind: 'symlink', target: 'real.js' } };
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right, expected });
    expect(result.ok).toBe(true);
    expect(result.observations.join('\n')).toContain('1 symlinks');
  });

  it('fails when two trees symlink the same path to different targets', (context) => {
    symlinkCase(context);
    const left = tree({ 'package/real.js': BUNDLE });
    const right = tree({ 'package/real.js': BUNDLE });
    fs.symlinkSync('real.js', path.join(left, 'package/link.js'));
    fs.symlinkSync('../real.js', path.join(right, 'package/link.js'));
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['symlink-target-mismatch: package/link.js']);
  });

  it('fails when one tree holds a symlink where the other holds a regular file', (context) => {
    symlinkCase(context);
    const left = tree();
    const right = tree({ 'entry.js': BUNDLE });
    fs.symlinkSync('real.js', path.join(left, 'entry.js'));
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['kind-mismatch: entry.js (left symlink, right file)']);
  });

  it('fails when the observed lockfile digest differs from the pinned source identity', () => {
    const lockfile = '{"lockfileVersion":3}\n';
    const left = tree({ 'package-lock.json': lockfile });
    const right = tree({ 'package-lock.json': lockfile });
    const sourceIdentity = { lockfilePath: path.join(left, 'package-lock.json'), pinnedLockfileSha256: 'a'.repeat(64) };
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right, sourceIdentity });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([`source-identity-mismatch: lockfile digest ${sha256(lockfile)} != pinned ${'a'.repeat(64)}`]);
    expect(result.observations.join('\n')).toContain(`lockfile sha256: ${sha256(lockfile)}`);
  });

  it('fails when the observed revision differs from the pinned revision', () => {
    const left = tree({ 'package/dist/main.js': BUNDLE });
    const right = tree({ 'package/dist/main.js': BUNDLE });
    const sourceIdentity = { pinnedRevision: 'c005c91', observedRevision: 'deadbeef' };
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right, sourceIdentity });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['source-identity-mismatch: revision deadbeef != pinned c005c91']);
  });

  it('accepts a matching pinned source identity and reports the observation', () => {
    const lockfile = '{"lockfileVersion":3}\n';
    const left = tree({ 'package-lock.json': lockfile });
    const right = tree({ 'package-lock.json': lockfile });
    const sourceIdentity = {
      pinnedRevision: 'c005c91',
      observedRevision: 'c005c91',
      lockfilePath: path.join(left, 'package-lock.json'),
      pinnedLockfileSha256: sha256(lockfile),
    };
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right, sourceIdentity });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.observations.join('\n')).toContain('revision: c005c91');
  });

  it('fails when a tree root is missing, without printing the operator profile path', () => {
    const left = tree();
    const right = tree({ 'package/dist/main.js': BUNDLE });
    const missing = comparePackageTrees({ leftRoot: path.join(left, 'absent'), rightRoot: right });
    expect(missing.ok).toBe(false);
    expect(missing.failures).toHaveLength(1);
    expect(missing.failures[0]).toMatch(/^tree-missing: left .*absent$/u);
    expect(missing.failures[0]).not.toContain(os.homedir());

    const otherSide = comparePackageTrees({ leftRoot: right, rightRoot: path.join(left, 'absent') });
    expect(otherSide.failures[0]).toContain('tree-missing: right');
  });

  it('fails when a required artifact entry is absent from the packed tree', () => {
    const left = tree({ 'package.json': '{}\n' });
    const right = tree({ 'package.json': '{}\n' });
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right, requiredPaths: ['package.json', 'dist/main.js'] });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['missing-required-entry: dist/main.js']);
  });

  it('fails when a packed tree holds a special file where a regular file is expected', (context) => {
    if (process.platform === 'win32') context.skip('creating a fifo needs mkfifo, which win32 does not provide');
    const left = tree({ 'package/real.js': BUNDLE });
    const right = tree({ 'package/real.js': BUNDLE });
    for (const root of [left, right]) execFileSync('mkfifo', [path.join(root, 'package/pipe')]);
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['not-a-regular-file: package/pipe']);
  });

  it('fails when the manifest records a regular file but disk holds a special file', (context) => {
    if (process.platform === 'win32') context.skip('creating a fifo needs mkfifo, which win32 does not provide');
    const left = tree({ 'package/real.js': BUNDLE });
    const right = tree({ 'package/real.js': BUNDLE });
    for (const root of [left, right]) execFileSync('mkfifo', [path.join(root, 'package/pipe')]);
    const expected = { 'package/real.js': sha256(BUNDLE), 'package/pipe': sha256('') };
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right, expected });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['not-a-regular-file: package/pipe']);
  });

  it('fails when a recorded symlink target differs from the packed tree', (context) => {
    symlinkCase(context);
    const left = tree({ 'package/real.js': BUNDLE });
    const right = tree({ 'package/real.js': BUNDLE });
    fs.symlinkSync('real.js', path.join(left, 'package/link.js'));
    fs.symlinkSync('real.js', path.join(right, 'package/link.js'));
    const result = comparePackageTrees({ leftRoot: left, rightRoot: right, expected: { 'package/link.js': { kind: 'symlink', target: 'other.js' } } });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['expected-symlink-target-mismatch: package/link.js']);
  });

  it('fails when the pinned lockfile cannot be read, without printing the operator profile path', () => {
    const left = tree({ 'package/dist/main.js': BUNDLE });
    const right = tree({ 'package/dist/main.js': BUNDLE });
    const result = comparePackageTrees({
      leftRoot: left,
      rightRoot: right,
      sourceIdentity: { lockfilePath: path.join(left, 'missing-lock.json'), pinnedLockfileSha256: 'a'.repeat(64) },
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('source-identity-mismatch: lockfile unreadable at');
    expect(result.failures[0]).not.toContain(os.homedir());
  });
});

describe('release-log redaction', () => {
  it('redacts the operator profile path when refusing an existing destination', () => {
    const root = tree();
    const existing = path.join(root, 'left');
    fs.mkdirSync(existing);
    let message = '';
    try {
      runReproducibilityCheck({ left: existing, right: path.join(root, 'right') });
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain('refusing to run');
    expect(message).toContain('left temporary directory already exists');
    expect(message).not.toContain(os.homedir());
  });

  it('redacts the operator profile path in npm failure text', () => {
    let message = '';
    try {
      runReproducibilityCheck({
        workspace: 'workspace-that-does-not-exist',
        npmSpawn: ({ args }) => {
          expect(args.slice(0, 2)).toEqual(['pack', '--workspace']);
          return {
            status: 1,
            stdout: '',
            stderr: `simulated npm failure at ${path.join(os.homedir(), 'pack')}`,
          };
        },
      });
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain('npm pack --workspace workspace-that-does-not-exist');
    expect(message).not.toContain(os.homedir());
  });
});

describe('requiredArtifactEntries', () => {
  it('fails when the packed artifact declares no built output', () => {
    const result = requiredArtifactEntries([{ path: 'package/package.json', kind: 'file' }, { path: 'package/README.md', kind: 'file' }]);
    expect(result.requiredPaths).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('missing-required-entry: dist/');
  });

  it('requires every dist entry of the packed artifact', () => {
    const result = requiredArtifactEntries([
      { path: 'package/package.json', kind: 'file' },
      { path: 'package/dist/main.js', kind: 'file' },
      { path: 'package/dist/main.js.map', kind: 'file' },
      { path: 'package/dist/v2/help.js', kind: 'symlink' },
    ]);
    expect(result.failures).toEqual([]);
    expect(result.requiredPaths).toEqual(['package.json', 'dist/main.js', 'dist/main.js.map']);
  });
});
