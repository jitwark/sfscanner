import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const slash = (value) => value.replaceAll(path.sep, '/');
const key = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

function relativeModule(from, to) {
  const relative = slash(path.relative(path.dirname(from), to)).replace(/\.d\.ts$/u, '.js');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function workspacePaths(root) {
  const paths = {};
  for (const directory of ['contracts', 'packages/scanner-core']) {
    const base = path.join(root, directory);
    const manifest = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8'));
    for (const [subpath, entry] of Object.entries(manifest.exports)) {
      const target = typeof entry === 'string' ? entry : entry.types;
      if (!target) throw new Error(`Workspace export has no types: ${subpath}`);
      const specifier = manifest.name + (subpath === '.' ? '' : subpath.slice(1));
      paths[specifier] = [path.resolve(base, target)];
    }
  }
  return paths;
}

function diagnosticsText(diagnostics) {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
  });
}

/** Emits a complete, package-relative type closure, without private package resolution at consumption. */
export function emitPublicDeclarations({ packageRoot, plan, projectFile, paths: pathOverrides }) {
  const config = ts.readConfigFile(projectFile, ts.sys.readFile);
  if (config.error) throw new Error(diagnosticsText([config.error]));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(projectFile));
  if (parsed.errors.length) throw new Error(diagnosticsText(parsed.errors));
  for (const entry of plan) {
    if (!parsed.fileNames.some((file) => key(file) === key(path.resolve(packageRoot, entry.source)))) {
      throw new Error(`Declaration project must include ${entry.source}`);
    }
  }
  const root = parsed.options.rootDir;
  const output = path.join(packageRoot, 'dist', '_types');
  const options = { ...parsed.options, noEmit: false, declaration: true, emitDeclarationOnly: true,
    declarationMap: false, sourceMap: false, outDir: output, incremental: false,
    baseUrl: root, paths: pathOverrides ?? workspacePaths(root), resolveJsonModule: true };
  const program = ts.createProgram(parsed.fileNames, options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(`Declaration source check failed:\n${diagnosticsText(diagnostics)}`);
  const emitted = new Map();
  const result = program.emit(undefined, (file, text, _bom, _error, sources) => {
    if (!file.endsWith('.d.ts') || sources?.length !== 1) throw new Error(`Unexpected declaration output: ${file}`);
    emitted.set(key(sources[0].fileName), { source: sources[0].fileName, file, text });
  }, undefined, true);
  if (result.diagnostics.length || emitted.size === 0) {
    throw new Error(`Declaration emission produced ${emitted.size} modules:\n${diagnosticsText(result.diagnostics)}`);
  }
  const retained = new Map();
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  function retain(source) {
    const sourceKey = key(source);
    const item = emitted.get(sourceKey);
    if (!item) throw new Error(`Public type dependency has no emitted declaration: ${source}`);
    if (retained.has(sourceKey)) return item.file;
    retained.set(sourceKey, item);
    const declaration = ts.createSourceFile(item.file, item.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (declaration.referencedFiles.length || declaration.typeReferenceDirectives.length) {
      throw new Error(`Public declaration has ambient/reference dependencies: ${source}`);
    }
    const transformed = ts.transform(declaration, [(context) => {
      const visit = (node) => {
        const parent = node.parent;
        const isModule = ts.isStringLiteral(node) && parent && (
          ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node)
          || (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)));
        if (isModule) {
          const resolved = ts.resolveModuleName(node.text, item.source, options, ts.sys).resolvedModule;
          if (!resolved) throw new Error(`Unresolved public declaration dependency: ${node.text} in ${source}`);
          const target = retain(resolved.resolvedFileName);
          return ts.factory.createStringLiteral(relativeModule(item.file, target));
        }
        if (ts.isExternalModuleReference(node)) throw new Error(`Unsupported import-equals dependency: ${source}`);
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit);
    }]);
    try { item.text = printer.printFile(transformed.transformed[0]); }
    finally { transformed.dispose(); }
    return item.file;
  }
  const wrappers = [];
  for (const entry of plan) {
    const source = path.resolve(packageRoot, entry.source);
    const target = retain(source);
    const file = path.resolve(packageRoot, entry.typesFile);
    const modulePath = relativeModule(file, target);
    const symbol = program.getTypeChecker().getSymbolAtLocation(program.getSourceFile(source));
    const hasDefault = symbol && program.getTypeChecker().getExportsOfModule(symbol).some((item) => item.name === 'default');
    wrappers.push({ file, text: `export * from ${JSON.stringify(modulePath)};\n`
      + (hasDefault ? `export { default } from ${JSON.stringify(modulePath)};\n` : '') });
  }
  for (const { file, text } of [...retained.values(), ...wrappers]) {
    const relative = path.relative(path.join(packageRoot, 'dist'), file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Declaration output escapes dist');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return Object.freeze({ publicEntries: wrappers.length, declarationFiles: retained.size + wrappers.length });
}
