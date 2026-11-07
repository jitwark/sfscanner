import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * `package.json#exports` and `bin` are promises to consumers, and a real install is the
 * only place a broken promise shows up: `dist/` is gitignored and written by the pack
 * lifecycle, so an advertised subpath can resolve inside this workspace, pass every
 * in-repo typecheck, and still not exist in the tarball. This test packs the tarball,
 * installs it into a clean consumer directory, and imports every advertised entry by its
 * published specifier. The final case is the non-vacuity control: the identical probe
 * must fail for a manifest that advertises a subpath the tarball does not ship.
 */
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE_NAME = 'sfscanner';
const PROBE_FILE = 'probe-subpaths.mjs';
const SHEBANG = '#!/usr/bin/env node';
const WORK_TIMEOUT_MS = 600_000;

/** Runtime exports the in-repo consumers import from each advertised subpath. */
const CONSUMED_EXPORTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '.': ['parseCliArguments', 'runCliV2', 'getHelpV2', 'emitMetadataCommandResultV2'],
  './v2/arguments': ['parseCliArguments'],
  './v2/cli-runner': ['runCliV2'],
  './v2/help': ['getHelpV2'],
  './v2/metadata-output': ['emitMetadataCommandResultV2'],
  './v2/preflight-readiness': ['buildPreflightReadinessReport'],
  './v2/privacy-prepare': ['prepareWorkflowPrivacy'],
});

// The root export is named `index`; `subpath.replace(/^\.\//u, '')` produced `./dist/..js`.

type ExportConditions = Readonly<Record<string, string>>;
type Manifest = Readonly<{
  name?: string; version?: string; main?: string; files?: readonly string[];
  bin?: Readonly<Record<string, string>>; exports?: Readonly<Record<string, ExportConditions>>;
}>;
type PackResult = { tarball: string; files: readonly string[] };
type Run = Readonly<{ status: number | null; stdout: string; stderr: string }>;

