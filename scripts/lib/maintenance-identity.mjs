import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

const SOURCE_DIRS = ['app', 'contracts', 'packages', 'pipeline', 'schemas', 'scripts'];
const SOURCE_FILES = ['.gitattributes', '.gitignore', 'eslint.config.mjs', 'firebase.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts'];
const SKIP_DIRS = new Set(['.git', '.next', '.turbo', '.types', '.work', 'coverage', 'dist', 'node_modules', 'out', 'out-canary', 'playwright-report', 'test-results']);
const SKIP_PATHS = new Set(['pipeline/scan/__fixtures__']);
const GENERATED_DIRS = new Set(['app/public/data', 'app/public/og', 'pipeline/reports']); const GENERATED_FILES = new Set(['app/app/favicon.ico', 'app/app/apple-icon.png']);
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const fail = (message) => { throw new Error(`maintenance plan refused: ${message}`); };
function hashFile(file) {
  const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024); const fd = openSync(file, 'r'); let byteSize = 0;
  try { for (;;) { const count = readSync(fd, buffer, 0, buffer.length, null); if (count === 0) break; byteSize += count; hash.update(buffer.subarray(0, count)); } } finally { closeSync(fd); }
  return { byteSize, sha256: hash.digest('hex') };
}

export function safePath(value, label, { kind, missing = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  if (process.platform === 'win32' && /^\\\\[?.]\\/u.test(value)) fail(`${label} must not use a Windows namespace alias`);
  const target = path.resolve(value); let cursor = path.parse(target).root;
  for (const part of target.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let info;
    try { info = lstatSync(cursor); } catch (error) { if (missing && error.code === 'ENOENT') break; fail(`${label} is missing or unreadable`); }
    if (info.isSymbolicLink()) fail(`${label} contains a symlink or junction`);
    if (info.isFile() && info.nlink > 1) fail(`${label} contains a hard-linked file`);
    if (cursor !== target && !info.isDirectory()) fail(`${label} has a non-directory parent`);
  }
  if (kind === 'file' && !lstatSync(target).isFile()) fail(`${label} must be a regular file`);
  if (kind === 'directory' && !lstatSync(target).isDirectory()) fail(`${label} must be a directory`);
  let existing = target;
  while (!lstatSync(existing, { throwIfNoEntry: false })) existing = path.dirname(existing);
  return path.resolve(realpathSync(existing), path.relative(existing, target));
}

function readJson(file, label) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { fail(`${label} is not valid JSON`); } }
export function filesUnder(root, prefix = '', source = false) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail(`source/data tree contains a symlink: ${rel}`);
    if (entry.isDirectory()) {
      if (source && (SKIP_DIRS.has(entry.name) || GENERATED_DIRS.has(rel) || SKIP_PATHS.has(rel))) continue;
      found.push(...filesUnder(path.join(root, entry.name), rel, source));
    } else if (entry.isFile()) {
      if (lstatSync(path.join(root, entry.name)).nlink > 1) fail(`source/data tree contains a hard-linked file: ${rel}`);
      if (source && (entry.name.endsWith('.tsbuildinfo') || GENERATED_FILES.has(rel))) continue;
      found.push({ path: rel, ...hashFile(path.join(root, entry.name)) });
    }
    else fail(`source/data tree contains an unsupported entry: ${rel}`);
  }
  return found;
}

export function sourceIdentity(root) {
  const rows = [];
  for (const relative of SOURCE_FILES) {
    const file = path.join(root, relative); safePath(file, `required source file ${relative}`, { kind: 'file' });
    rows.push({ path: relative, sha256: sha(readFileSync(file)) });
  }
  for (const relative of SOURCE_DIRS) {
    const dir = path.join(root, relative); safePath(dir, `required source directory ${relative}`, { kind: 'directory' });
    for (const file of filesUnder(dir, relative, true)) if (!file.path.endsWith('.md')) rows.push({ path: file.path, sha256: file.sha256 });
  }
  const packedReadme = 'packages/scanner-cli/README.md';
  const readme = path.join(root, packedReadme);
  if (lstatSync(readme, { throwIfNoEntry: false })?.isFile()) rows.push({ path: packedReadme, sha256: hashFile(readme).sha256 });
  rows.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { fileCount: rows.length, sha256: sha(Buffer.from(canonical(rows))), files: rows };
}

export function dataIdentity(root) {
  const dir = safePath(path.join(root, 'data'), 'candidate data', { kind: 'directory' });
  const rows = filesUnder(dir);
  const manifest = readJson(path.join(dir, 'manifest.json'), 'data manifest');
  if (!Array.isArray(manifest.artifacts)) fail('data manifest must declare artifacts');
  const artifacts = manifest.artifacts.map((item) => {
    if (!item || typeof item.path !== 'string' || path.isAbsolute(item.path) || item.path.split(/[\\/]/u).includes('..')) fail('data manifest has an unsafe artifact path');
    const rel = item.path.replaceAll('\\', '/'); const row = rows.find((file) => file.path === rel);
    if (!row || row.sha256 !== item.sha256 || row.byteSize !== item.byteSize) fail(`data artifact does not match manifest: ${rel}`);
    return { path: rel, byteSize: row.byteSize, sha256: row.sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { manifestSha256: sha(readFileSync(path.join(dir, 'manifest.json'))), totalEntries: manifest.totalEntries, artifacts, treeSha256: sha(Buffer.from(canonical(rows))), fileCount: rows.length };
}

