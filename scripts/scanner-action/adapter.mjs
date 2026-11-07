import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ACTION_TRUST_FILES, canonicalJson, parseStrictJson, sha256Bytes, validateReleaseReceipt } from './release-contract.mjs';
import { collectArtifactEntries, compareArtifactSets, hashRegularFile, resolveInside } from './artifact-digest.mjs';
import { loadBundledRelease } from './preflight.mjs';

const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_GIT_BYTES = 32 * 1024 * 1024;

function failure(code, detail) {
  return Object.freeze({ ok: false, code, ...(detail === undefined ? {} : { detail }) });
}

function readReceipt(receiptPath, expectedSha256) {
  try {
    const bytes = fs.readFileSync(receiptPath);
    if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) return failure('RELEASE_RECEIPT_SIZE_INVALID');
    const digest = sha256Bytes(bytes);
    if (digest !== expectedSha256) return failure('RELEASE_RECEIPT_DIGEST_MISMATCH');
    const checked = validateReleaseReceipt(parseStrictJson(bytes.toString('utf8')));
    return checked.ok ? Object.freeze({ ok: true, receipt: checked.receipt, digest }) : checked;
  } catch (error) {
    if (error?.code === 'ENOENT') return failure('RELEASE_RECEIPT_MISSING');
    if (error?.code === 'DUPLICATE_JSON_KEY') return failure('RELEASE_RECEIPT_DUPLICATE_KEY');
    return failure('RELEASE_RECEIPT_UNREADABLE');
  }
}

function git(root, args, allowDirty = false) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: MAX_GIT_BYTES });
  if (result.error || result.status === null || result.status === 128 || (result.status !== 0 && !allowDirty)) {
    return failure('GIT_OPERATION_FAILED', args[0]);
  }
  return Object.freeze({ ok: true, status: result.status, stdout: result.stdout });
}

function normalizeRepository(value) {
  const input = value.trim().replace(/\/+$/u, '').replace(/\.git$/u, '');
  const match = input.match(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/u);
  return match?.[1]?.toLowerCase();
}

function sourceTreeSha256(indexOutput, root) {
  const rows = [];
  const seen = new Set();
  for (const record of indexOutput.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const metadata = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    if (tab < 0 || metadata.length !== 3 || file === '' || seen.has(file)) return failure('GIT_INDEX_INVALID', file);
    const [mode, objectId, stage] = metadata;
    if (stage !== '0') return failure('GIT_CONFLICT_REFUSED', file);
    if (mode !== '100644' && mode !== '100755') return failure('GIT_ENTRY_MODE_REFUSED', file);
    seen.add(file);
    if (!ACTION_TRUST_FILES.includes(file)) {
      const { resolved } = resolveInside(root, file);
      const bytes = hashRegularFile(resolved, file);
      rows.push(Object.freeze({ mode, objectId, ...bytes }));
    }
  }
  rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (rows.length === 0) return failure('GIT_INDEX_EMPTY');
  return Object.freeze({ ok: true, sourceTreeSha256: sha256Bytes(Buffer.from(canonicalJson(rows), 'utf8')), fileCount: rows.length });
}

export function inspectCheckedSource(sourceRoot, repository, ref) {
  try {
    const rootStat = fs.lstatSync(sourceRoot);
    if (rootStat.isSymbolicLink()) return failure('SOURCE_ROOT_SYMLINK_REFUSED');
    if (!rootStat.isDirectory()) return failure('SOURCE_ROOT_INVALID');
    const root = fs.realpathSync(sourceRoot);
    const top = git(root, ['rev-parse', '--show-toplevel']);
    if (!top.ok) return top;
    if (fs.realpathSync(top.stdout.trim()) !== root) return failure('SOURCE_ROOT_NOT_GIT_ROOT');
    const head = git(root, ['rev-parse', 'HEAD']);
    if (!head.ok) return head;
    if (head.stdout.trim() !== ref) return failure('SOURCE_REF_MISMATCH');
    const remote = git(root, ['remote', 'get-url', 'origin']);
    if (!remote.ok) return remote;
    if (normalizeRepository(remote.stdout) !== repository.toLowerCase()) return failure('SOURCE_REPOSITORY_MISMATCH');
    const dirty = git(root, ['diff', '--name-only', '-z', 'HEAD', '--'], true);
    if (!dirty.ok) return dirty;
    if (dirty.status !== 0 || dirty.stdout !== '') return failure('SOURCE_TREE_DIRTY');
    for (const args of [['ls-files', '--others', '--exclude-standard', '-z'], ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']]) {
      const untracked = git(root, args);
      if (!untracked.ok) return untracked;
      if (untracked.stdout !== '') return failure('SOURCE_UNTRACKED_FILES_PRESENT');
    }
    const flags = git(root, ['ls-files', '-v', '-z']);
    if (!flags.ok) return flags;
    if (flags.stdout.split('\0').filter(Boolean).some((record) => record[0] !== 'H')) return failure('SOURCE_INDEX_FLAGS_REFUSED');
    const index = git(root, ['ls-files', '-s', '-z']);
    if (!index.ok) return index;
    const tree = sourceTreeSha256(index.stdout, root);
    if (!tree.ok) return tree;
    const lockfile = hashRegularFile(path.join(root, 'package-lock.json'), 'package-lock.json');
    return Object.freeze({ ok: true, sourceTreeSha256: tree.sourceTreeSha256, fileCount: tree.fileCount, lockfileSha256: lockfile.sha256 });
  } catch {
    return failure('SOURCE_ACCESS_FAILED');
  }
}

export function verifyCheckedSource({ sourceRoot, receiptPath, receiptSha256, repository, ref }) {
  const loaded = readReceipt(receiptPath, receiptSha256);
  if (!loaded.ok) return loaded;
  const receipt = loaded.receipt;
  if (receipt.scannerRepository !== repository || receipt.scannerRef !== ref) return failure('SOURCE_EXPECTATION_MISMATCH');
  const source = inspectCheckedSource(sourceRoot, repository, ref);
  if (!source.ok) return source;
  if (source.sourceTreeSha256 !== receipt.sourceTreeSha256) return failure('SOURCE_TREE_DIGEST_MISMATCH');
  if (source.lockfileSha256 !== receipt.lockfileSha256) return failure('LOCKFILE_DIGEST_MISMATCH');
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'packages/scanner-cli/package.json'), 'utf8'));
    if (manifest.name !== receipt.package.name || manifest.version !== receipt.package.version) return failure('PACKAGE_IDENTITY_MISMATCH');
    return Object.freeze({ ok: true, status: 'SOURCE_VERIFIED', sourceTreeSha256: source.sourceTreeSha256, fileCount: source.fileCount, lockfileSha256: source.lockfileSha256, packageVersion: manifest.version });
  } catch {
    return failure('PACKAGE_MANIFEST_UNREADABLE');
  }
}

