import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractPackedTarball, readGzipMtime, readPackedEntries, requiredArtifactEntries } from './lib/scanner-packed-artifact.mjs';

/**
 * Scanner package reproducibility check: a pure tree comparator plus a CLI wrapper that performs two
 * isolated `npm pack --workspace sfscanner` runs into two fresh temporary directories, extracts both
 * tarballs, and compares their sorted path + SHA-256 maps, an optional recorded manifest, and the
 * tarball bytes. The comparator's failure vocabulary is documented in
 * docs/audit/2026-10-17-remediation/E1c-report.md.
 */
export class ReproducibilityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReproducibilityError';
    this.code = 'REPRODUCIBILITY_SETUP';
  }
}

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
// Release logs must not carry the operator's profile path, so `C:\Users\<name>` becomes `~`.
const redact = (text) => text.replaceAll(os.homedir(), '~');

function walkTree(root, side, failures) {
  const entries = new Map();
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    failures.push(redact(`tree-missing: ${side} ${root}`));
    return entries;
  }
  const pending = [''];
  while (pending.length > 0) {
    const relativeDirectory = pending.shift();
    const absoluteDirectory = relativeDirectory === '' ? root : path.join(root, relativeDirectory);
    const dirents = fs.readdirSync(absoluteDirectory, { withFileTypes: true }).sort((left, right) => compare(left.name, right.name));
    for (const dirent of dirents) {
      const relative = relativeDirectory === '' ? dirent.name : `${relativeDirectory}/${dirent.name}`;
      const absolute = path.join(absoluteDirectory, dirent.name);
      const lstat = fs.lstatSync(absolute);
      if (lstat.isSymbolicLink()) entries.set(relative, { kind: 'symlink', target: fs.readlinkSync(absolute) });
      else if (lstat.isDirectory()) pending.push(relative);
      else if (lstat.isFile()) entries.set(relative, { kind: 'file', ...digestFile(absolute) });
      else entries.set(relative, { kind: 'other' });
    }
  }
  return entries;
}

function digestFile(absolute) {
  const bytes = fs.readFileSync(absolute);
  return { sha256: sha256Hex(bytes), bytes: bytes.length };
}

function describeTree(side, entries) {
  const all = [...entries.values()];
  const files = all.filter(({ kind }) => kind === 'file');
  return `${side}: ${files.length} files, ${all.length - files.length} symlinks or specials, ${files.reduce((total, { bytes }) => total + bytes, 0)} bytes`;
}

