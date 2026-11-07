import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2, SEMANTIC_CATALOGUE_DIGEST_V2, ENGINE_BUILD_DIGEST_V2 } from '../../packages/scanner-core/src/v2/admitted-registry.js';
import type { CorpusV2InputInventory } from '../../scripts/lib/corpus-v2-input-inventory.js';
import { sourceBindingsDigest, type FormalCoverageBinding, type FormalMeasurementContext } from './formal-node-coverage.js';

const root = path.resolve(import.meta.dirname, '../..');
const hash = (bytes: Uint8Array | string) => crypto.createHash('sha256').update(bytes).digest('hex');
// Conservative production superset: newly added parser/resolver helpers are bound automatically.
const SOURCE_ROOTS = ['contracts', 'packages/scanner-core/src', 'pipeline', 'scripts/lib', 'schemas'];
const EXCLUDED = new Set(['node_modules', '__fixtures__', 'fixtures', 'test-fixtures', 'tests', 'test', '__tests__',
  'graft', 'dist', 'coverage', '.work', '.cache', '.vite']);
const SOURCE_EXTENSION = /\.(?:ts|tsx|js|mjs|cjs|json)$/u;
const TEST_FILE = /(?:[.-](?:test|spec)\.|-test-support\.)/u;

export function formalProducerSourceIdentity(sourceRoot = root) {
  const files: { file: string; sha256: string }[] = [];
  function walk(relative: string): void {
    const absolute = path.join(sourceRoot, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('Formal coverage: linked production source refused');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        if (!EXCLUDED.has(name) && !name.startsWith('.')) walk(path.join(relative, name));
      }
    } else if (stat.isFile() && SOURCE_EXTENSION.test(relative) && !TEST_FILE.test(relative)) {
      files.push({ file: relative.replaceAll(path.sep, '/'), sha256: hash(fs.readFileSync(absolute)) });
    }
  }
  for (const directory of SOURCE_ROOTS) walk(directory);
  for (const file of ['package.json', 'tsconfig.json', 'packages/scanner-core/package.json',
    'packages/scanner-core/tsconfig.json', 'packages/scanner-cli/package.json', 'pipeline/tsconfig.json', 'scripts/tsconfig.json']) {
    const absolute = path.join(sourceRoot, file);
    files.push({ file, sha256: hash(fs.readFileSync(absolute)) });
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a.file), Buffer.from(b.file)));
  return { files, digest: hash(JSON.stringify(files)) };
}

function toolIdentity(name: string): string {
  const parserTool = name === '@humanwhocodes/momoa' || name === '@noble/hashes';
  const require = createRequire(parserTool ? new URL('../../packages/scanner-core/src/source/source-parser.ts', import.meta.url) : import.meta.url);
  let file: string;
  try { file = require.resolve(name + '/package.json'); }
  catch {
    let directory = path.dirname(require.resolve(name));
    while (!fs.existsSync(path.join(directory, 'package.json'))) {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error('Formal coverage: tool package identity unavailable');
      directory = parent;
    }
    file = path.join(directory, 'package.json');
  }
  const bytes = fs.readFileSync(file);
  const manifest = JSON.parse(bytes.toString('utf8')) as { name: string; version: string };
  if (manifest.name !== name || !manifest.version) throw new Error('Formal coverage: tool package identity mismatch');
  return `${manifest.version}:${hash(bytes)}`;
}

export function formalMeasurementContext(): FormalMeasurementContext {
  return {
    limits: DEFAULT_SCANNER_LIMITS_V2,
    lockfileSha256: hash(fs.readFileSync(path.join(root, 'package-lock.json'))),
    runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
      loaderArgumentsSha256: hash(JSON.stringify(process.execArgv)) },
    tools: Object.fromEntries(['@humanwhocodes/momoa', '@noble/hashes', 'tsx', 'typescript'].map((name) => [name, toolIdentity(name)])),
  };
}

/** Metadata only: binds the actual source implementation and named inputs, never rereads a body. */
export function formalCoverageBinding(inventory: CorpusV2InputInventory, inventoryFile: string, bodyMapFile: string): FormalCoverageBinding {
  const inventoryBytes = fs.readFileSync(inventoryFile);
  const document = JSON.parse(inventoryBytes.toString('utf8')) as { inventory?: CorpusV2InputInventory };
  if (JSON.stringify(document.inventory ?? document) !== JSON.stringify(inventory)) throw new Error('Formal coverage: inventory file changed after parsing');
  const producer = formalProducerSourceIdentity();
  const executionContext = formalMeasurementContext();
  const sourceReceiptSha256 = hash(fs.readFileSync(path.join(root, 'docs/scanner/semantic-source-receipts.json')));
  if (sourceReceiptSha256 !== BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2.sourceReceiptSha256) throw new Error('Formal coverage: source receipt pin mismatch');
  return {
    inventoryFileSha256: hash(inventoryBytes), inventorySha256: inventory.inventorySha256,
    bodyMapSha256: hash(fs.readFileSync(bodyMapFile)), scopedSemanticsDigest: BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2.digest,
    legacySemanticsDigest: SEMANTIC_CATALOGUE_DIGEST_V2, engineBuildDigest: ENGINE_BUILD_DIGEST_V2,
    sourceReceiptSha256, producerSourceSha256: producer.digest, sourceBindingsSha256: sourceBindingsDigest(inventory),
    measurementContextSha256: hash(JSON.stringify(executionContext)), executionContext,
  };
}
