import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compare as compareStable, isInside, issue } from './public-repo-materializer-common.mjs';

const ROOT_DENY = new Set([
  '.firebaserc', 'agents.md', 'claude.md', 'drizzle.config.ts', 'firebase.json', 'firebase.txt',
  'plan.md', 'status.md', 'supabase.config.toml']);
const DENY_DIRS = new Set([
  '.cache', '.firebase', '.git', '.next', '.turbo', '.vercel', '_backups', 'backup', 'backups',
  'build', 'coverage', 'dist', 'node_modules', 'out', 'output', 'outputs', 'test-results']);
const SECRET_NAMES = new Set(['credential', 'credentials', 'secret', 'secrets', 'service-account']);
const SECRET_EXTENSIONS = new Set(['.jks', '.key', '.keystore', '.pem', '.p12', '.pfx']);

export function normaliseRelative(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const candidate = value.replaceAll('\\', '/');
  if (candidate.startsWith('/') || /^[A-Za-z]:\//.test(candidate)) return null;
  const normalised = path.posix.normalize(candidate);
  if (normalised === '..' || normalised.startsWith('../')) return null;
  return normalised === '.' ? '.' : normalised.replace(/^\.\//, '');
}

function denialFor(relativePath, { isDirectory = false } = {}) {
  const lower = relativePath.toLowerCase();
  const parts = lower.split('/');
  const base = parts.at(-1);
  if (parts.length === 1 && ROOT_DENY.has(base)) return 'enterprise or root configuration';
  if (parts.some((part) => part.startsWith('.env'))) return 'environment file';
  const isInternalDocumentation = parts[0] === 'docs'
    && ['audit', 'legal', 'recovery', 'research', 'superpowers'].includes(parts[1]);
  if (isInternalDocumentation || parts[0] === 'openspec') return 'internal or pre-decisional documentation';
  if (parts.some((part) => DENY_DIRS.has(part))) return 'local state, backup, or generated output';
  if (parts[0] === 'data' || lower.startsWith('app/public/data/') || parts.includes('full-corpus') || parts.includes('generated-corpus')) {
    return 'generated full corpus';
  }
  // Any `.work` segment, not just `pipeline/.work`. A pipeline script run from
  // the wrong directory left a checkpoint under `contracts/pipeline/.work/`,
  // which the anchored rule did not match and which was materialised into the
  // public tree — harmless there only because the public .gitignore happened to
  // catch it. Scratch is scratch wherever it lands.
  if (parts.includes('.work')) return 'pipeline scratch state';
  if (parts.some((part) => part.startsWith('firebase-')) || parts.includes('firebase.txt') || parts.includes('firebase.json')) {
    return 'Firebase configuration or local state';
  }
  // Name rules describe *material*: a file called `credentials.json`, `prod.key`,
  // or a keystore. A directory is not material — it is a place — and denying one
  // by name denied shipped source: `packages/scanner-core/src/analyzers/secrets/`
  // holds the provider-token registry and its test, which three shipped modules
  // import, so the public tree could not compile. An admitted directory is still
  // walked: every file in it is checked by these same name rules, by the `.env`
  // and extension rules above, and by the content audit
  // (`public-repo-content-safety.mjs`), which reads bytes rather than names.
  if (SECRET_EXTENSIONS.has(path.posix.extname(base))) return 'credential or private-key material';
  if (!isDirectory && SECRET_NAMES.has(base.replace(/\.[^.]+$/, ''))) return 'credential or private-key material';
  if (base === 'firebase.txt' || base === 'firebase.json') return 'Firebase configuration or local state';
  if (/^(?:full|generated)[-_]corpus(?:\.|$)/.test(base)) return 'generated full corpus';
  return null;
}
function isAllowed(relativePath, allowlist) {
  return allowlist.some((entry) => entry === '.' || relativePath === entry || relativePath.startsWith(`${entry}/`));
}
function isAllowlistParent(relativePath, allowlist) {
  return allowlist.some((entry) => entry !== '.' && entry.startsWith(`${relativePath}/`));
}
function isExcluded(relativePath, excludedPaths) {
  return excludedPaths.some((entry) => relativePath === entry || relativePath.startsWith(`${entry}/`));
}
function symlinkIssue(root, absolutePath, relativePath) {
  try {
    const target = fs.realpathSync(absolutePath);
    if (!isInside(root, target)) return issue('symlink-escape', relativePath, 'symlink resolves outside the repository');
  } catch {
    return issue('symlink-path', relativePath, 'symlink target cannot be resolved');
  }
  return issue('symlink-path', relativePath, 'symlinks are not eligible for extraction');
}
function addFile(root, relativePath, files, issues) {
  const absolutePath = path.resolve(root, relativePath);
  try {
    const bytes = fs.readFileSync(absolutePath);
    files.push({ path: relativePath, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  } catch {
    issues.push(issue('unreadable-file', relativePath, 'file could not be read for hashing'));
  }
}
function walk(root, relativePath, allowlist, files, issues, suppressUnexpected = false, options = {}) {
  const excludedPaths = Array.isArray(options.excludedPaths) ? options.excludedPaths : [];
  if (options.selectedOnly && isExcluded(relativePath, excludedPaths)) return;
  const selected = relativePath === '.' || isAllowed(relativePath, allowlist) || isAllowlistParent(relativePath, allowlist);
  if (options.selectedOnly && relativePath !== '.' && !selected) return;
  const absolutePath = path.resolve(root, relativePath === '.' ? '' : relativePath);
  let stats;
  try { stats = fs.lstatSync(absolutePath); } catch { issues.push(issue('unreadable-path', relativePath, 'path could not be inspected')); return; }
  if (stats.isSymbolicLink()) { issues.push(symlinkIssue(root, absolutePath, relativePath)); return; }
  const denial = denialFor(relativePath, { isDirectory: stats.isDirectory() });
  if (denial) { issues.push(issue('denied-path', relativePath, denial)); return; }
  if (stats.isDirectory()) {
    if (!selected && !suppressUnexpected) issues.push(issue('unexpected-path', relativePath, 'directory is outside the explicit allowlist'));
    let entries;
    try { entries = fs.readdirSync(absolutePath, { withFileTypes: true }).sort((a, b) => compareStable(a.name, b.name)); }
    catch { issues.push(issue('unreadable-directory', relativePath, 'directory could not be enumerated')); return; }
    for (const entry of entries) {
      const child = relativePath === '.' ? entry.name : `${relativePath}/${entry.name}`;
      walk(root, child, allowlist, files, issues, suppressUnexpected || !selected, options);
    }
    return;
  }
  if (!stats.isFile()) { issues.push(issue('unexpected-type', relativePath, 'only regular files may be extracted')); return; }
  if (isAllowed(relativePath, allowlist)) addFile(root, relativePath, files, issues);
  else if (!suppressUnexpected) issues.push(issue('unexpected-path', relativePath, 'file is outside the explicit allowlist'));
}
export function normaliseAllowlist(rawAllowlist, issues) {
  if (!Array.isArray(rawAllowlist)) { issues.push(issue('invalid-allowlist', '<allowlist>', 'allowlist must be an array')); return []; }
  const entries = [];
  for (const raw of rawAllowlist) {
    const normalised = normaliseRelative(raw);
    if (normalised === null) issues.push(issue('invalid-allowlist-path', String(raw), 'allowlist paths must stay inside the repository'));
    else if (entries.includes(normalised)) issues.push(issue('duplicate-allowlist-path', normalised, 'allowlist paths must be unique'));
    else entries.push(normalised);
  }
  return entries.sort(compareStable);
}
export function checkAllowlistEntriesExist(root, normalisedAllowlist, issues) {
  for (const entry of normalisedAllowlist) {
    const absolute = path.resolve(root, entry === '.' ? '' : entry);
    if (!isInside(root, absolute)) issues.push(issue('invalid-allowlist-path', entry, 'resolved path escapes the repository'));
    else if (!fs.existsSync(absolute)) issues.push(issue('missing-allowlist-path', entry, 'explicitly allowlisted path is missing'));
  }
}
export function walkRepositoryTree(root, normalisedAllowlist, files, issues, options = {}) {
  walk(root, '.', normalisedAllowlist, files, issues, false, options);
}
