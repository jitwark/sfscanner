import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOTS = ['app/src', 'pipeline'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIPPED_DIRECTORIES = new Set([
  '.next', '.work', 'build', 'coverage', 'dist', 'fixtures', 'node_modules', 'out', '__fixtures__', '__mocks__', '__tests__',
]);
const TEST_FILE = /(?:^|\.)(?:test|spec)\.[^.]+$/u;
const API_PATTERNS = [
  { name: 'Date.now', pattern: /\bDate\s*\.\s*now\b/gu },
  { name: 'Math.random', pattern: /\bMath\s*\.\s*random\b/gu },
];

// These are the complete, counted exceptions. Keep their purposes here so a
// new clock/RNG read in an allowlisted file still fails as allowlist drift.
const ALLOWLIST = [
  // Date.now is only the browser worker's host correlation ID; it never enters a report.
  { paths: { 'app/src/scanner/run-scan.ts': { 'Date.now': 1 } }, reason: 'host-only worker correlation ID; deterministic callers inject a seed or factory' },
  // Cache timestamps and retry deadlines affect local cache scheduling, never scan output.
  { paths: { 'app/src/search/deferred-payloads.ts': { 'Date.now': 1 }, 'app/src/search/index-cache.ts': { 'Date.now': 2 } }, reason: 'search retry/cache metadata outside canonical scan results' },
  // Wall-clock measurements are reporting telemetry and are not scanner/corpus identity inputs.
  { paths: { 'pipeline/build-corpus.ts': { 'Date.now': 12 }, 'pipeline/enrich/describe.ts': { 'Date.now': 2 }, 'pipeline/enrich/describe-batch-cli.ts': { 'Date.now': 2 }, 'pipeline/acquire/n8n-official.ts': { 'Date.now': 2 } }, reason: 'elapsed-time measurements in human/CLI status output' },
  // The official source timestamp records acquisition time; retry jitter only schedules HTTP retries.
  { paths: { 'pipeline/acquire/n8n-official.ts': { 'Date.now': 1 }, 'pipeline/acquire/fetch-ids.ts': { 'Date.now': 1 }, 'pipeline/acquire/official-http.ts': { 'Math.random': 1 } }, reason: 'acquisition-time provenance and injectable retry jitter, not scanner analysis' },
  // Current time only selects stale scratch work for cleanup; it does not affect retained entries.
  { paths: { 'pipeline/acquire/clean-old-runs.ts': { 'Date.now': 1 }, 'pipeline/enrich/omp-packet.ts': { 'Date.now': 1 } }, reason: 'age cutoff for stale scratch cleanup' },
  // Defaults preserve unique temporary names in production; stable callers inject clock and RNG.
  // batch-ledger, batch-runner-support, and bundle-promotion are existing temp identity sites outside this slice.
  { paths: { 'pipeline/enrich/describe-spawn.ts': { 'Date.now': 1, 'Math.random': 1 }, 'pipeline/stage-ledger.ts': { 'Date.now': 1, 'Math.random': 1 }, 'pipeline/enrich/batch-ledger.ts': { 'Date.now': 1 }, 'pipeline/enrich/batch-runner-support.ts': { 'Date.now': 1 }, 'pipeline/export/bundle-promotion.ts': { 'Date.now': 1 } }, reason: 'temporary file/directory identity only; assigned writers expose deterministic clock/RNG inputs' },
];

function allowedCounts() {
  const counts = new Map();
  for (const exception of ALLOWLIST) {
    for (const [file, apis] of Object.entries(exception.paths)) {
      for (const [api, count] of Object.entries(apis)) {
        const key = `${file}\0${api}`;
        const previous = counts.get(key);
        counts.set(key, {
          count: (previous?.count ?? 0) + count,
          reason: previous ? `${previous.reason}; ${exception.reason}` : exception.reason,
        });
      }
    }
  }
  return counts;
}

async function sourceFiles(directory, root, found = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) await sourceFiles(path.join(directory, entry.name), root, found);
      continue;
    }
    const extension = path.extname(entry.name);
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extension) || TEST_FILE.test(entry.name)) continue;
    found.push(path.relative(root, path.join(directory, entry.name)).split(path.sep).join('/'));
  }
  return found;
}

function matchesOnCodeLines(source, pattern) {
  const linesWithMatches = [];
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(?:\/\/|\/\*|\*|\*\/)/u.test(line)) continue;
    pattern.lastIndex = 0;
    if ([...line.matchAll(pattern)].length) linesWithMatches.push(index + 1);
  }
  return linesWithMatches;
}

export async function checkDeterminism(root) {
  const exceptions = allowedCounts();
  const observed = new Map();
  const scannedFiles = new Set();
  const violations = [];
  let fileCount = 0;

  for (const sourceRoot of SOURCE_ROOTS) {
    const base = path.join(root, sourceRoot);
    const files = await sourceFiles(base, root);
    for (const file of files) {
      scannedFiles.add(file);
      fileCount += 1;
      const source = await readFile(path.join(root, file), 'utf8');
      for (const api of API_PATTERNS) {
        const matchingLines = matchesOnCodeLines(source, api.pattern);
        if (!matchingLines.length) continue;
        const key = `${file}\0${api.name}`;
        observed.set(key, matchingLines.length);
        const allowed = exceptions.get(key);
        if (!allowed) {
          for (const line of matchingLines) violations.push(`${file}:${line}: uncontrolled ${api.name}; inject a deterministic input or document a reviewed exception`);
        }
      }
    }
  }

  for (const [key, allowed] of exceptions) {
    const [file, api] = key.split('\0');
    if (!scannedFiles.has(file)) continue;
    const count = observed.get(key) ?? 0;
    if (count !== allowed.count) violations.push(`${file}: allowlist drift for ${api}; expected ${allowed.count}, found ${count} (${allowed.reason})`);
  }
  return { fileCount, violations };
}

function parseRoot(args) {
  const index = args.indexOf('--root');
  if (index < 0) return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!args[index + 1]) throw new Error('--root requires a directory');
  return path.resolve(args[index + 1]);
}

const root = parseRoot(process.argv.slice(2));
const result = await checkDeterminism(root);
if (result.violations.length) {
  for (const violation of result.violations) console.error(violation);
  process.exitCode = 1;
} else {
  console.log(`Determinism source check passed (${result.fileCount} production source files scanned; documented clock/RNG exceptions match).`);
}