/** Compares two extracted trees, an optional `relative path -> sha256 | { kind: 'symlink', target }` manifest, `requiredPaths` (entries that must exist), and source identity. */
export function comparePackageTrees({ leftRoot, rightRoot, expected, requiredPaths, sourceIdentity } = {}) {
  if (typeof leftRoot !== 'string' || typeof rightRoot !== 'string') throw new ReproducibilityError('leftRoot and rightRoot are required');
  const failures = [];
  const observations = [];
  const trees = { left: walkTree(leftRoot, 'left', failures), right: walkTree(rightRoot, 'right', failures) };
  observations.push(describeTree('left', trees.left), describeTree('right', trees.right));
  // A missing root already failed; comparing its empty map would only add misleading floods.
  if (!failures.some((failure) => failure.startsWith('tree-missing:'))) {
    for (const [relative, left] of trees.left) {
      const right = trees.right.get(relative);
      if (!right) failures.push(`missing-from-right: ${relative}`);
      else if (left.kind !== right.kind) failures.push(`kind-mismatch: ${relative} (left ${left.kind}, right ${right.kind})`);
      else if (left.kind === 'other') failures.push(`not-a-regular-file: ${relative}`);
      else if (left.kind === 'symlink') {
        if (left.target !== right.target) failures.push(`symlink-target-mismatch: ${relative}`);
      } else if (left.sha256 !== right.sha256) failures.push(`content-mismatch: ${relative}`);
    }
    for (const relative of trees.right.keys()) if (!trees.left.has(relative)) failures.push(`missing-from-left: ${relative}`);
  }
  if (requiredPaths?.length > 0) observations.push(`required artifact entries: ${requiredPaths.length} (package.json plus the built dist/ files)`);
  for (const relative of requiredPaths ?? []) {
    if (!trees.left.has(relative) || !trees.right.has(relative)) failures.push(`missing-required-entry: ${relative}`);
  }
  if (expected) {
    observations.push(`recorded manifest: ${Object.keys(expected).length} entries`);
    for (const relative of Object.keys(expected).sort(compare)) {
      const recorded = typeof expected[relative] === 'string' ? { kind: 'file', sha256: expected[relative] } : expected[relative];
      const wantsSymlink = recorded.kind === 'symlink';
      for (const side of ['left', 'right']) {
        const found = trees[side].get(relative);
        if (!found) failures.push(`missing-from-disk: ${relative}`);
        else if (wantsSymlink && found.kind !== 'symlink') failures.push(`expected-symlink-but-regular-file: ${relative}`);
        else if (wantsSymlink && recorded.target && found.target !== recorded.target) failures.push(`expected-symlink-target-mismatch: ${relative}`);
        else if (!wantsSymlink && found.kind === 'symlink') failures.push(`expected-regular-file-but-symlink: ${relative}`);
        else if (!wantsSymlink && found.kind !== 'file') failures.push(`not-a-regular-file: ${relative}`);
        else if (recorded.sha256 && found.sha256 !== recorded.sha256) failures.push(`expected-sha256-mismatch: ${relative}`);
      }
    }
    for (const side of ['left', 'right']) {
      for (const relative of trees[side].keys()) if (!(relative in expected)) failures.push(`unexpected-file: ${relative}`);
    }
  }
  if (sourceIdentity) {
    const { pinnedRevision, observedRevision, lockfilePath, pinnedLockfileSha256 } = sourceIdentity;
    if (observedRevision || pinnedRevision) {
      if (pinnedRevision && observedRevision && pinnedRevision !== observedRevision) failures.push(`source-identity-mismatch: revision ${observedRevision} != pinned ${pinnedRevision}`);
      else observations.push(`revision: ${observedRevision ?? pinnedRevision}`);
    }
    if (lockfilePath) {
      let digest = null;
      try {
        digest = sha256Hex(fs.readFileSync(lockfilePath));
      } catch {
        failures.push(redact(`source-identity-mismatch: lockfile unreadable at ${lockfilePath}`));
      }
      if (digest !== null) {
        observations.push(`lockfile sha256: ${digest}`);
        if (pinnedLockfileSha256 && digest !== pinnedLockfileSha256) failures.push(`source-identity-mismatch: lockfile digest ${digest} != pinned ${pinnedLockfileSha256}`);
      }
    }
  }
  const unique = [...new Set(failures)].sort(compare);
  return { ok: unique.length === 0, failures: unique, observations };
}

