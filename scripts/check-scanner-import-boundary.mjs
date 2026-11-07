/**
 * Enforces the scanner-core migration boundary for production scanner code.
 *
 * The app-local workflow/scanner layers are retained for the migration, but
 * new pipeline consumers and scanner-to-workflow dependencies must use the
 * shared @hub/scanner-core package. Tests and fixtures are deliberately out
 * of scope so parity coverage can continue to reference both implementations.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIRECTORIES = Object.freeze([
  'app/src/scanner',
  // The app-local parser layer was deleted in packet 5.2c, so scanner-core is the only parser
  // authority. The entry stays: a reintroduced `app/src/workflow` layer is a boundary violation
  // source again, and `check-scanner-authority` refuses the duplicate declaration outright.
  'app/src/workflow',
  'pipeline/scan',
  'pipeline/cli',
]);
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const IMPORT_RE = /^\s*(?:import\s+(?:[\s\S]*?\sfrom\s+)?|export\s+[\s\S]*?\sfrom\s+)['"]([^'"]+)['"]|^\s*import\s*\(\s*['"]([^'"]+)['"]/gm;

function normalizedRelative(root, file) {
  return relative(root, file).replace(/\\/g, '/');
}

function isWithin(file, directory) {
  const child = relative(directory, file);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function isTestOrFixture(relativePath) {
  const parts = relativePath.split('/');
  const filename = parts.at(-1) ?? '';
  return parts.some((part) => part === '__fixtures__' || part === 'fixtures' || part === 'test' || part === 'tests')
    || /(?:\.test|\.spec|\.test-support)\.[^.]+$/.test(filename);
}

function collectFiles(directory, root, files) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(file, root, files);
    else if (SOURCE_EXTENSIONS.has(extname(entry.name)) && !isTestOrFixture(normalizedRelative(root, file))) files.push(file);
  }
}

export function collectProductionFiles(root) {
  const files = [];
  for (const directory of ROOT_DIRECTORIES) collectFiles(join(root, directory), root, files);
  return files.sort((left, right) => normalizedRelative(root, left).localeCompare(normalizedRelative(root, right)));
}

export function extractImportSpecifiers(source) {
  return [...source.matchAll(IMPORT_RE)].map((match) => ({
    specifier: match[1] ?? match[2],
    index: match.index ?? 0,
  }));
}

function resolveImportTarget(root, importer, specifier) {
  if (specifier === '@/src' || specifier.startsWith('@/src/')) return resolve(root, 'app', specifier.slice(2));
  if (specifier === 'app/src' || specifier.startsWith('app/src/')) return resolve(root, specifier);
  if (specifier.startsWith('./') || specifier.startsWith('../')) return resolve(dirname(importer), specifier);
  return null;
}

function boundaryMessage(importer, target, scannerDirectory, workflowDirectory, pipelineScanDirectory, pipelineCliDirectory) {
  const pipelineConsumer = isWithin(importer, pipelineScanDirectory) || isWithin(importer, pipelineCliDirectory);
  if (pipelineConsumer && isWithin(target, scannerDirectory)) {
    return 'Pipeline production code must use the shared @hub/scanner-core scanner implementation.';
  }
  if (pipelineConsumer && isWithin(target, workflowDirectory)) {
    return 'Pipeline production code must use @hub/scanner-core/workflow instead of the legacy app workflow implementation.';
  }
  if (isWithin(importer, scannerDirectory) && isWithin(target, workflowDirectory)) {
    return 'Scanner production code must use @hub/scanner-core/workflow instead of the legacy app workflow implementation.';
  }
  if (isWithin(importer, workflowDirectory) && isWithin(target, scannerDirectory)) {
    return 'Workflow production code must not depend on the legacy app scanner implementation; use @hub/scanner-core modules.';
  }
  return null;
}

export function findScannerImportViolations(root) {
  const absoluteRoot = resolve(root);
  const scannerDirectory = resolve(absoluteRoot, 'app/src/scanner');
  const workflowDirectory = resolve(absoluteRoot, 'app/src/workflow');
  const pipelineScanDirectory = resolve(absoluteRoot, 'pipeline/scan');
  const pipelineCliDirectory = resolve(absoluteRoot, 'pipeline/cli');
  const violations = [];
  for (const file of collectProductionFiles(absoluteRoot)) {
    const source = readFileSync(file, 'utf8');
    for (const { specifier, index } of extractImportSpecifiers(source)) {
      const target = resolveImportTarget(absoluteRoot, file, specifier);
      if (!target) continue;
      const message = boundaryMessage(
        file,
        target,
        scannerDirectory,
        workflowDirectory,
        pipelineScanDirectory,
        pipelineCliDirectory,
      );
      if (!message) continue;
      violations.push({
        file: normalizedRelative(absoluteRoot, file),
        line: source.slice(0, index).split(/\r?\n/).length,
        specifier,
        message,
      });
    }
  }
  return violations.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

export function formatScannerImportViolation(violation) {
  return `  - ${violation.file}:${violation.line} imports '${violation.specifier}'\n` + `    ${violation.message}`;
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = findScannerImportViolations(root);
  if (violations.length > 0) {
    console.error('Scanner import boundary gate failed:\n' + violations.map(formatScannerImportViolation).join('\n'));
    console.error('\nMigrate each listed production import to the shared @hub/scanner-core package; tests and fixtures are excluded.');
    process.exitCode = 1;
  } else {
    console.log(`Scanner import boundary passed (${collectProductionFiles(root).length} production files).`);
  }
}
