import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditEmittedScannerWorker,
  findEmittedArtifactViolations,
  maskJavaScript,
  resolveEmittedScannerWorker,
} from './emitted-browser-safe.mjs';

export { auditEmittedScannerWorker, findEmittedArtifactViolations, resolveEmittedScannerWorker };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const targetDirs = [
  path.join(repoRoot, 'app/src/scanner'),
  // The app-local parser layer was deleted in packet 5.2c (scanner-core is the only parser
  // authority). The entry stays so a reintroduced layer here is still audited before it ships.
  path.join(repoRoot, 'app/src/workflow'),
  path.join(repoRoot, 'contracts'),
  path.join(repoRoot, 'packages/scanner-core/src'),
];
const targetFiles = [path.join(repoRoot, 'app/src/search/facet-bitset.ts')];
const ignoreMarker = '// browser-safe-ignore';
const nodeModuleImport = /(?:\bfrom\s*|\bimport\s+(?:[\w*{},\s]+\s+from\s*)?|\b(?:import|require)\s*\(\s*)["'](?:node:)?(?:fs|path|crypto|child_process|os|util|stream|buffer|events|http|https|net|tls|url|vm|zlib|worker_threads)(?:\/[^"']*)?["']/;
const dynamicImport = /\bimport\s*\(\s*([^)]*)\)/;
const forbiddenChecks = [
  { name: 'Buffer usage', pattern: /\bBuffer\b/ },
  { name: 'process usage', pattern: /\bprocess\b/ },
  { name: 'require(...) call', pattern: /\brequire\s*\(/ },
  { name: 'fetch() call', pattern: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest usage', pattern: /\bXMLHttpRequest\b/ },
  { name: 'WebSocket usage', pattern: /\bWebSocket\b/ },
  { name: 'EventSource usage', pattern: /\bEventSource\b/ },
  { name: 'navigator.sendBeacon usage', pattern: /\bsendBeacon\b/ },
];

function firstExecutableMatch(line, codeLine, pattern) {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  for (const match of line.matchAll(matcher)) {
    if (codeLine[match.index] && !/\s/.test(codeLine[match.index])) return match;
  }
  return null;
}

function isNodeImport(line, codeLine) {
  return Boolean(firstExecutableMatch(line, codeLine, nodeModuleImport));
}

function isNonLocalDynamicImport(line, codeLine) {
  const match = firstExecutableMatch(line, codeLine, dynamicImport);
  if (!match) return false;
  const specifier = match[1].trim();
  const local = specifier.match(/^(['"])(.*?)\1$/);
  return !local || !local[2].startsWith('./') && !local[2].startsWith('../');
}

export function findForbiddenCheck(line, options = {}) {
  const hasIgnore = line.trimEnd().endsWith(ignoreMarker);
  if (hasIgnore) {
    if (options.testOnly === true) return null;
    return 'browser-safe-ignore directive outside test-only file';
  }
  const codeLine = options.codeLine ?? maskJavaScript(line);
  if (options.testOnly !== true && isNodeImport(line, codeLine)) return 'node: import or module reference';
  if (isNonLocalDynamicImport(line, codeLine)) return 'non-local dynamic import() call (remote code loading)';
  return forbiddenChecks.find((check) => check.pattern.test(codeLine))?.name ?? null;
}

function scanFile(full, violations) {
  if (!fs.existsSync(full)) return;
  const source = fs.readFileSync(full, 'utf8');
  const rawLines = source.split(/\r?\n/);
  const codeLines = maskJavaScript(source).split(/\r?\n/);
  const testOnly = /\.test\.tsx?$/.test(path.basename(full));
  rawLines.forEach((line, index) => {
    const checkName = findForbiddenCheck(line, { testOnly, codeLine: codeLines[index] ?? '' });
    if (!checkName) return;
    violations.push({ file: full, line: index + 1, checkName, source: line });
  });
}

function scan(dir, violations) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(full, violations);
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) scanFile(full, violations);
  }
}

function reportSourceViolations(violations) {
  for (const violation of violations) {
    const rel = path.relative(repoRoot, violation.file).replace(/\\/g, '/');
    console.error(rel + ':' + violation.line + ': ' + violation.checkName + ' -> "' + violation.source.trim() + '"');
  }
}

export function main(args = process.argv.slice(2), options = {}) {
  const sourceDirs = options.sourceDirs ?? targetDirs;
  const sourceFiles = options.sourceFiles ?? targetFiles;
  const sourceViolations = [];
  sourceDirs.forEach((dir) => scan(dir, sourceViolations));
  sourceFiles.forEach((file) => scanFile(file, sourceViolations));
  reportSourceViolations(sourceViolations);
  if (sourceViolations.length === 0) {
    console.log('Browser-safe source audit passed (source-only; emitted artifacts require --emitted).');
  }

  if (!args.includes('--emitted')) return sourceViolations.length > 0 ? 1 : 0;
  const configuredOutputDir = options.outputDir ?? process.env.BROWSER_SAFE_BUILD_DIR;
  const outputDir = configuredOutputDir ? path.resolve(configuredOutputDir) : path.join(repoRoot, 'app', 'out');
  try {
    const minimumBytes = options.minimumWorkerBytes ?? options.minimumBytes;
    const result = auditEmittedScannerWorker(outputDir, { minimumBytes });
    for (const artifact of result.artifacts) {
      const rel = path.relative(repoRoot, artifact.file).replace(/\\/g, '/');
      console.log(rel + ': ' + artifact.bytes + ' bytes sha256=' + artifact.sha256);
    }
    result.violations.forEach((violation) => {
      const rel = path.relative(repoRoot, violation.artifact).replace(/\\/g, '/');
      console.error(rel + ':' + violation.line + ':' + violation.column + ': ' + violation.name);
    });
    if (result.violations.length === 0) {
      console.log('Emitted scanner worker audit passed: ' + result.workerFiles.length + ' artifacts, '
        + result.totalBytes + ' bytes total.');
    } else {
      console.error('Emitted scanner worker audit found ' + result.violations.length + ' violation(s) in '
        + result.workerFiles.length + ' artifacts.');
    }
    return sourceViolations.length + result.violations.length > 0 ? 1 : 0;
  } catch (error) {
    console.error('Emitted scanner worker audit failed: '
      + (error instanceof Error ? error.message : 'unknown error'));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) process.exit(main());