function spawnNpm({ npmCli, args, cwd }) {
  return spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

// Prefers the npm running this script, then the npm shipped with this Node install; never a PATH guess.
function runNpm(args, { cwd }, spawn = spawnNpm) {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const candidates = [process.env.npm_execpath, fs.existsSync(npmCli) ? npmCli : null].filter(Boolean);
  if (candidates.length === 0) throw new ReproducibilityError('cannot locate npm: run this check through npm or with a node installation that bundles npm');
  let last;
  for (const candidate of candidates) {
    const result = spawn({ npmCli: candidate, args, cwd });
    if (!result.error && result.status === 0) return result;
    last = result;
  }
  throw new ReproducibilityError(redact(`npm ${args.join(' ')} failed: ${(last?.stderr ?? last?.error?.message ?? 'unknown error').trim().slice(0, 400)}`));
}

const gitValue = (root, args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

/**
 * Packs the workspace twice into two fresh temporary directories and compares the results. Refuses to
 * run when either destination already exists, and removes both afterwards unless
 * `keepTemporaryDirectories` is set.
 */
export function runReproducibilityCheck({ rootDirectory, workspace = 'sfscanner', left, right, revision, lockfileSha256, expectedPath, keepTemporaryDirectories = false, npmSpawn = spawnNpm } = {}) {
  const root = path.resolve(rootDirectory ?? process.cwd());
  const requested = { left: left && path.resolve(left), right: right && path.resolve(right) };
  for (const side of ['left', 'right']) {
    if (requested[side] && fs.existsSync(requested[side])) throw new ReproducibilityError(redact(`refusing to run: the ${side} temporary directory already exists (${requested[side]})`));
  }
  const parent = requested.left && requested.right ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-repro-'));
  const directories = { left: requested.left ?? path.join(parent, 'left'), right: requested.right ?? path.join(parent, 'right') };
  const created = [];
  for (const side of ['left', 'right']) {
    fs.mkdirSync(directories[side], { recursive: true });
    created.push(directories[side]);
  }
  const observedRevision = gitValue(root, ['rev-parse', 'HEAD']);
  const dirtyPaths = gitValue(root, ['status', '--porcelain']);
  const summary = { ok: false, failures: [], observations: [], tarballs: {}, roots: { ...directories }, temporaryRoot: parent, kept: keepTemporaryDirectories };
  summary.observations.push(
    `git revision: ${observedRevision ?? 'unavailable'} (both packs run in one working tree: isolation is by pack destination, not by checkout)`,
    `working tree: ${dirtyPaths === null ? 'unknown' : dirtyPaths.split('\n').filter((line) => line !== '').length} changed or untracked paths`,
  );
  try {
    const packs = {};
    for (const side of ['left', 'right']) {
      const packed = JSON.parse(runNpm(['pack', '--workspace', workspace, '--json', '--pack-destination', directories[side]], { cwd: root }, npmSpawn).stdout)[0];
      const tarballPath = path.join(directories[side], packed.filename);
      const bytes = fs.readFileSync(tarballPath);
      const tree = path.join(directories[side], 'tree');
      fs.mkdirSync(tree);
      const entries = readPackedEntries(tarballPath);
      const mtimes = entries.map(({ mtime }) => mtime);
      const extracted = extractPackedTarball({ tarballPath, destination: tree });
      packs[side] = {
        filename: packed.filename, bytes: bytes.length, sha256: sha256Hex(bytes), shasum: packed.shasum, entries: entries.length,
        gzipMtime: readGzipMtime(tarballPath), mtimeRange: mtimes.length > 0 ? [Math.min(...mtimes), Math.max(...mtimes)] : [], extracted, tree, listing: entries,
      };
      summary.tarballs[side] = packs[side];
      summary.observations.push(
        `${side} tarball: ${packed.filename} sha256=${packs[side].sha256} bytes=${bytes.length} entries=${entries.length} (npm shasum ${packed.shasum}, npm reported ${packed.entryCount ?? packed.files?.length ?? 'unknown'} entries) gzip-mtime=${packs[side].gzipMtime}`,
        `${side}: ${extracted.files} extracted files, ${extracted.symlinks} symlinks, ${extracted.refused.length} refused paths, entry mtimes ${JSON.stringify(packs[side].mtimeRange)} (uid/gid/mode are not compared)`,
      );
    }
    const expected = expectedPath
      ? JSON.parse(fs.readFileSync(path.resolve(expectedPath), 'utf8'))
      : Object.fromEntries(readPackedEntries(path.join(directories.left, packs.left.filename))
        .filter(({ kind }) => kind === 'file')
        .map(({ path: entryPath, sha256 }) => [entryPath.replace(/^[^/]+\//u, ''), sha256]));
    const artifact = requiredArtifactEntries(packs.left.listing);
    summary.failures.push(...artifact.failures);
    const check = comparePackageTrees({
      leftRoot: packs.left.tree,
      rightRoot: packs.right.tree,
      expected,
      requiredPaths: artifact.requiredPaths,
      sourceIdentity: { pinnedRevision: revision, observedRevision, lockfilePath: path.join(root, 'package-lock.json'), pinnedLockfileSha256: lockfileSha256 },
    });
    summary.failures.push(...check.failures);
    summary.observations.push(...check.observations);
    if (packs.left.sha256 !== packs.right.sha256) {
      summary.failures.push(`tarball-bytes-differ: left ${packs.left.sha256} right ${packs.right.sha256} (gzip-mtime left ${packs.left.gzipMtime} right ${packs.right.gzipMtime}, entry mtimes left ${JSON.stringify(packs.left.mtimeRange)} right ${JSON.stringify(packs.right.mtimeRange)})`);
    }
  } finally {
    if (!keepTemporaryDirectories) {
      for (const directory of created) fs.rmSync(directory, { recursive: true, force: true });
      if (parent) fs.rmSync(parent, { recursive: true, force: true });
    }
  }
  summary.failures = [...new Set(summary.failures)].sort(compare);
  summary.ok = summary.failures.length === 0;
  return Object.freeze(summary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--keep') options.keepTemporaryDirectories = true;
    else if (argv[index].startsWith('--')) options[argv[index].slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = argv[++index];
  }
  try {
    const summary = runReproducibilityCheck({ ...options, expectedPath: options.expected });
    const lines = [`scanner reproducibility check: ${summary.ok ? 'IDENTICAL' : 'DIFFERENCES FOUND'} (${summary.failures.length} failures)`];
    lines.push(...summary.observations.map((observation) => `  observation: ${observation}`));
    lines.push(...summary.failures.slice(0, 20).map((failure) => `  failure: ${failure}`));
    if (summary.failures.length > 20) lines.push(`  ... ${summary.failures.length - 20} more failures`);
    if (summary.kept) lines.push(redact(`  temporary directories kept: ${summary.roots.left} ${summary.roots.right}`));
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 2;
  }
}
