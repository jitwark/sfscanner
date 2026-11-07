#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_EXPORT_DIR = path.join(REPO_ROOT, 'app', 'out');
const SCHEMA_VERSION = 'generated-assets-integrity-v1';
const POLICY_VERSION = 'generated-assets-policy-v1';
const DEBUG_PATH = /(?:^|\/)(?:debug|trace|coverage)(?:[._/-]|$)|(?:\.debug|\.trace|\.log|\.dump|\.pdb)$/i;
const OG_IMAGE = /^(?:og\/).+\.(?:png|jpe?g|webp|avif|svg)$/i;
const ICON_ROOT = /^(?:favicon\.ico|apple-icon\.(?:png|jpe?g|webp|avif)|icon\.(?:svg|png|ico))$/i;
const ICON_HASHED = /^_next\/static\/media\/(favicon|apple-icon|icon)\.[^/]+\.(?:ico|png|svg)$/i;
const WEBPACK_ROUTE_CHUNK = /^_next\/static\/chunks\/(?:app\/(?:.+\/)?(?:page|not-found)-[^/]+\.js|next\/dist\/client\/components\/builtin\/(?:app-error|forbidden|unauthorized)-[^/]+\.js)$/i;
const WEBPACK_ROUTE_WRAPPER = /^\(self\.webpackChunk_N_E=self\.webpackChunk_N_E\|\|\[\]\)\.push\(\[\[[0-9,]+\],\{\d+:\(e,s,_\)=>\{Promise\.resolve\(\)\.then\(_\.t\.bind\(_,\d+,\d+\)\)\}\},e=>\{e\.O\(0,\[[0-9,]+\],\(\)=>e\(e\.s=\d+\)\),_N_E=e\.O\(\)\}\]\);$/;
const WEBPACK_EMPTY_ROUTE_WRAPPER = /^\(self\.webpackChunk_N_E=self\.webpackChunk_N_E\|\|\[\]\)\.push\(\[\[[0-9,]+\],\{\d+:\(\)=>\{\}\},_=>\{_\.O\(0,\[[0-9,]+\],\(\)=>_\(_\.s=\d+\)\),_N_E=_.O\(\)\}\]\);$/;

const posix = (value) => value.replaceAll(path.sep, '/');
const relativePath = (root, file) => posix(path.relative(root, file));
const compareStrings = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareStrings(a.name, b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(file));
    else files.push(file);
  }
  return files;
}

function forbiddenKind(file, regular) {
  if (/\.map$/i.test(file)) return 'source-map';
  if (/\.(?:ts|tsx)$/i.test(file)) return 'source-file';
  if (DEBUG_PATH.test(file)) return 'debug-artifact';
  if (!regular) return 'non-regular-artifact';
  return null;
}

function generatedKind(file) {
  if (OG_IMAGE.test(file)) return 'og';
  if (ICON_ROOT.test(file) || ICON_HASHED.test(file)) return 'favicon';
  return null;
}

function safeFrameworkDuplicate(files) {
  const paths = files.map((file) => file.path);
  const routeMetadata = (file) => /(?:^|\/)__next\.[^/]+\.txt$/i.test(file) || /(?:^|\/)index\.txt$/i.test(file);
  if (paths.every(routeMetadata)) return 'Next route metadata aliases';
  if (paths.every((file) => /^(?:404\.html|404\/index\.html|_not-found\/index\.html)$/i.test(file))) return '404 route aliases';
  const rootIcon = paths.filter((file) => ICON_ROOT.test(file));
  const hashedIcon = paths.filter((file) => ICON_HASHED.test(file));
  if (paths.length === 2 && rootIcon.length === 1 && hashedIcon.length === 1) {
    const rootFamily = rootIcon[0].match(/^(favicon|apple-icon|icon)/i)?.[1].toLowerCase();
    const hashedFamily = hashedIcon[0].match(/^_next\/static\/media\/(favicon|apple-icon|icon)\./i)?.[1].toLowerCase();
    if (rootFamily === hashedFamily) return 'Next hashed copy of a canonical icon';
  }
  if (paths.every((file) => WEBPACK_ROUTE_CHUNK.test(file))) {
    const wrappers = files.map((file) => fs.readFileSync(file.absolute, 'utf8'));
    const matchesWrapper = (contents) => WEBPACK_ROUTE_WRAPPER.test(contents) || WEBPACK_EMPTY_ROUTE_WRAPPER.test(contents);
    if (wrappers.every(matchesWrapper)) return 'Webpack route wrapper chunks';
  }
  return null;
}

