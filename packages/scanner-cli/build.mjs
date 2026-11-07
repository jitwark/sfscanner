import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { emitPublicDeclarations } from './declaration-build.mjs';

const packageDirectory = new URL('./', import.meta.url);
const packageRoot = fileURLToPath(packageDirectory);
const outputDirectory = new URL('./dist/', packageDirectory);
const DIST_PREFIX = './dist/';
const DECLARATION_PROJECT = './tsconfig.build.json';
const SOURCE_MAP_SECRET_PATTERNS = [
  /sk-(?:proj|ant)-[A-Za-z0-9_-]{8,}/u,
  /(?:ghp|gho|ghu|github_pat|glpat)-[A-Za-z0-9_]{12,}/u,
  /AKIA[0-9A-Z]{16}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
];

function isAbsoluteSourcePath(value) {
  return path.isAbsolute(value) || /^\\\\/u.test(value) || /^[A-Za-z]:[\\/]/u.test(value);
}

export function validateScannerSourceMap(sourceMap) {
  if (!sourceMap || typeof sourceMap !== 'object') throw new TypeError('source map must be an object');
  const paths = [sourceMap.sourceRoot, ...(Array.isArray(sourceMap.sources) ? sourceMap.sources : [])].filter((value) => value !== undefined);
  for (const source of paths) {
    if (typeof source !== 'string') throw new TypeError('source-map path must be a string');
    if (isAbsoluteSourcePath(source)) throw new Error(`absolute source-map path is not allowed: ${source}`);
  }
  const contents = Array.isArray(sourceMap.sourcesContent) ? sourceMap.sourcesContent : [];
  for (const content of contents) {
    if (typeof content !== 'string') continue;
    if (SOURCE_MAP_SECRET_PATTERNS.some((pattern) => pattern.test(content))) throw new Error('secret-like source-map content is not allowed');
  }
  return true;
}

/**
 * `package.json#exports` is the promise to consumers; this is where the promise is
 * read back. Every advertised subpath must name a bundled `dist/<subpath>.js` and a
 * declaration `dist/<subpath>.d.ts`, so the build cannot advertise a file it never
 * emits — the defect where four subpaths resolved into unshipped `src/` TypeScript.
 */
export async function readSubpathPlan() {
  const manifest = JSON.parse(await readFile(new URL('./package.json', packageDirectory), 'utf8'));
  const entries = Object.entries(manifest.exports ?? {});
  if (entries.length === 0) throw new Error('package.json declares no subpath exports');
  return Object.freeze(entries.map(([subpath, conditions]) => {
    const name = subpath === '.' ? 'index' : subpath.slice(2);
    if (subpath !== '.' && (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(name) || name.includes('..'))) throw new Error(`subpath export "${subpath}" is not a plain package subpath`);
    const importFile = `${DIST_PREFIX}${name}.js`;
    const typesFile = `${DIST_PREFIX}${name}.d.ts`;
    if (conditions?.import !== importFile) throw new Error(`subpath export "${subpath}" must import ${importFile}, not ${String(conditions?.import)}`);
    if (conditions?.types !== typesFile) throw new Error(`subpath export "${subpath}" must declare types at ${typesFile}, not ${String(conditions?.types)}`);
    return Object.freeze({ subpath, name, source: `./src/${name}.ts`, importFile, typesFile });
  }));
}

async function assertSourcesExist(plan) {
  for (const entry of plan) {
    try {
      await readFile(new URL(entry.source, packageDirectory), 'utf8');
    } catch {
      throw new Error(`subpath export "${entry.subpath}" has no source at ${entry.source}`);
    }
  }
}

/**
 * The declaration project is a second place that lists the public subpaths, so it is
 * checked against the plan rather than trusted.
 */
async function emitSubpathDeclarations(plan) {
  const projectFile = fileURLToPath(new URL(DECLARATION_PROJECT, packageDirectory));
  const project = JSON.parse(await readFile(projectFile, 'utf8'));
  const declared = new Set(project.include ?? []);
  for (const entry of plan) {
    const source = entry.source.slice(2);
    if (!declared.has(source)) throw new Error(`${DECLARATION_PROJECT} must include ${source} to declare types for ${entry.subpath}`);
  }
  emitPublicDeclarations({ packageRoot, plan, projectFile });
  for (const entry of plan) await readFile(fileURLToPath(new URL(entry.typesFile, packageDirectory)));
}

export async function buildScannerCli() {
  const plan = await readSubpathPlan();
  await assertSourcesExist(plan);
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const outputFile = fileURLToPath(new URL('./main.js', outputDirectory));
  const mcpOutputFile = fileURLToPath(new URL('./mcp.js', outputDirectory));
  const scanWorkerOutputFile = fileURLToPath(new URL('./scan-worker.js', outputDirectory));
  await build({
    absWorkingDir: packageRoot,
    entryPoints: {
      main: fileURLToPath(new URL('./src/main.ts', packageDirectory)),
      mcp: fileURLToPath(new URL('./src/v2/mcp.ts', packageDirectory)),
      'scan-worker': fileURLToPath(new URL('./src/v2/scan-worker.ts', packageDirectory)),
      ...Object.fromEntries(plan.map((entry) => [entry.name, fileURLToPath(new URL(entry.source, packageDirectory))])),
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outdir: fileURLToPath(outputDirectory),
    sourcemap: 'external',
  });
  const subpathOutputs = plan.map((entry) => fileURLToPath(new URL(entry.importFile, packageDirectory)));
  for (const output of [outputFile, mcpOutputFile, scanWorkerOutputFile, ...subpathOutputs]) {
    const sourceMap = JSON.parse(await readFile(`${output}.map`, 'utf8'));
    validateScannerSourceMap(sourceMap);
  }
  await assertScanWorkerAsset();
  await emitSubpathDeclarations(plan);
  return Object.freeze({
    outputFile,
    mapPath: `${outputFile}.map`,
    mcpOutputFile,
    mcpMapPath: `${mcpOutputFile}.map`,
    scanWorkerOutputFile,
    scanWorkerMapPath: `${scanWorkerOutputFile}.map`,
    subpathOutputs: Object.freeze(subpathOutputs),
    subpathTypes: Object.freeze(plan.map((entry) => fileURLToPath(new URL(entry.typesFile, packageDirectory)))),
  });
}

/**
 * The private import map is how `scan-worker-host` finds the worker, so the build
 * checks that the map names exactly the asset this build emitted.
 */
async function assertScanWorkerAsset() {
  const manifest = JSON.parse(await readFile(new URL('./package.json', packageDirectory), 'utf8'));
  const target = manifest.imports?.['#sfscanner-worker'];
  if (target !== './dist/scan-worker.js') {
    throw new Error(`package.json#imports must map #sfscanner-worker to ./dist/scan-worker.js, not ${String(target)}`);
  }
  await readFile(new URL('./dist/scan-worker.js', packageDirectory));
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === modulePath.toLowerCase() : invoked === modulePath)) {
  await buildScannerCli();
}
