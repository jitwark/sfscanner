import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { PUBLIC_DECLARATION_API, validateRetainedDeclarations } from './retained-declarations.mjs';

const roots = [];
const SUBPATHS = ['.', './v2/arguments', './v2/cli-runner', './v2/help', './v2/metadata-output', './v2/preflight-readiness', './v2/privacy-prepare'];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
function fixture() {
  const consumer = mkdtempSync(path.join(os.tmpdir(), 'retained-types-')); roots.push(consumer);
  const installed = path.join(consumer, 'node_modules/sfscanner');
  const exports = {};
  for (const subpath of SUBPATHS) {
    const target = `./dist/${subpath === '.' ? 'index' : subpath.slice(2)}.d.ts`;
    exports[subpath] = { types: target };
    const prefix = subpath === '.' ? './' : '../';
    const api = PUBLIC_DECLARATION_API[subpath];
    write(path.join(installed, target), `export { ${api.values.map((name) => `value as ${name}`).join(', ')} } from '${prefix}internal.js';\n`
      + (api.types.length ? `export type { ${api.types.map((name) => `Model as ${name}`).join(', ')} } from '${prefix}leaf.js';\n` : ''));
  }
  write(path.join(installed, 'dist/internal.d.ts'), "import type { Model } from './leaf.js'; export declare function value(): Model;\n");
  write(path.join(installed, 'dist/leaf.d.ts'), 'export type Model = { status: "KNOWN" };\n');
  write(path.join(installed, 'package.json'), JSON.stringify({ name: 'sfscanner', type: 'module', exports }));
  write(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const commands = [];
  const run = (command, args, settings) => {
    commands.push({ command, args, settings });
    return spawnSync(command, args, { ...settings, encoding: 'utf8' });
  };
  return { consumer, installed, run, commands };
}

it('strictly typechecks every installed public export and its transitive declarations', () => {
  const item = fixture();
  const result = validateRetainedDeclarations(item.installed, item.consumer, item.run);
  expect(result).toMatchObject({ id: 'installed-typescript-declarations', status: 'pass', exports: 7,
    declarationFiles: 9, strict: true, skipLibCheck: false });
  expect(item.commands).toHaveLength(1);
  expect(item.commands[0].settings.cwd).toBe(item.consumer);
  expect(result.entrypoints.map((entry) => entry.subpath)).toEqual(SUBPATHS);
  expect(result.declarations).toHaveLength(9);
  expect(result.declarations).toContainEqual(expect.objectContaining({ path: 'dist/leaf.d.ts',
    byteLength: 41, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }));
  expect(result.declarationSetSha256).toMatch(/^[0-9a-f]{64}$/u);
});

it.each(['dist/index.d.ts', 'dist/leaf.d.ts'])('refuses missing declaration %s', (file) => {
  const item = fixture(); rmSync(path.join(item.installed, file));
  expect(() => validateRetainedDeclarations(item.installed, item.consumer, item.run)).toThrow();
  expect(item.commands).toHaveLength(0);
});

it('checks unused declaration bodies with skipLibCheck false', () => {
  const item = fixture();
  write(path.join(item.installed, 'dist/leaf.d.ts'), 'export type Model = MissingPrivateType;\n');
  expect(() => validateRetainedDeclarations(item.installed, item.consumer, item.run)).toThrow(/TS2304/u);
});

it('refuses an empty declaration module that omits the promised named API', () => {
  const item = fixture();
  write(path.join(item.installed, 'dist/index.d.ts'), 'export {};\n');
  expect(() => validateRetainedDeclarations(item.installed, item.consumer, item.run)).toThrow(/TS2305/u);
});

it('refuses a declaration that omits a promised public type', () => {
  const item = fixture(); const file = path.join(item.installed, 'dist/v2/cli-runner.d.ts');
  write(file, readFileSync(file, 'utf8').replace('Model as PublicRunOptionsV2, ', ''));
  expect(() => validateRetainedDeclarations(item.installed, item.consumer, item.run)).toThrow(/TS2305/u);
});

it.each(["export type X = import('@hub/contracts').X;", "export * from '@hub/scanner-core/v2';",
  '/// <reference types="node" />\nexport {};', "export * from '../../../outside.js';"])
('refuses private/ambient/escaping declaration dependencies', (text) => {
  const item = fixture(); write(path.join(item.installed, 'dist/leaf.d.ts'), text);
  expect(() => validateRetainedDeclarations(item.installed, item.consumer, item.run)).toThrow();
});

it('does not fall back to shipped .ts source for a missing .d.ts', () => {
  const item = fixture(); rmSync(path.join(item.installed, 'dist/leaf.d.ts'));
  write(path.join(item.installed, 'dist/leaf.ts'), 'export type Model = { status: "KNOWN" };');
  expect(() => validateRetainedDeclarations(item.installed, item.consumer, item.run)).toThrow();
});

it('rejects linked declaration parents', () => {
  const item = fixture();
  const dist = path.join(item.installed, 'dist');
  const target = path.join(item.consumer, 'linked-dist');
  mkdirSync(target);
  rmSync(dist, { recursive: true }); symlinkSync(target, dist, 'junction');
  expect(() => validateRetainedDeclarations(item.installed, item.consumer, item.run)).toThrow(/Linked/u);
});

it('requires a synchronous callback and cleans up its consumer probe', () => {
  const item = fixture();
  const manifestBefore = readFileSync(path.join(item.installed, 'package.json'), 'utf8');
  expect(() => validateRetainedDeclarations(item.installed, item.consumer, () => Promise.resolve({ status: 0 }))).toThrow(/synchronously/u);
  expect(readFileSync(path.join(item.installed, 'package.json'), 'utf8')).toBe(manifestBefore);
});