function duplicateGroups(files) {
  const byHash = new Map();
  for (const file of files) {
    const hash = createHash('sha256').update(fs.readFileSync(file.absolute)).digest('hex');
    const group = byHash.get(hash) ?? [];
    group.push(file.path);
    byHash.set(hash, group);
  }
  return [...byHash.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([sha256, rawPaths]) => {
      const paths = rawPaths.sort();
       const safeReason = safeFrameworkDuplicate(rawPaths.map((filePath) => files.find((file) => file.path === filePath)));
      return { sha256, paths, safe: Boolean(safeReason), policy: safeReason ?? 'Unsafe exact duplicate content' };
    })
    .sort((a, b) => compareStrings(a.paths[0], b.paths[0]));
}

export function auditGeneratedAssets(exportDirectory = DEFAULT_EXPORT_DIR) {
  const root = path.resolve(exportDirectory);
  const base = {
    schemaVersion: SCHEMA_VERSION,
    policyVersion: POLICY_VERSION,
    exportDir: relativePath(REPO_ROOT, root) || '.',
    filesScanned: 0,
    forbiddenArtifacts: [],
    sourceMaps: [],
    debugArtifacts: [],
    duplicates: [],
    unsafeDuplicates: [],
    generatedAssets: { og: [], favicon: [] },
    failures: [],
  };
  const rootStat = fs.existsSync(root) ? fs.lstatSync(root) : null;
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    return { ...base, ok: false, status: 'failed', failures: [`export directory absent: ${relativePath(REPO_ROOT, root)}`] };
  }

  const files = listFiles(root).map((absolute) => ({
    absolute,
    path: relativePath(root, absolute),
    regular: fs.lstatSync(absolute).isFile(),
  }));
  const forbiddenArtifacts = files.map(({ path: file, regular }) => ({ path: file, kind: forbiddenKind(file, regular) }))
    .filter((item) => item.kind)
    .sort((a, b) => compareStrings(a.kind, b.kind) || compareStrings(a.path, b.path));
  const duplicates = duplicateGroups(files.filter(({ regular }) => regular));
  const unsafeDuplicates = duplicates.filter((group) => !group.safe);
  const generatedAssets = { og: [], favicon: [] };
  for (const file of files.filter(({ regular }) => regular)) {
    const kind = generatedKind(file.path);
    if (kind) generatedAssets[kind].push(file.path);
  }
  generatedAssets.og.sort(compareStrings);
  generatedAssets.favicon.sort(compareStrings);
  const failures = [
    ...forbiddenArtifacts.map(({ kind, path: file }) => `${kind}: ${file}`),
    ...unsafeDuplicates.map(({ paths }) => `unsafe duplicate: ${paths.join(', ')}`),
  ];
  return {
    ...base,
    ok: failures.length === 0,
    status: failures.length ? 'failed' : 'passed',
    filesScanned: files.length,
    forbiddenArtifacts,
    sourceMaps: forbiddenArtifacts.filter(({ kind }) => kind === 'source-map'),
    debugArtifacts: forbiddenArtifacts.filter(({ kind }) => kind !== 'source-map'),
    duplicates,
    unsafeDuplicates,
    generatedAssets,
    failures,
  };
}

export function renderMarkdown(report) {
  const lines = [
    '# Generated asset integrity audit',
    '',
    `Status: **${report.status}** · Export: \`${report.exportDir}\` · Files scanned: ${report.filesScanned}`,
    '',
    `- Source maps: ${report.sourceMaps.length}`,
    `- Debug/source artifacts: ${report.debugArtifacts.length}`,
    `- Duplicate hash groups: ${report.duplicates.length} (${report.unsafeDuplicates.length} unsafe)`,
    `- Generated OG assets: ${report.generatedAssets.og.length}`,
    `- Favicon assets: ${report.generatedAssets.favicon.length}`,
    '',
  ];
  if (report.status === 'failed' && report.filesScanned === 0 && report.failures.length > 0) {
    lines.push('Export directory is absent; the audit failed closed.', '');
  }
  if (report.failures.length) lines.push('## Failures', '', ...report.failures.map((failure) => `- ${failure}`), '');
  lines.push('Policy: source maps, leaked TypeScript, named debug artifacts, non-regular entries, and unsafe exact duplicate content fail; Next route-metadata aliases, 404 aliases, canonical-to-hashed icon copies, and exact Webpack route-wrapper chunks are reported as safe duplicates.', '');
  return lines.join('\n');
}

function cliOptions(argv) {
  let directory;
  let format = 'markdown';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json' || argument === '--format=json' || (argument === '--format' && argv[index + 1] === 'json')) format = 'json';
    else if (!argument.startsWith('-') && !directory && !(argv[index - 1] === '--format')) directory = argument;
  }
  return { directory: directory ?? DEFAULT_EXPORT_DIR, format };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const { directory, format } = cliOptions(process.argv.slice(2));
  const report = auditGeneratedAssets(directory);
  process.stdout.write(format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${renderMarkdown(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}