export function verifyArtifacts({ sourceRoot, receiptPath, receiptSha256 }) {
  const loaded = readReceipt(receiptPath, receiptSha256);
  if (!loaded.ok) return loaded;
  try {
    const actual = collectArtifactEntries(sourceRoot);
    const compared = compareArtifactSets(actual, loaded.receipt.artifacts);
    return compared.ok ? Object.freeze({ ...compared, status: 'ARTIFACTS_VERIFIED' }) : compared;
  } catch (error) {
    return failure(error?.message ?? 'ARTIFACT_READ_FAILED');
  }
}

export function buildSourceSnapshot(sourceRoot, repository, ref) {
  const source = inspectCheckedSource(sourceRoot, repository, ref);
  if (!source.ok) return source;
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'packages/scanner-cli/package.json'), 'utf8'));
  return Object.freeze({
    ok: true,
    source: Object.freeze({ repository, ref, sourceTreeSha256: source.sourceTreeSha256, lockfileSha256: source.lockfileSha256 }),
    package: Object.freeze({ name: manifest.name, version: manifest.version }),
  });
}

export function buildArtifactSnapshot(sourceRoot) {
  try {
    const artifacts = collectArtifactEntries(sourceRoot);
    return Object.freeze({ ok: true, artifacts: artifacts.artifacts, artifactSetSha256: artifacts.artifactSetSha256 });
  } catch (error) {
    return failure(error?.message ?? 'ARTIFACT_READ_FAILED');
  }
}

function parseArgs(argv) {
  const command = argv[0];
  const values = {};
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--source-root', '--receipt', '--receipt-sha256', '--repository', '--ref'].includes(key) || value === undefined || seen.has(key)) throw new Error('EXPECTED_ADAPTER_ARGUMENTS');
    seen.add(key);
    values[key.slice(2)] = value;
  }
  return { command, values };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirect = invoked !== '' && (process.platform === 'win32' ? invoked.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() : invoked === fileURLToPath(import.meta.url));
if (isDirect) {
  let code = 2;
  let result;
  try {
    const { command, values } = parseArgs(process.argv.slice(2));
    if (!values['source-root']) throw new Error('EXPECTED_ADAPTER_ARGUMENTS');
    const sourceRoot = path.resolve(values['source-root']);
    if (command === 'source' || command === 'artifacts') {
      const trusted = loadBundledRelease();
      if (!trusted.ok) throw new Error(trusted.code);
      if (!values.receipt || path.resolve(values.receipt) !== trusted.receiptPath
        || values['receipt-sha256'] !== trusted.receiptSha256
        || (command === 'source' && (values.repository !== trusted.scannerRepository || values.ref !== trusted.scannerRef))) {
        throw new Error('ACTION_AUTHORITY_MISMATCH');
      }
    }
    if (command === 'source' && values.receipt && values['receipt-sha256'] && values.repository && values.ref) {
      result = verifyCheckedSource({ sourceRoot, receiptPath: path.resolve(values.receipt), receiptSha256: values['receipt-sha256'], repository: values.repository, ref: values.ref });
    } else if (command === 'artifacts' && values.receipt && values['receipt-sha256']) {
      result = verifyArtifacts({ sourceRoot, receiptPath: path.resolve(values.receipt), receiptSha256: values['receipt-sha256'] });
    } else if (command === 'source-snapshot' && values.repository && values.ref) {
      result = buildSourceSnapshot(sourceRoot, values.repository, values.ref);
    } else if (command === 'artifact-snapshot') {
      result = buildArtifactSnapshot(sourceRoot);
    } else {
      throw new Error('EXPECTED_ADAPTER_ARGUMENTS');
    }
  } catch (error) {
    result = failure(error.message);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  code = result?.ok ? 0 : 1;
  process.exitCode = code;
}