function spawn(command: string, args: readonly string[], cwd: string, shell = false): Run {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function ok(run: Run, label: string): Run {
  if (run.status !== 0) throw new Error(`${label} exited ${String(run.status)}\n${run.stdout}\n${run.stderr}`);
  return run;
}

/** `npm` is a shell shim on Windows, so prefer the npm CLI entry npm itself exports. */
function npm(args: readonly string[], cwd: string): Run {
  const npmCli = process.env.npm_execpath;
  if (npmCli !== undefined && npmCli.endsWith('.js')) return spawn(process.execPath, [npmCli, ...args], cwd);
  const quote = (value: string): string => (/[\s"']/u.test(value) ? `"${value}"` : value);
  return spawn('npm', args.map(quote), cwd, process.platform === 'win32');
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

/**
 * npm packs `./dist/main.js` and `dist/main.js` to one normalized form, so two manifests
 * that are equivalent to a consumer differ as strings after `npm pack`. Comparisons below
 * normalize the optional `./` for that reason; nothing else about a target is relaxed.
 */
function normalizeTarget(target: string): string {
  return target.replace(/^\.\//u, '');
}

/** Packs a directory into `destination` and reports the tarball plus its file list. */
async function pack(project: string, destination: string): Promise<PackResult> {
  await mkdir(destination, { recursive: true });
  const output = JSON.parse(ok(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', destination], project), 'npm pack').stdout) as readonly { filename: string; files: readonly { path: string }[] }[];
  const first = output[0];
  if (first?.filename === undefined || !Array.isArray(first.files)) throw new Error(`unexpected npm pack output: ${JSON.stringify(output)}`);
  // npm reports the tarball name relative to the destination it was told to pack into.
  return { tarball: path.resolve(destination, path.basename(first.filename)), files: first.files.map((file) => file.path) };
}

/** Installs a tarball into an empty directory, which is the consumer npm actually serves. */
async function install(root: string, name: string, tarball: string): Promise<string> {
  const consumer = path.join(root, name);
  await mkdir(consumer, { recursive: true });
  await writeFile(path.join(consumer, 'package.json'), `${JSON.stringify({ name: `${PACKAGE_NAME}-${name}`, version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`, 'utf8');
  ok(npm(['install', '--no-save', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer), 'npm install');
  return consumer;
}

/**
 * The probe imports each advertised subpath by its published specifier against the
 * installed package, which is resolution a static import cannot express — the specifier
 * list is data read from the installed manifest. It is written out as text and run as a
 * separate process so the failure is Node's own resolution failure, not this suite's.
 */
function probeSource(subpaths: readonly string[]): string {
  const targets = Object.fromEntries(subpaths.map((subpath) => [`${PACKAGE_NAME}${subpath.slice(1)}`, CONSUMED_EXPORTS[subpath] ?? []]));
  return [
    `const targets = ${JSON.stringify(targets)};`,
    'const failures = [];',
    'for (const [specifier, names] of Object.entries(targets)) {',
    '  try {',
    '    const loaded = await import(specifier);',
    '    for (const name of names) if (typeof loaded[name] !== "function") failures.push(`${specifier}: ${name} is ${typeof loaded[name]}`);',
    '  } catch (cause) {',
    '    failures.push(`${specifier}: ${cause?.code ?? cause?.message ?? cause}`);',
    '  }',
    '}',
    'if (failures.length > 0) { console.error(failures.join("\\n")); process.exitCode = 1; }',
    'else console.log(`resolved ${Object.keys(targets).length} subpaths`);',
    '',
  ].join('\n');
}

async function probe(consumer: string, subpaths: readonly string[]): Promise<Run> {
  await writeFile(path.join(consumer, PROBE_FILE), probeSource(subpaths), 'utf8');
  return spawn(process.execPath, [PROBE_FILE], consumer);
}

/** npm installs a shell shim on POSIX and a `.cmd` on Windows, so the installed bin runs through the shell. */
function shim(name: string, args: readonly string[], input = ''): Run {
  const executable = path.join(packed.consumer, 'node_modules', '.bin', name);
  const result = spawnSync(`"${executable}"`, [...args], { cwd: packed.consumer, input, encoding: 'utf8', shell: true, timeout: 10_000 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Installed-package consumer: strict NodeNext, no workspace aliases, no @types/node. */
async function typecheckConsumer(consumer: string): Promise<Run> {
  const directory = path.join(consumer, 'types');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, target: 'ES2022', module: 'NodeNext',
      moduleResolution: 'NodeNext', lib: ['ES2022', 'DOM'], types: [],
      skipLibCheck: false, forceConsistentCasingInFileNames: true,
    },
    include: ['consumer.ts'],
  }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(directory, 'consumer.ts'), [
    "import { parseCliArguments, runCliV2, getHelpV2, emitMetadataCommandResultV2 } from 'sfscanner';",
    "import { parseCliArguments as p } from 'sfscanner/v2/arguments';",
    "import { runCliV2 as r } from 'sfscanner/v2/cli-runner';",
    "import { getHelpV2 as h } from 'sfscanner/v2/help';",
    "import { emitMetadataCommandResultV2 as e } from 'sfscanner/v2/metadata-output';",
    "import type { PublicRunOptionsV2, PublicRunResultV2, PublicScanCommandV2 } from 'sfscanner';",
    'const options: PublicRunOptionsV2 = { signal: AbortSignal.abort() };',
    'declare const command: PublicScanCommandV2;',
    "const canonicalProfile: 'beta-default' = command.profile;",
    'const pending: Promise<PublicRunResultV2> = runCliV2(command, options);',
    'void pending; void canonicalProfile; void parseCliArguments; void getHelpV2; void emitMetadataCommandResultV2;',
    'void p; void r; void h; void e;',
    '',
  ].join('\n'), 'utf8');
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  return spawn(process.execPath, [tsc, '-p', path.join('types', 'tsconfig.json')], consumer);
}

const packed = {
  published: undefined as Manifest | undefined,
  installed: undefined as Manifest | undefined,
  installRoot: '', consumer: '',
  files: [] as readonly string[],
  subpaths: [] as readonly string[],
  tampered: '', tamperedSubpaths: [] as readonly string[],
};
let workRoot = '';

beforeAll(async () => {
  workRoot = await mkdtemp(path.join(os.tmpdir(), 'sfscanner-package-'));
  packed.published = await readJson<Manifest>(path.join(packageRoot, 'package.json'));

  const release = await pack(packageRoot, path.join(workRoot, 'packed'));
  packed.files = release.files;
  packed.consumer = await install(workRoot, 'consumer', release.tarball);
  packed.installRoot = path.join(packed.consumer, 'node_modules', PACKAGE_NAME);
  packed.installed = await readJson<Manifest>(path.join(packed.installRoot, 'package.json'));
  packed.subpaths = Object.keys(packed.installed.exports ?? {});

  // The control: unpack the same tarball, advertise one more subpath, and repack it.
  // Nothing about the fix may make this probe pass, because the file is genuinely absent.
  const extracted = path.join(workRoot, 'extracted');
  await mkdir(extracted, { recursive: true });
  ok(spawn('tar', ['-xzf', release.tarball, '-C', extracted], packageRoot), 'tar -xzf');
  const tamperedManifestPath = path.join(extracted, 'package', 'package.json');
  const tamperedManifest = await readJson<{ exports: Record<string, ExportConditions> }>(tamperedManifestPath);
  tamperedManifest.exports['./v2/absent'] = { import: './dist/v2/absent.js', types: './dist/v2/absent.d.ts' };
  await writeFile(tamperedManifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`, 'utf8');
  const repacked = await pack(path.join(extracted, 'package'), path.join(workRoot, 'tampered-packed'));
  packed.tampered = await install(workRoot, 'consumer-tampered', repacked.tarball);
  packed.tamperedSubpaths = Object.keys((await readJson<Manifest>(path.join(packed.tampered, 'node_modules', PACKAGE_NAME, 'package.json'))).exports ?? {});
}, WORK_TIMEOUT_MS);

afterAll(async () => {
  if (workRoot !== '') await rm(workRoot, { recursive: true, force: true });
});

describe('installed sfscanner package', () => {
  it('advertises only subpaths that resolve to dist files named after them', () => {
    const subpaths = Object.entries(packed.published?.exports ?? {});
    const violations = subpaths.flatMap(([subpath, conditions]) => {
      const name = subpath === '.' ? 'index' : subpath.slice(2);
      const expected = { import: `./dist/${name}.js`, types: `./dist/${name}.d.ts` };
      return Object.entries(expected)
        .filter(([condition, target]) => conditions[condition] !== target)
        .map(([condition, target]) => `${subpath}.${condition} is ${String(conditions[condition])}, expected ${target}`);
    });
    expect(violations).toEqual([]);
  });

  it('installs the published manifest and exactly the files field it declares', () => {
    expect(packed.installed).toEqual(packed.published);
    expect(packed.subpaths).toEqual(Object.keys(CONSUMED_EXPORTS));
    const declared = packed.published?.files ?? [];
    const allowed = (file: string): boolean => file === 'package.json' || declared.some((entry) => file === entry || file.startsWith(`${entry}/`));
    expect(packed.files.filter((file) => !allowed(file))).toEqual([]);
    expect(packed.files.filter((file) => /\.tsx?$/u.test(file) && !file.endsWith('.d.ts'))).toEqual([]);
    // The other direction: a declared entry that names nothing is an advertisement the
    // tarball does not honour, and npm packs it away silently rather than failing.
    const unshipped = declared.filter((entry) => !packed.files.some((file) => file === entry || file.startsWith(`${entry}/`)));
    expect(unshipped).toEqual([]);
  });

  it('ships every advertised condition and every advertised binary as a real file', async () => {
    const advertised = Object.entries(packed.installed?.exports ?? {}).flatMap(([subpath, conditions]) =>
      Object.entries(conditions).map(([condition, target]) => ({ label: `${subpath} (${condition})`, file: path.join(packed.installRoot, normalizeTarget(target)) })));
    expect(advertised.filter((entry) => !existsSync(entry.file)).map((entry) => `${entry.label} has no ${entry.file}`)).toEqual([]);

    // npm rewrites `./dist/main.js` and `dist/main.js` to one form when it packs, so the
    // comparison is on the advertised names and their normalized targets: a dropped,
    // renamed, or retargeted bin still fails here, while the source punctuation is npm's
    // to normalize. The published manifest keeps the punctuation its author wrote.
    const binaries = Object.entries(packed.installed?.bin ?? {}).map(([name, target]) => [name, normalizeTarget(target)]);
    expect(binaries).toEqual(Object.entries(packed.published?.bin ?? {}).map(([name, target]) => [name, normalizeTarget(target)]));
    expect(binaries.map(([name]) => name)).toEqual(['sfscanner', 'sfscanner-mcp']);
    for (const [, target] of binaries) {
      const file = path.join(packed.installRoot, target);
      expect(existsSync(file)).toBe(true);
      expect(packed.files).toContain(target); // shipped in the tarball, not only present in the source tree
      // npm's `.bin` shims execute the target directly, so a shipped entry needs its own shebang.
      expect((await readFile(file, 'utf8')).startsWith(SHEBANG)).toBe(true);
    }

    // The shipped CLI name is executable from the install: it prints its version document.
    // The MCP entry handshake (initialize/tools/list/tools/call) is exercised through the same
    // installed `.bin` shim below; on Windows that shim is npm's `.cmd` wrapper. An exit-0-only
    // spawn also passes when the server never starts, so the handshake parses and asserts every
    // reply. The POSIX `node_modules/.bin` symlink form is not exercised on this host, so the
    // installed-shim acceptance there stays conditional per platform.
    const cli = await shim(PACKAGE_NAME, ['--version', '--json']);
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual(expect.objectContaining({ schemaVersion: 'n8n-scan-v1', mode: 'offline' }));
  });

  it('declares every consumed runtime export in the types file of each advertised subpath', () => {
    // The subpath list is the packed manifest's, not this file's list: a subpath that
    // ships without a readable declaration fails here even though nothing here names it.
    const roots = Object.values(packed.installed?.exports ?? {}).map((entry) => path.join(packed.installRoot, entry.types));
    const program = ts.createProgram(roots, { noEmit: true, strict: true, skipLibCheck: false, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.es2024.promise.d.ts'] });
    expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
    const checker = program.getTypeChecker();
    const violations = Object.keys(packed.installed?.exports ?? {}).map((subpath) => {
      const target = packed.installed?.exports?.[subpath]?.types;
      if (typeof target !== 'string') return `${subpath} advertises no types condition`;
      const file = path.join(packed.installRoot, normalizeTarget(target));
      if (!existsSync(file)) return `${subpath} has no ${target}`;
      const source = program.getSourceFile(file);
      const symbol = source && checker.getSymbolAtLocation(source);
      const names = new Set(symbol ? checker.getExportsOfModule(symbol).map((entry) => entry.name) : []);
      const missing = (CONSUMED_EXPORTS[subpath] ?? []).filter((name) => !names.has(name));
      return missing.length === 0 ? '' : `${subpath} declarations omit ${missing.join(', ')}`;
    });
    expect(violations.filter((violation) => violation !== '')).toEqual([]);
  });

  it('resolves every advertised subpath by its published specifier from a clean install', async () => {
    const result = await probe(packed.consumer, packed.subpaths);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`resolved ${String(packed.subpaths.length)} subpaths`);
  });

  it('typechecks a strict NodeNext consumer of the installed root and subpaths', async () => {
    const result = await typecheckConsumer(packed.consumer);
    expect(result.status, result.stderr).toBe(0);
  });

  it('serves MCP initialize, tools/list, and tools/call through the installed bin', async () => {
    await writeFile(path.join(packed.consumer, 'clean.json'), '{"nodes":[],"connections":{}}\n', 'utf8');
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'packed-probe', version: '0.0.0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'n8n_scan', arguments: { inputs: ['clean.json'] } } },
    ].map((message) => JSON.stringify(message)).join('\n') + '\n';
    const result = shim(`${PACKAGE_NAME}-mcp`, [], messages);
    expect(result.status).toBe(0);
    const responses: unknown[] = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
    expect(responses).toHaveLength(3);
    expect(responses[0]).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'n8n-secureflow-scanner' } } });
    expect(responses[1]).toMatchObject({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'n8n_scan' }] } });
    expect(responses[2]).toMatchObject({ jsonrpc: '2.0', id: 3, result: { isError: false, content: [{ type: 'text' }] } });
  });

  it('accepts the pinned admitted profile through the installed bin and reports the canonical identity', async () => {
    await writeFile(path.join(packed.consumer, 'clean.json'), '{"nodes":[],"connections":{}}\n', 'utf8');
    const pinned = shim(PACKAGE_NAME, ['--schema', 'v2', 'scan', 'clean.json', '--profile', 'beta-default@2.0.0', '--format', 'json']);
    expect(pinned.stderr).toBe('');
    expect(pinned.status).toBe(0);
    const document = JSON.parse(pinned.stdout) as {
      schemaVersion: string;
      invocation: { profile: string };
      exitReason: string;
      results: Array<{ result: { profile: { id: string; version: string }; engine: { id: string } } }>;
    };
    expect(document).toMatchObject({
      schemaVersion: 'n8n-scan-v2',
      invocation: { profile: 'beta-default' },
      exitReason: 'UNDER_THRESHOLD',
      results: [{ result: { profile: { id: 'beta-default', version: '2.0.0' }, engine: { id: 'secureflow-scanner' } } }],
    });
    const bare = shim(PACKAGE_NAME, ['--schema', 'v2', 'scan', 'clean.json', '--profile', 'beta-default', '--format', 'json']);
    expect(bare.status).toBe(0);
    expect(JSON.parse(bare.stdout)).toEqual(document);
    const hardened = shim(PACKAGE_NAME, ['--schema', 'v2', 'scan', 'clean.json', '--profile', 'beta-hardened', '--format', 'json']);
    expect(hardened.status).toBe(2);
    expect(hardened.stderr).toContain('Profile is not admitted.');
  });

  it('fails the same probe when a subpath is advertised but absent from the tarball', async () => {
    expect(packed.tamperedSubpaths).toContain('./v2/absent');
    const result = await probe(packed.tampered, packed.tamperedSubpaths);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('sfscanner/v2/absent');
  });
});
