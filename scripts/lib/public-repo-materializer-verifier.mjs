import fs from 'node:fs';
import path from 'node:path';
import { compare, hashFile, issue, MANIFEST_SCHEMA, normalisePath, sortIssues } from './public-repo-materializer-common.mjs';

export function manifestIsUsable(manifest) {
  if (!manifest?.ok || manifest.schemaVersion !== MANIFEST_SCHEMA || !Array.isArray(manifest.files) || !Array.isArray(manifest.allowlist) ||
    !Array.isArray(manifest.issues) || manifest.issues.length > 0 || manifest.allowlist.includes('.')) return false;
  return manifest.files.every((record) => typeof record?.path === 'string' && record.path !== '.' && record.path === normalisePath(record.path) &&
    path.posix.normalize(record.path) === record.path && !record.path.startsWith('/') && !/^[A-Za-z]:/.test(record.path) &&
    Number.isInteger(record.size) && record.size >= 0 && /^[a-f0-9]{64}$/.test(record.sha256) &&
    manifest.allowlist.some((entry) => entry === '.' || record.path === entry || record.path.startsWith(`${entry}/`)));
}

function collectDestination(root, relativePath, files, directories, issues) {
  const absolute = path.resolve(root, relativePath === '.' ? '' : relativePath);
  let stats;
  try { stats = fs.lstatSync(absolute); } catch { issues.push(issue('missing-destination-path', relativePath, 'destination path could not be inspected')); return; }
  if (stats.isSymbolicLink()) { issues.push(issue('destination-symlink', relativePath, 'symlinks are not part of the selected tree')); return; }
  if (stats.isDirectory()) {
    if (relativePath !== '.') directories.push(relativePath);
    let entries;
    try { entries = fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name)); }
    catch { issues.push(issue('unreadable-destination-directory', relativePath, 'destination directory could not be enumerated')); return; }
    for (const entry of entries) collectDestination(root, relativePath === '.' ? entry.name : `${relativePath}/${entry.name}`, files, directories, issues);
    return;
  }
  if (!stats.isFile()) { issues.push(issue('unexpected-destination-type', relativePath, 'only regular files may be materialized')); return; }
  try { files.push({ path: relativePath, ...hashFile(absolute) }); }
  catch { issues.push(issue('unreadable-destination-file', relativePath, 'destination file could not be hashed')); }
}

function expectedDirectories(files) {
  const directories = new Set();
  for (const record of files) {
    let parent = path.posix.dirname(record.path);
    while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
  }
  return directories;
}

export function verifyPublicRepositoryMaterialization({ destinationRoot, manifest } = {}) {
  const issues = [];
  if (!manifestIsUsable(manifest)) issues.push(issue('invalid-manifest', '<manifest>', 'only a valid allowlist manifest may be verified'));
  if (typeof destinationRoot !== 'string' || destinationRoot.length === 0) return { ok: false, files: [], issues: [...issues, issue('missing-destination', '<destination>', 'a destination path is required')] };
  const destination = path.resolve(destinationRoot);
  let stats;
  try { stats = fs.lstatSync(destination); } catch { stats = null; }
  if (!stats) return { ok: false, files: [], issues: [...issues, issue('missing-destination', destination, 'destination does not exist')] };
  if (stats.isSymbolicLink()) return { ok: false, files: [], issues: [...issues, issue('destination-symlink', destination, 'destination must not be a symlink')] };
  if (!stats.isDirectory()) return { ok: false, files: [], issues: [...issues, issue('invalid-destination', destination, 'destination must be a directory')] };
  const files = [], directories = [];
  collectDestination(destination, '.', files, directories, issues);
  const expectedFiles = new Map((manifest?.files ?? []).map((record) => [record.path, record]));
  const actualFiles = new Map(files.map((record) => [record.path, record]));
  for (const [filePath, expected] of expectedFiles) {
    const actual = actualFiles.get(filePath);
    if (!actual) issues.push(issue('missing-destination-file', filePath, 'selected file is missing from destination'));
    else {
      if (actual.size !== expected.size) issues.push(issue('destination-size-mismatch', filePath, 'destination size differs from manifest'));
      if (actual.sha256 !== expected.sha256) issues.push(issue('destination-hash-mismatch', filePath, 'destination hash differs from manifest'));
    }
  }
  for (const filePath of actualFiles.keys()) if (!expectedFiles.has(filePath)) issues.push(issue('unexpected-destination-file', filePath, 'destination contains an unselected file'));
  const expectedDirs = expectedDirectories(manifest?.files ?? []);
  for (const directory of expectedDirs) if (!directories.includes(directory)) issues.push(issue('missing-destination-directory', directory, 'selected directory is missing from destination'));
  for (const directory of directories) if (!expectedDirs.has(directory)) issues.push(issue('unexpected-destination-directory', directory, 'destination contains an unselected directory'));
  files.sort((a, b) => compare(a.path, b.path));
  return { ok: issues.length === 0, files, issues: sortIssues(issues) };
}
