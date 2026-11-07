#!/usr/bin/env node
/** Measure the metrics represented by docs/perf/budgets.json from app/out. */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'app', 'out');
const basePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH || '');
const defaultOutput = join(root, 'pipeline', '.work', 'performance-budget-snapshot.json');
const routes = { '/': 'index.html', '/library/': join('library', 'index.html') };
const assetPattern = /(?:src|href)="([^\"]*\/_next\/[^\"]+\.(?:js|css))"/g;

function normalizeBasePath(value) {
  if (!value || value === '/') return '';
  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}

function assetPath(asset) {
  if (
    asset.startsWith('//') ||
    asset.includes('\\') ||
    asset.includes('\0') ||
    /^[a-z][a-z\d+.-]*:/i.test(asset)
  ) {
    throw new Error(`Refusing non-local asset reference: ${asset}`);
  }

  let withoutBase = asset;
  if (basePath) {
    if (!asset.startsWith(`${basePath}/`)) {
      throw new Error(`Asset reference is not under configured base path ${basePath}: ${asset}`);
    }
    withoutBase = asset.slice(basePath.length);
  }
  if (!withoutBase.startsWith('/_next/')) {
    throw new Error(`Asset reference does not resolve under /_next after base path stripping: ${asset}`);
  }

  const file = resolve(outDir, withoutBase.slice(1));
  const confined = relative(outDir, file);
  if (confined === '..' || confined.startsWith(`..${sep}`) || isAbsolute(confined)) {
    throw new Error(`Asset reference escapes app/out: ${asset}`);
  }
  return file;
}

async function measureRoute(file) {
  const html = await readFile(join(outDir, file), 'utf8');
  const assets = [...new Set([...html.matchAll(assetPattern)].map((match) => match[1]))];
  let compressed = 0;
  for (const asset of assets) compressed += gzipSync(await readFile(assetPath(asset))).length;
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .concat([...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)])
    .map((match) => match[1]).join('');
  if (inline) compressed += gzipSync(Buffer.from(inline, 'utf8')).length;
  return { initialGzipBytes: compressed, assets: assets.length };
}

async function walk(directory) {
  let files = 0;
  let rawBytes = 0;
  let htmlBytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await walk(file);
      files += nested.files; rawBytes += nested.rawBytes; htmlBytes += nested.htmlBytes;
      continue;
    }
    const size = (await stat(file)).size;
    files += 1; rawBytes += size;
    if (entry.name.endsWith('.html')) htmlBytes += size;
  }
  return { files, rawBytes, htmlBytes };
}

async function measureData() {
  let gzipBytes = 0;
  for (const name of ['search-index.json', 'facets.json']) {
    gzipBytes += gzipSync(await readFile(join(outDir, 'data', name))).length;
  }
  return { gzipBytes, artifacts: 2 };
}

export async function measureBudgets() {
  const measuredRoutes = {};
  for (const [route, file] of Object.entries(routes)) measuredRoutes[route] = await measureRoute(file);
  return {
    schemaVersion: 'performance-budget-snapshot-v1',
    capturedAt: new Date().toISOString(),
    source: 'app/out',
    routes: measuredRoutes,
    firstInteraction: await measureData(),
    export: await walk(outDir),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const outputIndex = process.argv.indexOf('--out');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] || defaultOutput : defaultOutput;
  const snapshot = await measureBudgets();
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`Measured performance budgets: ${output}\n`);
}
