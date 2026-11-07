/**
 * The release descriptor's environment: the tree it was staged from, the tools that
 * produced it, the frozen input inventory it consumed, and the optional artifacts that
 * are declared prepared-only.
 *
 * The writer and the verifier both read this through `readReleaseEnvironment`, so a
 * descriptor cannot be assembled from a different tree, toolchain or input inventory
 * than the one the verifier re-reads. Tests and drills inject the environment instead of
 * reading it, which is why every field is validated here rather than at each call site.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fail, record, sha256 } from './release-artifacts.mjs';
import { readInputSnapshot } from './published-secret-input-inventory.mjs';

/** The only mode under which the descriptor writer runs; see `assertWriterMode`. */
export const WRITER_MODE = 'release';
export const DEFAULT_INPUT_SNAPSHOT = 'pipeline/.work/official-bodies-snapshot.json';
const COMMIT = /^[a-f0-9]{40}$/u;
const SEMVER = /^\d+\.\d+\.\d+/u;

/**
 * The optional artifacts this repository can publish beside the static site. Both are
 * declared `prepared-only` until their own gates and owner decisions pass, which is why
 * the npm tarball carries no digest: nothing built one, and a fabricated digest would
 * read as evidence that it had been.
 */
const OPTIONAL_DECLARATIONS = Object.freeze([
  Object.freeze({
    name: 'github-action-bundle',
    path: 'action.yml',
    reason: 'the Action bundle ships from this file; its own gate and owner decision have not passed',
  }),
  Object.freeze({
    name: 'npm-tarball',
    package: 'sfscanner',
    reason: 'no tarball is built or bound by this release; npm publication needs its own gate and owner decision',
  }),
]);

/** The default release inputs in the repository; the writer and verifier must agree. */
export function defaultSources(repoRoot) {
  return Object.freeze({
    site: path.join(repoRoot, 'app', 'out'),
    data: path.join(repoRoot, 'data'),
    export: path.join(repoRoot, 'outputs', 'public-dataset'),
  });
}

/**
 * The writer is unreachable from the general gate sequence: `npm run gates` never names
 * it, and the command itself refuses to do anything without the explicit mode below.
 * `export:public-dataset` is the one other authorized writer, and it lives in its own
 * script rather than behind this flag.
 */
export function assertWriterMode(mode) {
  if (mode !== WRITER_MODE) {
    fail(`the release descriptor writer runs only with --mode ${WRITER_MODE} (or via export:public-dataset); got ${mode === undefined ? 'no mode' : `--mode ${mode}`}`);
  }
}

function git(repoRoot, args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    fail(`git ${args.join(' ')} failed, so the release tree is unknown: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return result.stdout;
}

/** The exact commit and the dirty-tree declaration the release is bound to. */
export function readTreeState(repoRoot) {
  const commit = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  if (!COMMIT.test(commit)) fail(`git reported an unusable commit: ${commit}`);
  const dirtyFiles = git(repoRoot, ['status', '--porcelain', '--untracked-files=normal'])
    .split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    .map((line) => line.slice(2).trim()).sort();
  return Object.freeze({
    commit,
    clean: dirtyFiles.length === 0,
    dirty: dirtyFiles.length > 0,
    dirtyFiles: Object.freeze(dirtyFiles),
  });
}

/** A release is staged and verified from a clean tracked tree, never from a work in progress. */
export function assertCleanTree(tree, label = 'the release tree') {
  if (!record(tree) || typeof tree.clean !== 'boolean' || !Array.isArray(tree.dirtyFiles)) {
    fail(`${label} carries no dirty-tree declaration`);
  }
  if (!tree.clean) {
    const named = tree.dirtyFiles.slice(0, 5).join(', ');
    fail(`${label} is dirty, so the descriptor cannot bind it: ${String(tree.dirtyFiles.length)} changed path(s): ${named}${tree.dirtyFiles.length > 5 ? ', ...' : ''}`);
  }
}

/** Node, npm and the lockfile are the tool identity of a release; a different one is a different release. */
export async function readToolIdentities(repoRoot) {
  const lockfilePath = 'package-lock.json';
  const lockfileBytes = await readFile(path.join(repoRoot, lockfilePath)).catch(() => null);
  if (lockfileBytes === null) fail(`${lockfilePath} is missing, so the release tool identity is unknown`);
  let lockfileVersion;
  try {
    lockfileVersion = JSON.parse(lockfileBytes.toString('utf8')).lockfileVersion;
  } catch {
    fail(`${lockfilePath} is not valid JSON`);
  }
  if (!Number.isSafeInteger(lockfileVersion)) fail(`${lockfilePath} declares no lockfileVersion`);
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  const npmVersion = String(npm.stdout ?? '').trim().split('\n').pop() ?? '';
  if (npm.status !== 0 || !SEMVER.test(npmVersion)) fail('the npm version could not be determined, so the release tool identity is incomplete');
  return Object.freeze({
    node: process.version,
    npm: npmVersion,
    lockfile: Object.freeze({ path: lockfilePath, sha256: sha256(lockfileBytes), byteSize: lockfileBytes.length, lockfileVersion }),
  });
}

/**
 * The frozen input inventory the released bytes were derived from. The snapshot's own
 * byte digest and its self-checked `inventoryDigest` are both recorded: the first binds
 * the file that was provisioned, the second binds the 9,564 bodies it enumerates.
 */
export async function readInputInventory(repoRoot, snapshotPath = path.join(repoRoot, DEFAULT_INPUT_SNAPSHOT)) {
  const resolved = path.resolve(snapshotPath);
  const bytes = await readFile(resolved).catch(() => null);
  if (bytes === null) fail(`the frozen input inventory is missing: ${resolved}`);
  const snapshot = readInputSnapshot(resolved);
  if (!snapshot.ok) fail(`the frozen input inventory is not a verified snapshot (${snapshot.reason}): ${snapshot.detail}`);
  const relative = path.relative(repoRoot, resolved);
  const inRepository = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  return Object.freeze({
    path: (inRepository ? relative : resolved).replaceAll(path.sep, '/'),
    sha256: sha256(bytes),
    byteSize: bytes.length,
    algorithm: snapshot.inventory.algorithm,
    inventoryDigest: snapshot.inventory.digest,
    fileCount: snapshot.inventory.fileCount,
    totalBytes: snapshot.inventory.totalBytes,
  });
}

export async function readOptionalArtifacts(repoRoot) {
  const entries = [];
  for (const declaration of OPTIONAL_DECLARATIONS) {
    if (declaration.path === undefined) {
      entries.push(Object.freeze({ ...declaration, status: 'prepared-only' }));
      continue;
    }
    const bytes = await readFile(path.join(repoRoot, declaration.path)).catch(() => null);
    entries.push(bytes === null
      ? Object.freeze({ ...declaration, status: 'prepared-only', present: false })
      : Object.freeze({ ...declaration, status: 'prepared-only', present: true, sha256: sha256(bytes), byteSize: bytes.length }));
  }
  return Object.freeze(entries);
}

/**
 * The one reading of the environment that both the writer and the verifier use. A dirty
 * tree is refused here rather than in the writer, so `npm run verify:release` cannot
 * verify a candidate against a tree that has moved since it was staged.
 */
export async function readReleaseEnvironment(repoRoot, snapshotPath) {
  const tree = readTreeState(repoRoot);
  assertCleanTree(tree);
  return Object.freeze({
    tree,
    tools: await readToolIdentities(repoRoot),
    inputs: await readInputInventory(repoRoot, snapshotPath),
    optionalArtifacts: await readOptionalArtifacts(repoRoot),
  });
}
