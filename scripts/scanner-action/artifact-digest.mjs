import fs from 'node:fs';
import path from 'node:path';
import { ACTION_ARTIFACT_ROOT, artifactSetSha256, sha256Bytes } from './release-contract.mjs';

const MAX_FILES = 512;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export function resolveInside(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 512
    || relativePath.includes('\\') || relativePath.includes(':') || relativePath.startsWith('/')
    || /[\u0000-\u001f\u007f]/u.test(relativePath)
    || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('PATH_INVALID');
  }
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('SYMLINK_REFUSED');
  const realRoot = fs.realpathSync(root);
  let current = realRoot;
  for (const part of relativePath.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('SYMLINK_REFUSED');
  }
  const resolved = path.resolve(realRoot, relativePath);
  const relative = path.relative(realRoot, resolved);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('PATH_TRAVERSAL');
  return { realRoot, resolved };
}

export function hashRegularFile(filePath, relativePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error('SYMLINK_REFUSED');
  if (!stat.isFile()) throw new Error('NOT_REGULAR_FILE');
  if (stat.nlink !== 1) throw new Error('HARDLINK_REFUSED');
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_FILE_BYTES) throw new Error('FILE_SIZE_INVALID');
  const bytes = fs.readFileSync(filePath);
  if (bytes.length !== stat.size) throw new Error('FILE_CHANGED_DURING_READ');
  return Object.freeze({ path: relativePath, byteLength: bytes.length, sha256: sha256Bytes(bytes) });
}

function walk(root, current, rows, total) {
  const entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    if (rows.length >= MAX_FILES) throw new Error('ARTIFACT_COUNT_LIMIT');
    const full = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error('SYMLINK_REFUSED');
    if (entry.isDirectory()) {
      walk(root, full, rows, total);
      continue;
    }
    if (!entry.isFile()) throw new Error('SPECIAL_FILE_REFUSED');
    const relative = path.relative(root, full).replaceAll(path.sep, '/');
    const row = hashRegularFile(full, relative);
    total.bytes += row.byteLength;
    if (total.bytes > MAX_TOTAL_BYTES) throw new Error('ARTIFACT_BYTES_LIMIT');
    rows.push(row);
  }
}

export function collectArtifactEntries(root) {
  const { realRoot, resolved } = resolveInside(root, ACTION_ARTIFACT_ROOT.slice(0, -1));
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error('SYMLINK_REFUSED');
  if (!stat.isDirectory()) throw new Error('ARTIFACT_DIRECTORY_MISSING');
  const rows = [];
  walk(realRoot, resolved, rows, { bytes: 0 });
  rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return Object.freeze({ artifacts: Object.freeze(rows), artifactSetSha256: artifactSetSha256(rows) });
}

export function compareArtifactSets(actual, expected) {
  const current = actual.artifacts;
  if (current.length !== expected.length) return Object.freeze({ ok: false, code: 'ARTIFACT_SET_SIZE_MISMATCH' });
  for (let index = 0; index < expected.length; index += 1) {
    const left = current[index];
    const right = expected[index];
    if (left?.path !== right.path) return Object.freeze({ ok: false, code: 'ARTIFACT_PATH_MISMATCH', file: right.path });
    if (left.byteLength !== right.byteLength) return Object.freeze({ ok: false, code: 'ARTIFACT_SIZE_MISMATCH', file: right.path });
    if (left.sha256 !== right.sha256) return Object.freeze({ ok: false, code: 'ARTIFACT_DIGEST_MISMATCH', file: right.path });
  }
  if (actual.artifactSetSha256 !== artifactSetSha256(expected)) return Object.freeze({ ok: false, code: 'ARTIFACT_SET_DIGEST_MISMATCH' });
  return Object.freeze({ ok: true, artifactCount: current.length, artifactSetSha256: actual.artifactSetSha256 });
}
