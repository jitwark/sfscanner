import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

const SUBPATHS = Object.freeze(['.', './v2/arguments', './v2/cli-runner', './v2/help',
  './v2/metadata-output', './v2/preflight-readiness', './v2/privacy-prepare']);
export const PUBLIC_DECLARATION_API = Object.freeze({
  '.': { values: ['parseCliArguments', 'runCliV2', 'getHelpV2', 'emitMetadataCommandResultV2', 'buildPreflightReadinessReport', 'prepareWorkflowPrivacy'],
    types: ['PublicRunOptionsV2', 'PublicRunResultV2', 'PublicScanCommandV2', 'PreflightReadinessReportV1', 'PrivacyPrepareResult'] },
  './v2/arguments': { values: ['parseCliArguments'], types: ['CliCommandV2'] },
  './v2/cli-runner': { values: ['runCliV2'], types: ['PublicRunOptionsV2', 'PublicRunResultV2', 'PublicScanCommandV2'] },
  './v2/help': { values: ['getHelpV2'], types: [] },
  './v2/metadata-output': { values: ['emitMetadataCommandResultV2'], types: [] },
  './v2/preflight-readiness': { values: ['buildPreflightReadinessReport'], types: ['PreflightReadinessReportV1', 'PreflightReadinessOptionsV1', 'PreflightPrerequisitesV1'] },
  './v2/privacy-prepare': { values: ['prepareWorkflowPrivacy'], types: ['PrivacyPrepareResult', 'PrivacyPrepareOptions'] },
});

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function declarationFile(installed, file) {
  if (!inside(path.join(installed, 'dist'), file) || !/\.d\.(?:ts|mts|cts)$/u.test(file)) {
    throw new Error(`Declaration path escapes installed dist or is not a declaration: ${file}`);
  }
  let current = installed;
  for (const segment of ['', ...path.relative(installed, file).split(path.sep)]) {
    current = path.join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Linked declaration path: ${current}`);
    if (current === file && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`Declaration must be a regular single-link file: ${file}`);
    if (current !== file && !stat.isDirectory()) throw new Error(`Declaration parent is not a directory: ${current}`);
  }
  return readFileSync(file);
}

function moduleReferences(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length || source.typeReferenceDirectives.length || source.referencedFiles.length
    || source.libReferenceDirectives.length) throw new Error(`Declaration has unsupported syntax or ambient references: ${file}`);
  const references = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) throw new Error(`Nonliteral declaration import: ${file}`);
      references.push(node.moduleSpecifier.text);
    }
    if (ts.isImportTypeNode(node)) {
      if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) throw new Error(`Nonliteral import type: ${file}`);
      references.push(node.argument.literal.text);
    }
    if (ts.isExternalModuleReference(node) || (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name))) {
      throw new Error(`Ambient or import-equals declaration dependency: ${file}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return references;
}

/**
 * installed: absolute consumer/node_modules/sfscanner directory, from the retained installation.
 * consumer: absolute fresh external consumer root. No install, build or source fallback occurs here.
 * run(command, args, settings): synchronous callback returning {status, stdout, stderr}.
 */
export function validateRetainedDeclarations(installed, consumer, run) {
  if (!path.isAbsolute(installed) || !path.isAbsolute(consumer)
    || path.resolve(installed) !== path.join(path.resolve(consumer), 'node_modules', 'sfscanner')) {
    throw new Error('Declarations must be checked in the installed external consumer');
  }
  if (typeof run !== 'function') throw new TypeError('Declaration verification requires a synchronous run callback');
  const manifest = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'));
  if (manifest.name !== 'sfscanner' || JSON.stringify(Object.keys(manifest.exports ?? {}).sort()) !== JSON.stringify([...SUBPATHS].sort())) {
    throw new Error('Installed declaration export contract mismatch');
  }
  const visited = new Set();
  const declarations = [];
  const entrypoints = [];
  function verify(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const bytes = declarationFile(installed, file);
    declarations.push(Object.freeze({ path: path.relative(installed, file).replaceAll(path.sep, '/'),
      byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
    for (const specifier of moduleReferences(file, bytes.toString('utf8'))) {
      if (!specifier.startsWith('.') || /[\\:\u0000-\u001f\u007f]/u.test(specifier)) {
        throw new Error(`Declaration has a non-relative dependency: ${specifier}`);
      }
      const resolved = path.resolve(path.dirname(file), specifier);
      const target = resolved.endsWith('.d.ts') ? resolved : resolved.endsWith('.mjs')
        ? resolved.slice(0, -4) + '.d.mts' : resolved.endsWith('.cjs')
          ? resolved.slice(0, -4) + '.d.cts' : resolved.endsWith('.js') ? resolved.slice(0, -3) + '.d.ts' : '';
      if (!target) throw new Error(`Declaration import must identify a shipped declaration: ${specifier}`);
      verify(target);
    }
  }
  for (const subpath of SUBPATHS) {
    const target = manifest.exports[subpath]?.types;
    const expected = `./dist/${subpath === '.' ? 'index' : subpath.slice(2)}.d.ts`;
    if (target !== expected) throw new Error(`Installed declaration target mismatch: ${subpath}`);
    entrypoints.push(Object.freeze({ subpath, types: target }));
    verify(path.resolve(installed, target));
  }
  const probe = mkdtempSync(path.join(consumer, '.declarations-'));
  try {
    const lines = ['type Callable = (...args: never[]) => unknown;'];
    SUBPATHS.forEach((subpath, index) => {
      const specifier = JSON.stringify('sfscanner' + (subpath === '.' ? '' : subpath.slice(1)));
      const api = PUBLIC_DECLARATION_API[subpath];
      lines.push(`import { ${api.values.map((name) => `${name} as value${index}_${name}`).join(', ')} } from ${specifier};`);
      api.values.forEach((name) => lines.push(`const call${index}_${name}: Callable = value${index}_${name};`));
      if (api.types.length) lines.push(`import type { ${api.types.map((name) => `${name} as type${index}_${name}`).join(', ')} } from ${specifier};`);
      lines.push(`export type Types${index} = [${api.types.map((name) => `type${index}_${name}`).join(', ')}];`);
    });
    writeFileSync(path.join(probe, 'probe.mts'), lines.join('\n'));
    writeFileSync(path.join(probe, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'ES2024.Promise'], module: 'NodeNext',
        moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], typeRoots: [] },
      files: ['probe.mts'],
    }));
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const result = run(process.execPath, [tsc, '--project', path.join(probe, 'tsconfig.json')], { cwd: consumer });
    if (!result || typeof result.then === 'function') throw new Error('Declaration run callback must return synchronously');
    if (result.status !== 0) throw new Error(`Installed declaration consumer failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    declarations.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const declarationSetSha256 = createHash('sha256').update(JSON.stringify(declarations)).digest('hex');
    return Object.freeze({ id: 'installed-typescript-declarations', status: 'pass',
      exports: SUBPATHS.length, declarationFiles: visited.size, typescriptVersion: ts.version,
      strict: true, skipLibCheck: false, entrypoints: Object.freeze(entrypoints),
      declarations: Object.freeze(declarations), declarationSetSha256 });
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
