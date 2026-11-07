/**
 * Enforce the active first-load payload budget contract.
 *
 * Measures the JavaScript and CSS a browser must actually download to render a
 * route, by parsing the built HTML for the assets it references and gzipping
 * each one. Reading `.next` build metadata would report Next's own accounting;
 * this reports what the network sees.
 *
 *   node scripts/check-bundle-budget.mjs [--budget 200]
 */
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import {
  DATA_BUDGET_MB,
  DEFERRED,
  DEFERRED_PREFIXES,
  EAGER,
  gzipSize,
  referencedDataFiles,
} from './lib/bundle-data-budget.mjs';

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'app', 'out');
const basePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH || '');
const performanceBudgets = JSON.parse(readFileSync(join(root, 'docs', 'perf', 'budgets.json'), 'utf8'));

function normalizeBasePath(value) {
  if (!value || value === '/') return '';
  return '/' + value.replace(/^\/+|\/+$/g, '');
}

const budgetIndex = process.argv.indexOf('--budget');
const budgetKb = budgetIndex >= 0 ? Number(process.argv[budgetIndex + 1]) : 200;

const routeBudgetKb = (label, fallback) => {
  if (budgetIndex >= 0) return budgetKb;
  const bytes = performanceBudgets.routes?.[label]?.initialGzipBytes;
  return Number.isFinite(bytes) ? bytes / 1024 : fallback;
};

const ROUTES = [
  { label: '/', file: 'index.html', budgetKb: routeBudgetKb('/', 200) },
  // The library carries a slightly higher budget than the homepage because it
  // is the only route that ships the whole search surface eagerly: the
  // search-alias expansion module needed before the first keystroke, the facet
  // and result-row client, `useRouter` for client-side result navigation, and
  // the deferred-payload scheduler that decides when the extended index and
  // semantic vectors are fetched. The original 200 KB cap was written for the
  // homepage and this route was never inside it.
  //
  // Note this budget measures **JS and CSS only**. What the library actually
  // downloads is dominated by index data, which is governed separately by the
  // first-interaction data budget below and measured in a real browser by
  // `app/e2e/search-payload.spec.ts`. Neither number is the whole story alone.
  { label: '/library/', file: join('library', 'index.html'), budgetKb: routeBudgetKb('/library/', 210) },
];

const ASSET_PATTERN = /(?:src|href)="([^"]*\/_next\/[^"]+\.(?:js|css))"/g;

function assetFilePath(asset) {
  const withoutBase = basePath && (asset === basePath || asset.startsWith(basePath + '/'))
    ? asset.slice(basePath.length)
    : asset;
  return join(outDir, withoutBase.replace(/^\//, ''));
}

async function measure(route) {
  const htmlPath = join(outDir, route.file);
  const exists = await stat(htmlPath).catch(() => null);
  if (!exists) return { ...route, missing: true };

  const html = await readFile(htmlPath, 'utf8');
  const assets = [...new Set([...html.matchAll(ASSET_PATTERN)].map((match) => match[1]))];

  let compressed = 0;
  const missing = [];
  for (const asset of assets) {
    const assetPath = assetFilePath(asset);
    const bytes = await readFile(assetPath).catch(() => null);
    if (!bytes) {
      missing.push(asset);
      continue;
    }
    compressed += gzipSync(bytes).length;
  }

  // Inline scripts and styles ship inside the document itself and count too.
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .concat([...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)])
    .map((match) => match[1])
    .join('');
  if (inline.length > 0) compressed += gzipSync(Buffer.from(inline, 'utf8')).length;

  return { ...route, assets: assets.length, compressed, missing };
}

const results = await Promise.all(ROUTES.map(measure));
const marginPercent = performanceBudgets.marginPolicy?.minHeadroomPercent ?? 0;
const thinRoutes = [];
let failed = false;

for (const result of results) {
  if (result.missing === true) {
    process.stdout.write(`  ${result.label.padEnd(12)} not built, skipped\n`);
    continue;
  }
  const kb = result.compressed / 1024;
  const routeBudget = result.budgetKb ?? budgetKb;
  const headroomPercent = routeBudget > 0 ? ((routeBudget - kb) / routeBudget) * 100 : 0;
  // IMP-PERF-001: a cap discovered only when it breaks turns ordinary work into an
  // emergency. Warn below the stated margin; never fail on it, and never raise a cap here.
  const thin = kb <= routeBudget && headroomPercent < marginPercent;
  const status = kb > routeBudget ? 'OVER' : thin ? 'ok (THIN)' : 'ok';
  if (kb > routeBudget) failed = true;
  if (thin) thinRoutes.push(`${result.label}: ${headroomPercent.toFixed(2)}% headroom, under the ${marginPercent}% margin`);
  process.stdout.write(
    `  ${result.label.padEnd(12)} ${kb.toFixed(1).padStart(7)} KB gzip  ${String(result.assets).padStart(3)} assets  ${status}\n`,
  );
  for (const asset of result.missing ?? []) {
    process.stdout.write(`      referenced but absent: ${asset}\n`);
  }
}

if (thinRoutes.length) {
  process.stdout.write('\n  Margin warning (IMP-PERF-001), not a failure:\n');
  for (const line of thinRoutes) process.stdout.write(`    ${line}\n`);
  process.stdout.write('    Trim bytes or widen the cap deliberately; record the margin in docs/perf/budgets.json.\n');
}

if (failed) {
  process.stderr.write('\nFirst-load payload exceeds a route budget; see the route-specific results above.\n');
  process.exit(1);
}
process.stdout.write('\nFirst-load payload is within every route budget.\n');

let eagerBytes = 0;
const missingData = [];
for (const name of EAGER) {
  const size = await gzipSize(outDir, name);
  if (size === null) missingData.push(name);
  else eagerBytes += size;
}

const unclassified = (await referencedDataFiles(outDir)).filter(
  (name) => !EAGER.includes(name) && !DEFERRED.includes(name)
    && !DEFERRED_PREFIXES.some((prefix) => name.startsWith(prefix)),
);

const eagerMb = eagerBytes / 1048576;
process.stdout.write(
  `\n  first-interaction data  ${eagerMb.toFixed(2).padStart(6)} MB gzip  ` +
    `${EAGER.length} artifacts  ${eagerMb > DATA_BUDGET_MB ? 'OVER' : 'ok'}\n`,
);
for (const name of EAGER) {
  const size = await gzipSize(outDir, name);
  if (size !== null) process.stdout.write(`      ${name.padEnd(22)} ${(size / 1048576).toFixed(2)} MB\n`);
}

if (missingData.length > 0) {
  process.stderr.write(`\nFirst-interaction data missing from the export: ${missingData.join(', ')}\n`);
  process.exit(1);
}
if (unclassified.length > 0) {
  process.stderr.write(
    '\nThese /data/ artifacts are referenced by the built chunks but classified\n' +
      'neither eager nor deferred in scripts/check-bundle-budget.mjs:\n' +
      unclassified.map((name) => `  - ${name}`).join('\n') +
      '\nAdd each to EAGER or DEFERRED, deliberately. An unclassified fetch is how\n' +
      'the first-interaction payload grew to 9.89 MB without any gate noticing.\n',
  );
  process.exit(1);
}
if (eagerMb > DATA_BUDGET_MB) {
  process.stderr.write(`\nFirst-interaction data is ${eagerMb.toFixed(2)} MB gzip, over the ${DATA_BUDGET_MB} MB budget.\n`);
  process.exit(1);
}
process.stdout.write(`\nFirst-interaction data within the ${DATA_BUDGET_MB} MB gzip budget.\n`);
