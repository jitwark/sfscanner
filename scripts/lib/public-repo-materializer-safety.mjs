import fs from 'node:fs';
import path from 'node:path';
import { hashFile, isInside, issue, normalisePath, overlaps, sortIssues } from './public-repo-materializer-common.mjs';

function firstSymlink(target) {
  let current = path.parse(target).root;
  for (const part of path.relative(current, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return current;
    } catch {
      return null;
    }
  }
  return null;
}

export function inspectDestination(repositoryRoot, destinationRoot) {
  if (typeof destinationRoot !== 'string' || destinationRoot.length === 0) {
    return { ok: false, path: null, issues: [issue('missing-destination', '<destination>', 'a new destination path is required')] };
  }
  const source = path.resolve(repositoryRoot ?? process.cwd());
  const destination = path.resolve(destinationRoot);
  if (overlaps(source, destination)) return { ok: false, path: destination, issues: [issue('destination-overlap', destination, 'source and destination paths overlap')] };
  let destinationStats;
  try { destinationStats = fs.lstatSync(destination); } catch { destinationStats = null; }
  if (destinationStats?.isSymbolicLink()) return { ok: false, path: destination, issues: [issue('destination-symlink', destination, 'destination must not be a symlink')] };
  if (destinationStats) return { ok: false, path: destination, issues: [issue('destination-exists', destination, 'destination must not pre-exist')] };
  const parent = path.dirname(destination);
  let parentStats;
  try { parentStats = fs.lstatSync(parent); } catch { parentStats = null; }
  const symlink = firstSymlink(parent);
  if (symlink) return { ok: false, path: normalisePath(path.relative(process.cwd(), symlink)), issues: [issue('destination-symlink-parent', normalisePath(path.relative(process.cwd(), symlink)), 'destination parent contains a symlink')] };
  if (!parentStats) return { ok: false, path: destination, issues: [issue('missing-destination-parent', parent, 'destination parent must already exist')] };
  if (!parentStats.isDirectory()) return { ok: false, path: destination, issues: [issue('invalid-destination-parent', parent, 'destination parent must be a directory')] };
  try {
    const sourceReal = fs.realpathSync(source);
    const destinationReal = path.join(fs.realpathSync(parent), path.basename(destination));
    if (overlaps(sourceReal, destinationReal)) return { ok: false, path: destination, issues: [issue('destination-overlap', destination, 'resolved source and destination paths overlap')] };
  } catch {
    return { ok: false, path: destination, issues: [issue('unreadable-destination-parent', parent, 'destination parent could not be resolved')] };
  }
  return { ok: true, path: destination, issues: [] };
}

function ensureDirectoryChain(root, target) {
  const relative = path.relative(root, target);
  if (!isInside(root, target)) throw new Error('destination path escapes the selected tree');
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stats;
    try { stats = fs.lstatSync(current); } catch { stats = null; }
    if (stats?.isSymbolicLink()) throw new Error(`destination directory is a symlink: ${current}`);
    if (stats && !stats.isDirectory()) throw new Error(`destination path is not a directory: ${current}`);
    if (!stats) fs.mkdirSync(current);
  }
}

export function copyManifestFiles(repositoryRoot, destinationRoot, manifest) {
  for (const record of manifest.files) {
    const source = path.resolve(repositoryRoot, record.path);
    const destination = path.resolve(destinationRoot, record.path);
    if (!isInside(destinationRoot, destination)) throw new Error(`selected path escapes destination: ${record.path}`);
    const sourceStats = fs.lstatSync(source);
    if (!sourceStats.isFile()) throw new Error(`source changed to a non-file: ${record.path}`);
    ensureDirectoryChain(destinationRoot, path.dirname(destination));
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }
}

export function validateSourceSnapshot(repositoryRoot, manifest) {
  const issues = [];
  for (const record of manifest.files) {
    const source = path.resolve(repositoryRoot, record.path);
    if (!isInside(repositoryRoot, source)) {
      issues.push(issue('source-path-escape', record.path, 'selected path escapes the source repository'));
      continue;
    }
    let stats;
    try { stats = fs.lstatSync(source); } catch { issues.push(issue('source-missing', record.path, 'selected source file is missing')); continue; }
    if (!stats.isFile()) { issues.push(issue('source-not-file', record.path, 'selected source path is not a regular file')); continue; }
    try {
      const actual = hashFile(source);
      if (actual.size !== record.size || actual.sha256 !== record.sha256) {
        issues.push(issue('source-hash-mismatch', record.path, 'source file differs from the manifest snapshot'));
      }
    } catch { issues.push(issue('source-unreadable', record.path, 'selected source file could not be hashed')); }
  }
  return sortIssues(issues);
}

export function removeCreatedDestination(destination) {
  try {
    const stats = fs.lstatSync(destination);
    if (stats.isDirectory() && !stats.isSymbolicLink()) fs.rmSync(destination, { recursive: true, force: true });
  } catch { /* best-effort cleanup never broadens the deletion target */ }
}
