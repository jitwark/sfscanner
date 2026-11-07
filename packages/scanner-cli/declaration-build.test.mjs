import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';
import { emitPublicDeclarations } from './declaration-build.mjs';

const roots = [];
const temporary = () => { const root = mkdtempSync(path.join(os.tmpdir(), 'scanner-declarations-')); roots.push(root); return root; };
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

function fixture() {
  const root = temporary();
  const packageRoot = path.join(root, 'packages/scanner-cli');
  const projectFile = path.join(packageRoot, 'tsconfig.build.json');
  const entries = ['index', 'v2/arguments', 'v2/cli-runner', 'v2/help', 'v2/metadata-output', 'v2/preflight-readiness', 'v2/privacy-prepare'];
  const plan = entries.map((name) => ({ name, source: `./src/${name}.ts`, typesFile: `./dist/${name}.d.ts` }));
  for (const entry of plan) write(path.resolve(packageRoot, entry.source),
    "export type { Model } from '@hub/contracts'; export type Lazy = import('@hub/contracts').Model;\nexport default function value(): number { return 1; }\n");
  write(path.join(root, 'contracts/index.ts'), "import type { Leaf } from './leaf.js'; export type Model = { leaf: Leaf };\n");
  write(path.join(root, 'contracts/leaf.ts'), 'export type Leaf = { known: string };\n');
  write(projectFile, JSON.stringify({ compilerOptions: { rootDir: '../..', module: 'ESNext', moduleResolution: 'Bundler',
    target: 'ES2022', strict: true, types: [], noEmit: false }, include: plan.map((entry) => entry.source) }));
  return { root, packageRoot, projectFile, plan, paths: { '@hub/contracts': [path.join(root, 'contracts/index.ts')] } };
}

test('emits sibling workspace and import-type closure with relative imports and default exports', () => {
  const item = fixture();
  const result = emitPublicDeclarations(item);
  assert.equal(result.publicEntries, 7);
  assert.equal(result.declarationFiles, 16);
  const consumer = temporary();
  const installed = path.join(consumer, 'node_modules/sfscanner');
  mkdirSync(installed, { recursive: true });
  cpSync(path.join(item.packageRoot, 'dist'), path.join(installed, 'dist'), { recursive: true });
  const exports = Object.fromEntries(item.plan.map((entry) => [entry.name === 'index' ? '.' : `./${entry.name}`, { types: entry.typesFile }]));
  write(path.join(installed, 'package.json'), JSON.stringify({ name: 'sfscanner', type: 'module', exports }));
  const probe = item.plan.map((entry, index) => {
    const specifier = 'sfscanner' + (entry.name === 'index' ? '' : '/' + entry.name);
    return `import type Value${index} from '${specifier}';\n`
      + `import type { Model as Model${index}, Lazy as Lazy${index} } from '${specifier}';\n`
      + `export const v${index}: Model${index} & Lazy${index} = { leaf: { known: 'yes' } };\n`
      + `export type F${index} = typeof Value${index};`;
  }).join('\n');
  write(path.join(consumer, 'probe.mts'), probe);
  write(path.join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false,
    module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', types: [], noEmit: true }, files: ['probe.mts'] }));
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  // Removing all source prevents success through the workspace alias or a source-build fallback.
  rmSync(item.root, { recursive: true, force: true });
  const resultCheck = spawnSync(process.execPath, [tsc, '-p', path.join(consumer, 'tsconfig.json')], { encoding: 'utf8' });
  assert.equal(resultCheck.status, 0, resultCheck.stdout + resultCheck.stderr);
  const entry = readFileSync(path.join(installed, 'dist/index.d.ts'), 'utf8');
  assert.match(entry, /export \{ default \}/u);
});

test('fails a real source type error without emitting a misleading public declaration', () => {
  const item = fixture();
  write(path.join(item.packageRoot, 'src/index.ts'), 'export const wrong: string = 1;');
  assert.throws(() => emitPublicDeclarations(item), /TS2322/u);
  assert.equal(existsSync(path.join(item.packageRoot, 'dist/index.d.ts')), false);
});

test('rejects an advertised entry missing from the declaration project', () => {
  const item = fixture();
  write(item.projectFile, JSON.stringify({ compilerOptions: { rootDir: '../..', types: [] }, files: [] }));
  assert.throws(() => emitPublicDeclarations(item), /include|empty/u);
});
