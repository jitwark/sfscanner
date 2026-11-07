#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css']);
const SKIP = new Set(['node_modules', 'out', 'out-canary', '.next', '.types']);
const CLASSIFICATIONS = ['critical', 'user-triggered', 'viewport-triggered', 'idle', 'never'];

function posix(value) { return value.replaceAll('\\', '/'); }
function rel(root, file) { return posix(relative(root, file)); }
function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIP.has(entry.name)) files.push(...walk(resolve(directory, entry.name)));
    else if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) files.push(resolve(directory, entry.name));
  }
  return files;
}
function sourceFiles(appRoot) {
  return walk(appRoot).filter((file) => !/(^|[\\/])(__fixtures__|e2e)([\\/]|$)/.test(file) && !/\.(test|spec)\.[^.]+$/.test(file) && !file.endsWith('.d.ts')).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
function routeFor(appRoot, file) {
  const parts = rel(appRoot, file).split('/').slice(0, -1);
  if (!parts.length) return '/';
  return `/${parts.map((part) => part.startsWith('[[...') ? `*${part.slice(5, -2)}?` : part.startsWith('[...') ? `*${part.slice(4, -1)}` : part.startsWith('[') ? `:${part.slice(1, -1)}` : part).join('/')}/`;
}
function resolveImport(from, specifier, appRoot, files) {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return null;
  const base = specifier.startsWith('@/') ? resolve(appRoot, specifier.slice(2)) : resolve(dirname(from), specifier);
  const candidates = [base, ...[...EXTENSIONS].map((extension) => `${base}${extension}`), ...[...EXTENSIONS].map((extension) => resolve(base, `index${extension}`))];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}
function importsFor(file, source, appRoot, files) {
  const edges = [];
  const add = (kind, match, specifier) => {
    const target = resolveImport(file, specifier, appRoot, files);
    if (target) edges.push({ kind, target, specifier, index: match.index });
  };
  for (const match of source.matchAll(/\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)) {
    if (/typeof\s*$/.test(source.slice(Math.max(0, match.index - 20), match.index))) continue;
    add('dynamic', match, match[2]);
  }
  for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^;]*?\sfrom\s*)?(['"])([^'"]+)\1/g)) add('static', match, match[2]);
  return edges;
}
function lineAt(source, index) { return source.slice(0, index).split(/\r?\n/).length; }
function evidenceAt(source, index) { return source.split(/\r?\n/)[lineAt(source, index) - 1]?.trim().slice(0, 180) ?? ''; }
function artifactFor(source, index, file = '') {
  const context = source.slice(Math.max(0, index - 1500), index + 500);
  const nearby = source.slice(Math.max(0, index - 500), index + 220);
  const rules = [
    ['semantic-index.json', '/data/semantic-index.json', 'large'], ['search-index-extended.json', '/data/search-index-extended.json', 'large'],
    ['search-index.json', '/data/search-index.json', 'large'], ['facets.json', '/data/facets.json', 'bounded'],
    ['detail-index-', '/data/details/detail-index-*.json', 'bounded'], ['detail-', '/data/details/detail-*.jsonl', 'bounded'],
    ['preview-index-', '/data/previews/preview-index-*.json', 'bounded'], ['preview-', '/data/previews/preview-*.jsonl', 'bounded'],
    ['chart-', '/data/charts/chart-*.jsonl', 'bounded'], ['pack-', '/data/packs/pack-*.jsonl', 'large'], ['manifest.json', '/data/manifest.json', 'bounded'],
  ];
  if (/catalogue[\\/]download\./.test(file)) return { target: '/data/packs/pack-*.jsonl', size: 'large' };
  if (/entry-detail-client\./.test(file) && /fetch\s*\(\s*path/.test(source.slice(index, index + 120))) return { target: '/data/details/detail-*.jsonl', size: 'bounded' };
  if (/preview-client\./.test(file) && /fetch\s*\(\s*path/.test(source.slice(index, index + 120))) return { target: '/data/previews/preview-*.jsonl', size: 'bounded' };
  const match = rules.find(([needle]) => nearby.includes(needle)) ?? rules.find(([needle]) => context.includes(needle));
  return match ? { target: match[1], size: match[2] } : { target: 'dynamic fetch URL', size: 'unknown' };
}
function routeSets(routeEntrypoints, special, edges) {
  const staticRoutes = new Map(); const allRoutes = new Map(); const dynamicRoutes = new Map();
  const add = (map, file, route) => map.set(file, new Set([...(map.get(file) ?? []), route]));
  for (const entry of routeEntrypoints) {
    for (const [map, allowed] of [[staticRoutes, new Set(['static'])], [allRoutes, new Set(['static', 'dynamic'])]]) {
      const queue = [entry.file, ...entry.layouts].map((file) => [file, false]); const seen = new Set();
      while (queue.length) { const [file, dynamic] = queue.shift(); if (seen.has(`${file}:${dynamic}`)) continue; seen.add(`${file}:${dynamic}`); add(map, file, entry.route); if (dynamic) add(dynamicRoutes, file, entry.route); for (const edge of edges.get(file) ?? []) if (allowed.has(edge.kind)) queue.push([edge.target, dynamic || edge.kind === 'dynamic']); }
    }
  }
  for (const [file, route] of special) { add(staticRoutes, file, route); add(allRoutes, file, route); }
  return { staticRoutes, allRoutes, dynamicRoutes };
}
function classify(kind, { source, index, target, file, staticRoutes, dynamicRoutes, allRoutes }) {
  const context = source.slice(Math.max(0, index - 450), index + 300);
  if (/audit:(?:classification|load)\s*=\s*never/.test(context) || !allRoutes.size) return 'never';
  if (kind === 'client-boundary' || kind === 'font' || kind === 'image' || kind === 'chart') return staticRoutes.size ? 'critical' : dynamicRoutes.size ? 'user-triggered' : 'never';
  if (kind === 'dynamic-import') {
    if (/query-state-catalogue/.test(target)) return staticRoutes.size ? 'critical' : dynamicRoutes.size ? 'user-triggered' : 'never';
    if (/fetch-index|fallback-engine/.test(file)) return 'idle';
    if (/semantic-index-artifact|workflow-chart|facet-sheet|scanner-guide-content|library-(?:alternatives|search-error)/.test(target) || /onClick|onSubmit|exploreInteractive|requestSemanticVectorsFor/.test(context)) return 'user-triggered';
    if (/catalogue\/manifest/.test(target) && /library-client/.test(file)) return 'user-triggered';
    if (/IntersectionObserver|isIntersecting/.test(context)) return 'viewport-triggered';
    if (/requestIdleCallback|setTimeout\s*\(/.test(context)) return 'idle';
    return staticRoutes.size ? 'critical' : dynamicRoutes.size ? 'user-triggered' : 'never';
  }
  if (/IntersectionObserver|isIntersecting/.test(context)) return 'viewport-triggered';
  if (/requestIdleCallback|setTimeout\s*\(/.test(context)) return 'idle';
  if (kind === 'worker') {
    if (/search-client-runtime|startWarm|warmIndex/.test(file + context)) return 'idle';
    if (/run-scan|scanner|runScan/.test(file + context)) return 'user-triggered';
    return staticRoutes.size ? 'critical' : dynamicRoutes.size ? 'user-triggered' : 'never';
  }
  if (kind === 'data-request') {
    if (/semantic-index|detail-|preview-|chart-|packs\//.test(target)) return 'user-triggered';
    if (/search-index|facets|extended/.test(target)) return 'idle';
    return staticRoutes.size ? 'critical' : dynamicRoutes.size ? 'user-triggered' : 'never';
  }
  return staticRoutes.size ? 'critical' : dynamicRoutes.size ? 'user-triggered' : 'never';
}
function addFinding(findings, kind, file, source, index, target, routeMaps, extra = {}) {
  const fileName = rel(routeMaps.root ?? REPO_ROOT, file); const allRoutes = [...(routeMaps.allRoutes.get(file) ?? [])].sort();
  findings.push({ kind, file: fileName, line: lineAt(source, index), target, evidence: evidenceAt(source, index), routes: allRoutes, classification: classify(kind, { source, index, target, file: fileName, staticRoutes: routeMaps.staticRoutes.get(file) ?? new Set(), dynamicRoutes: routeMaps.dynamicRoutes.get(file) ?? new Set(), allRoutes: routeMaps.allRoutes.get(file) ?? new Set() }), ...extra });
}

export function auditClientBoundaries(rootOrOptions = REPO_ROOT) {
  const root = typeof rootOrOptions === 'string' ? resolve(rootOrOptions) : resolve(rootOrOptions.rootDir ?? REPO_ROOT);
  const appRoot = resolve(root, 'app'); const routeRoot = resolve(appRoot, 'app'); const files = sourceFiles(appRoot); const fileSet = new Set(files); const edges = new Map();
  const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
  for (const [file, source] of sources) edges.set(file, importsFor(file, source, appRoot, fileSet));
  const inRouteTree = (file) => file.startsWith(routeRoot + '/') || file.startsWith(routeRoot + String.fromCharCode(92));
  const layouts = files.filter((file) => inRouteTree(file) && /(^|[\\/])layout\.[^.]+$/.test(file));
  const routeEntrypoints = files.filter((file) => inRouteTree(file) && /(^|[\\/])page\.[^.]+$/.test(file)).map((file) => ({ file, route: routeFor(routeRoot, file), layouts }));
  const special = files.filter((file) => inRouteTree(file) && /(^|[\\/])(?:error|not-found)\.[^.]+$/.test(file)).map((file) => [file, `special:${file.match(/(?:error|not-found)\./)?.[0].slice(0, -1)}`]);
  const routeMaps = { ...routeSets(routeEntrypoints, special, edges), root }; const findings = [];
  for (const [file, source] of sources) {
    const client = /^\s*['"]use client['"]/.test(source); if (client) addFinding(findings, 'client-boundary', file, source, source.search(/['"]use client['"]/), rel(root, file), routeMaps);
    for (const match of source.matchAll(/\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)) if (!/typeof\s*$/.test(source.slice(Math.max(0, match.index - 20), match.index))) addFinding(findings, 'dynamic-import', file, source, match.index, match[2], routeMaps);
    for (const match of source.matchAll(/new\s+Worker\s*\([\s\S]*?new\s+URL\s*\(\s*(['"`])([^'"`]+)\1/gi)) addFinding(findings, 'worker', file, source, match.index, match[2], routeMaps);
    for (const match of source.matchAll(/(?:from\s+|import\s+)(['"])([^'"]*next\/font[^'"]*)\1/g)) addFinding(findings, 'font', file, source, match.index, match[2], routeMaps);
    const fontFace = source.search(/^\s*@font-face\b/m); if (fontFace >= 0) addFinding(findings, 'font', file, source, fontFace, '@font-face', routeMaps);
    for (const match of source.matchAll(/<img\b[^>]*\bsrc\s*=\s*['"]([^'"]+)|<Image\b|from\s+['"]next\/image['"]|url\(\s*['"]?([^'"\s)]+\.(?:png|jpe?g|webp|avif|gif|svg))['"]?\s*\)/gi)) addFinding(findings, 'image', file, source, match.index, match[1] ?? match[2] ?? (match[0].includes('next/image') ? 'next/image' : rel(root, file)), routeMaps);
    if (/(^|[\\/])(?:chart|workflow-chart|chart-loader|static-preview)[^\\/]*\.[jt]sx?$|[\\/]ui[\\/]analytics[\\/]/.test(file)) addFinding(findings, 'chart', file, source, Math.max(0, source.search(/chart|canvas|<svg/i)), rel(root, file), routeMaps);
    for (const match of source.matchAll(/\bfetch\s*\(/g)) { const artifact = artifactFor(source, match.index, file); addFinding(findings, 'data-request', file, source, match.index, artifact.target, routeMaps, { size: artifact.size }); }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind));
  return { schemaVersion: 'client-boundary-inventory-v1', root: '.', filesScanned: files.length, routeEntrypoints: routeEntrypoints.map(({ file, route }) => ({ route, file: rel(root, file) })), findings };
}

export function renderInventoryReport(inventory) {
  const counts = Object.fromEntries(CLASSIFICATIONS.map((classification) => [classification, inventory.findings.filter((item) => item.classification === classification).length]));
  const kinds = ['client-boundary', 'dynamic-import', 'worker', 'font', 'image', 'chart', 'data-request'];
  const lines = ['# Local client-boundary and lazy-loading inventory', '', `Schema: \`${inventory.schemaVersion}\` · Source files scanned: ${inventory.filesScanned} · Findings: ${inventory.findings.length}`, '', '## Evidence boundary', '', '- Static evidence: source text, import reachability, route entrypoints, and explicit trigger APIs found by the CPU-only scanner.', '- Not proven here: browser request/coverage traces, chunk absence from initial requests, deployed headers, Web Vitals, memory, or device CPU.', '- Slice decision: no boundary or hidden-mount fix is recorded; any removal/splitting decision requires the deployed/browser evidence listed below.', '', `Classification counts: ${CLASSIFICATIONS.map((item) => `${item} ${counts[item]}`).join(' · ')}`, `Kind counts: ${kinds.map((item) => `${item} ${inventory.findings.filter((finding) => finding.kind === item).length}`).join(' · ')}`, '', '## Route entrypoints', '', ...inventory.routeEntrypoints.map((entry) => `- \`${entry.route}\` — \`${entry.file}\``), '', '## Findings', '', '| Kind | Class | Size | Routes | File:line | Target | Static evidence |', '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const item of inventory.findings) lines.push(`| ${item.kind} | ${item.classification} | ${item.size ?? '—'} | ${(item.routes.length ? item.routes.join(', ') : 'unreachable')} | ${item.file}:${item.line} | ${String(item.target).replaceAll('|', '\\|')} | ${item.evidence.replaceAll('|', '\\|')} |`);
  lines.push('', '## Follow-up requiring deployed/browser evidence', '', 'Run a deployed request/coverage trace for representative `/`, `/library/`, `/scanner/`, `/w/:slug/`, and `/w/view/` journeys. Confirm that idle, user-triggered, viewport-triggered, and never findings are absent from the initial request set; this local report intentionally does not claim that result.', '');
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const rootIndex = process.argv.indexOf('--root'); const outIndex = process.argv.indexOf('--write');
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : REPO_ROOT; const inventory = auditClientBoundaries(root); const report = renderInventoryReport(inventory);
  if (outIndex >= 0) { const output = resolve(root, process.argv[outIndex + 1] ?? 'client-boundary-inventory.md'); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, report); console.log(`Wrote ${rel(root, output)} (${inventory.findings.length} findings).`); }
  else process.stdout.write(report);
}
