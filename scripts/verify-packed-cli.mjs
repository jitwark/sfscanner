#!/usr/bin/env node
/**
 * Packed-tarball publication contract for `sfscanner` (plan task 5.3).
 *
 * A workspace checkout cannot see a missing file, a bad `files` entry, or a subpath that
 * only resolves through the monorepo, so this verifier builds the package, packs it with
 * `npm pack`, installs the tarball into a throwaway project outside the repository, and
 * exercises the published package from that install: subpath exports, the CLI/MCP profile
 * surfaces, offline isolation, TTY vs non-TTY formatting, atomic output, exit codes, and
 * the declared Node/OS matrix and licensing statements.
 *
 * The build runs in a scratch copy of `packages/scanner-cli` at the same directory depth
 * (`packages/.verify-packed-cli-<pid>`), so the emitted source-map-relative paths — and the
 * tarball bytes — match an in-place `npm pack` without racing the package's own build test.
 *
 * Run: `node scripts/verify-packed-cli.mjs` (exit 1 when any check fails).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpSession, probeInstalledMcpEntry } from './lib/packed-mcp-entry.mjs';
const HUB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE_DIR = path.join(HUB_ROOT, 'packages', 'scanner-cli');
const PACKAGE_NAME = 'sfscanner';
const MCP_TOOL_NAME = 'n8n_scan';
const SPAWN_TIMEOUT_MS = 120_000;
const REQUIRED_FILES = ['package.json', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'dist/main.js', 'dist/mcp.js'];
const SUBPATH_EXPORTS = Object.freeze({
  './v2/arguments': 'parseCliArguments', './v2/cli-runner': 'runCliV2',
  './v2/help': 'getHelpV2', './v2/metadata-output': 'emitMetadataCommandResultV2',
});
const CLEAN = { name: 'clean', nodes: [{ parameters: {}, id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] }], connections: {}, active: false, settings: {}, versionId: 'v1' };
const RISKY = { name: 'risky', nodes: [{ parameters: {}, id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] }, { parameters: { command: 'printf hi' }, id: 'r', name: 'Run', type: 'n8n-nodes-base.executeCommand', typeVersion: 1, position: [240, 0] }], connections: {}, active: false, settings: {}, versionId: 'v2' };
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, ...options });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
function ok(label, result) { if (result.status !== 0) throw new Error(`${label} exited ${String(result.status)}\n${result.stdout}\n${result.stderr}`); return result; }
function npm(args, cwd) {
  const cli = process.env.npm_execpath;
  if (cli !== undefined && cli.endsWith('.js')) return run(process.execPath, [cli, ...args], { cwd });
  return run('npm', args, { cwd, shell: process.platform === 'win32' });
}
function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function json(file) { return JSON.parse(readFileSync(file, 'utf8')); }
export function assessPackagedLicensing({ manifest, license, notices, readme }) {
  const headline = readme.split('\n')[4]?.trim() ?? '', policyLinkPresent = readme.includes('https://github.com/jitwark/sfscanner/blob/main/docs/LICENSING.md');
  const hasCommercialRestriction = /(?:commercial\s+enterprise\s+license|enterprise\s+commercial\s+license|commercial\s+deployments?\s+require|individual\s+non-commercial\s+use)/iu.test(readme);
  const consistent = manifest.license === 'MIT' && /^MIT License/u.test(license) && /MIT/iu.test(notices)
    && headline.includes("MIT for this package's code and scanner tooling. The catalogue dataset has separate Personal / Non-Commercial terms") && policyLinkPresent && !hasCommercialRestriction;
  return { status: consistent ? 'pass' : 'fail', headline, policyLinkPresent, hasCommercialRestriction };
}
/** Build a depth-matched scratch copy and pack it, so the digest matches an in-place pack. */
function packTarball() {
  const buildRoot = path.join(HUB_ROOT, 'packages', `.verify-packed-cli-${String(process.pid)}`);
  const packedDir = mkdtempSync(path.join(os.tmpdir(), 'sfscanner-packed-'));
  rmSync(buildRoot, { recursive: true, force: true });
  const skip = (source) => !/(?:^|[/\\])(?:node_modules|dist|\.verify-packed-cli-[^/\\]*)$/u.test(source);
  cpSync(PACKAGE_DIR, buildRoot, { recursive: true, filter: skip });
  ok('build', run(process.execPath, ['build.mjs'], { cwd: buildRoot }));
  const output = JSON.parse(ok('npm pack', npm(['pack', '--json', '--ignore-scripts', '--pack-destination', packedDir], buildRoot)).stdout);
  const first = output[0];
  if (first?.filename === undefined || !Array.isArray(first.files)) throw new Error(`unexpected npm pack output: ${JSON.stringify(output)}`);
  const tarball = path.resolve(packedDir, path.basename(first.filename));
  return { buildRoot, packedDir, tarball, name: first.filename, bytes: first.size, files: first.files.map((f) => f.path), sha256: sha256(tarball) };
}
function install(tarball) {
  const consumer = mkdtempSync(path.join(os.tmpdir(), 'sfscanner-consumer-'));
  writeFileSync(path.join(consumer, 'package.json'), `${JSON.stringify({ name: 'verify-consumer', version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`);
  ok('npm install', npm(['install', '--no-save', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer));
  writeFileSync(path.join(consumer, 'clean.json'), `${JSON.stringify(CLEAN)}\n`);
  writeFileSync(path.join(consumer, 'risky.json'), `${JSON.stringify(RISKY)}\n`);
  writeFileSync(path.join(consumer, 'bad.json'), '{ not json\n');
  mkdirSync(path.join(consumer, 'wfdir'), { recursive: true });
  writeFileSync(path.join(consumer, 'wfdir/a.json'), `${JSON.stringify(CLEAN)}\n`);
  writeFileSync(path.join(consumer, 'tty-shim.mjs'), TTY_SHIM);
  writeFileSync(path.join(consumer, 'offline-guard.mjs'), OFFLINE_GUARD);
  writeFileSync(path.join(consumer, 'guard-control.mjs'), GUARD_CONTROL);
  return { consumer, installed: path.join(consumer, 'node_modules', PACKAGE_NAME) };
}
const TTY_SHIM = `for (const stream of [process.stdout, process.stderr]) {
  try { Object.defineProperty(stream, 'isTTY', { value: true, configurable: true }); } catch {}
  try { Object.defineProperty(stream, 'columns', { value: 120, configurable: true }); } catch {}
}
`;
const OFFLINE_GUARD = `import dns from 'node:dns'; import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';
const fail = (label) => () => { throw new Error(\`OFFLINE VIOLATION: \${label}\`); };
globalThis.fetch = fail('fetch');
http.request = fail('http.request'); http.get = fail('http.get');
https.request = fail('https.request'); https.get = fail('https.get');
net.connect = fail('net.connect'); net.createConnection = fail('net.createConnection'); net.Socket.prototype.connect = fail('net.Socket.connect');
tls.connect = fail('tls.connect');
dns.lookup = fail('dns.lookup'); dns.promises.lookup = fail('dns.promises.lookup'); dns.resolve = fail('dns.resolve');
`;
const GUARD_CONTROL = `try { await fetch('http://127.0.0.1:1'); console.error('guard did not fire'); process.exitCode = 1; }
catch (cause) { if (!String(cause).includes('OFFLINE VIOLATION')) { console.error(String(cause)); process.exitCode = 1; } }
`;

function cli(consumer, args, options = {}) {
  const nodeArgs = options.preload === undefined ? [] : ['--import', options.preload];
  return run(process.execPath, [...nodeArgs, path.join(consumer, 'node_modules', PACKAGE_NAME, 'dist', 'main.js'), ...args], { cwd: consumer });
}
function probeSource() {
  const targets = Object.fromEntries(Object.keys(SUBPATH_EXPORTS).map((subpath) => [`${PACKAGE_NAME}${subpath.slice(1)}`, SUBPATH_EXPORTS[subpath]]));
  return `const targets = ${JSON.stringify(targets)};
const failures = [];
for (const [specifier, name] of Object.entries(targets)) {
  try { const loaded = await import(specifier); if (typeof loaded[name] !== "function") failures.push(\`\${specifier}: \${name} is \${typeof loaded[name]}\`); }
  catch (cause) { failures.push(\`\${specifier}: \${cause?.code ?? cause?.message ?? cause}\`); }
}
let root = "resolved";
try { await import("sfscanner"); } catch (cause) { root = cause?.code ?? "failed"; }
console.log(JSON.stringify({ failures, root }));
if (failures.length > 0) process.exitCode = 1;
`;
}

/** Runs all checks and returns a report; never throws for a failed check, only for a broken probe. */
export function verifyPackedCli() {
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });
  const recorded = packTarball();
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'sfscanner-work-'));
  try {
    const published = json(path.join(PACKAGE_DIR, 'package.json'));
    const { consumer, installed } = install(recorded.tarball);
    const installedManifest = json(path.join(installed, 'package.json'));
    const tarballInfo = { name: recorded.name, path: recorded.tarball, bytes: recorded.bytes, sha256: recorded.sha256, fileCount: recorded.files.length, files: recorded.files };
    const environment = { node: process.version, platform: process.platform, arch: process.arch, npm: ok('npm --version', npm(['--version'], HUB_ROOT)).stdout.trim() };
    // 1. Tarball contents match the advertised `files`, exports, and binaries.
    const declared = published.files ?? [];
    const allowed = (file) => file === 'package.json' || declared.some((entry) => file === entry || file.startsWith(`${entry}/`));
    const stray = recorded.files.filter((file) => !allowed(file) || /\.tsx?$/u.test(file) && !file.endsWith('.d.ts'));
    const exportTargets = Object.entries(installedManifest.exports ?? {}).flatMap(([, conditions]) => Object.values(conditions));
    const binTargets = Object.values(installedManifest.bin ?? {});
    const missing = [...REQUIRED_FILES, ...exportTargets, ...binTargets].map((t) => t.replace(/^\.\//u, '')).filter((t) => !recorded.files.includes(t));
    add('tarball-integrity', stray.length === 0 && missing.length === 0 ? 'pass' : 'fail',
      `sha256=${recorded.sha256} bytes=${String(recorded.bytes)} files=${String(recorded.files.length)}; stray=${JSON.stringify(stray)}; missing=${JSON.stringify(missing)}`);
    // 2. Installed manifest and bin shims.
    const binNames = readdirSync(path.join(consumer, 'node_modules', '.bin')).filter((f) => f.startsWith(PACKAGE_NAME));
    const shebangs = binTargets.map((t) => readFileSync(path.join(installed, t.replace(/^\.\//u, '')), 'utf8').startsWith('#!/usr/bin/env node'));
    add('install-integrity', JSON.stringify(installedManifest) === JSON.stringify(published) && shebangs.every(Boolean) && binNames.length >= 2 ? 'pass' : 'fail',
      `manifest-equals-published=${String(JSON.stringify(installedManifest) === JSON.stringify(published))}; bin-shims=${JSON.stringify(binNames)}; shebangs=${JSON.stringify(shebangs)}`);
    // 3. Every advertised subpath resolves from the clean install.
    writeFileSync(path.join(consumer, 'probe-subpaths.mjs'), probeSource());
    const probe = run(process.execPath, ['probe-subpaths.mjs'], { cwd: consumer });
    const probed = JSON.parse(probe.stdout.trim() || '{}');
    add('subpath-resolution', probe.status === 0 && probed.failures?.length === 0 ? 'pass' : 'fail',
      `resolved=${String(Object.keys(SUBPATH_EXPORTS).length - (probed.failures?.length ?? 0))}/${String(Object.keys(SUBPATH_EXPORTS).length)}; failures=${JSON.stringify(probed.failures)}; root-import(${PACKAGE_NAME})=${String(probed.root)} (main=${String(published.main)} is unreachable because exports omits ".")`);
    // 4. The MCP server ships inside this tarball; there is no separate MCP workspace package.
    const workspaces = json(path.join(HUB_ROOT, 'package.json')).workspaces ?? [];
    const mcpPackage = workspaces.filter((w) => /mcp/iu.test(w));
    const listed = mcpSession(run, consumer, process.execPath, [path.join(installed, 'dist', 'mcp.js')], ['{"jsonrpc":"2.0","id":"i","method":"initialize"}', '{"jsonrpc":"2.0","id":"t","method":"tools/list"}']);
    const tools = listed.find((m) => m.id === 't')?.result?.tools ?? [];
    add('mcp-in-package', mcpPackage.length === 0 && tools.map((t) => t.name).join() === MCP_TOOL_NAME ? 'pass' : 'fail',
      `mcp-workspaces=${JSON.stringify(mcpPackage)}; mcp-bin=${String(installedManifest.bin?.['sfscanner-mcp'])}; tools=${JSON.stringify(tools.map((t) => t.name))}`);
    const entry = probeInstalledMcpEntry({ run, consumer, installed, tool: MCP_TOOL_NAME });
    add('mcp-installed-entry', entry.status, entry.detail);
    // 5. CLI and MCP must admit the same profile specifiers (contracts.ts states this invariant).
    const enumProfiles = tools[0]?.inputSchema?.properties?.profile?.enum ?? [];
    const cliVerdicts = Object.fromEntries(enumProfiles.concat('beta-hardened').map((p) => [p, cli(consumer, ['--schema', 'v2', 'scan', 'clean.json', '--profile', p]).status]));
    const admittedByCli = Object.entries(cliVerdicts).filter(([, s]) => s === 0).map(([p]) => p);
    const disagree = enumProfiles.filter((p) => cliVerdicts[p] !== 0);
    add('cli-mcp-profile-agreement', disagree.length === 0 ? 'pass' : 'fail',
      `mcp-enum=${JSON.stringify(enumProfiles)}; cli-admits=${JSON.stringify(admittedByCli)}; cli-refuses-mcp-enum=${JSON.stringify(disagree)}; cli-exit-codes=${JSON.stringify(cliVerdicts)}`);
    // 6. The packaged README presents `--schema v2` as optional but documents v2-only options.
    const readme = readFileSync(path.join(installed, 'README.md'), 'utf8');
    const cliStatus = (args) => cli(consumer, args).status;
    const grammar = { failOnNoSchema: cliStatus(['scan', 'risky.json', '--fail-on', 'HIGH']), dirNoSchema: cliStatus(['scan', 'wfdir']), outputNoSchema: cliStatus(['scan', 'clean.json', '--output', 'o.json']), failOnV2: cliStatus(['--schema', 'v2', 'scan', 'risky.json', '--fail-on', 'HIGH']), dirV2: cliStatus(['--schema', 'v2', 'scan', 'wfdir']) };
    const optionalSchemaBroken = grammar.failOnNoSchema !== 0 && grammar.outputNoSchema !== 0 && readme.includes('[--schema v2] scan');
    add('docs-grammar-consistency', optionalSchemaBroken ? 'fail' : 'pass',
      `readme-advertises-optional-schema=${String(readme.includes('[--schema v2] scan'))}; exits=${JSON.stringify(grammar)}`);
    // 7. Default output format must honour the README's TTY claim.
    const piped = cli(consumer, ['--schema', 'v2', 'scan', 'clean.json']);
    const tty = cli(consumer, ['--schema', 'v2', 'scan', 'clean.json'], { preload: './tty-shim.mjs' });
    const pipedJson = piped.stdout.trimStart().startsWith('{');
    const ttyJson = tty.stdout.trimStart().startsWith('{');
    const isTtyRefs = readFileSync(path.join(installed, 'dist', 'main.js'), 'utf8').includes('isTTY');
    add('tty-default-format', readme.includes('table` for terminal') && ttyJson && !isTtyRefs ? 'fail' : 'pass',
      `readme-claims='table for terminal, json for programmatic'; piped=${pipedJson ? 'json' : '?'}; simulated-tty=${ttyJson ? 'json' : tty.stdout.trimStart().slice(0, 20)}; dist-references-isTTY=${String(isTtyRefs)}`);
    // 8. Offline isolation: the scan path must not touch the network.
    const offline = cli(consumer, ['--schema', 'v2', 'scan', 'risky.json'], { preload: './offline-guard.mjs' });
    const offlineV1 = cli(consumer, ['scan', 'risky.json'], { preload: './offline-guard.mjs' });
    const control = run(process.execPath, ['--import', './offline-guard.mjs', 'guard-control.mjs'], { cwd: consumer });
    const violated = /OFFLINE VIOLATION/u.test(offline.stderr + offlineV1.stderr);
    add('offline-isolation', !violated && offline.status === 1 && offlineV1.status === 1 && control.status === 0 ? 'pass' : 'fail',
      `v2-exit=${String(offline.status)} v1-exit=${String(offlineV1.status)} violation=${String(violated)}; guard-control-exit=${String(control.status)}`);
    // 9. Atomic output: temp-then-rename, refuse input collision and absolute paths.
    rmSync(path.join(consumer, 'report.json'), { force: true });
    const before = readFileSync(path.join(consumer, 'clean.json'), 'utf8');
    const write = cli(consumer, ['--schema', 'v2', 'scan', 'clean.json', '--output', 'report.json']);
    const leftovers = readdirSync(consumer).filter((f) => /^\.report\.json\.tmp-/u.test(f));
    const collision = cli(consumer, ['--schema', 'v2', 'scan', 'clean.json', '--output', 'clean.json']);
    const absolute = cli(consumer, ['--schema', 'v2', 'scan', 'clean.json', '--output', '/abs/report.json']);
    const dash = cli(consumer, ['--schema', 'v2', 'scan', 'clean.json', '--output', '-']);
    const parses = (file) => { try { json(file); return true; } catch { return false; } };
    const atomicOk = write.status === 0 && write.stdout === '' && parses(path.join(consumer, 'report.json')) && leftovers.length === 0 && collision.status === 2 && readFileSync(path.join(consumer, 'clean.json'), 'utf8') === before && absolute.status === 2 && dash.status === 0 && dash.stdout.trimStart().startsWith('{');
    add('atomic-write', atomicOk ? 'pass' : 'fail',
      `write-exit=${String(write.status)} stdout=${JSON.stringify(write.stdout.slice(0, 20))} temp-leftovers=${JSON.stringify(leftovers)} collision-exit=${String(collision.status)} input-unchanged=${String(readFileSync(path.join(consumer, 'clean.json'), 'utf8') === before)} absolute-exit=${String(absolute.status)} dash-exit=${String(dash.status)}`);
    // 10. Exit codes 0/1/2/3.
    const exits = { clean: cliStatus(['--schema', 'v2', 'scan', 'clean.json']), findings: cliStatus(['--schema', 'v2', 'scan', 'risky.json']), usage: cliStatus(['--schema', 'v2', 'scan', 'clean.json', '--bogus']), input: cliStatus(['--schema', 'v2', 'scan', 'bad.json']) };
    add('exit-codes', exits.clean === 0 && exits.findings === 1 && exits.usage === 2 && exits.input === 3 ? 'pass' : 'fail', JSON.stringify(exits));
    add('exit-code-130', 'skip', 'cancellation requires a portable SIGINT to the installed child; not exercised by this probe (see task 5.3 report)');
    add('exit-code-4', 'skip', 'internal failure is not reachable from a valid install without fault injection outside the package surface');
    // 11. Advertised Node/OS matrix vs what the tarball declares.
    const engines = installedManifest.engines ?? {};
    const openEnded = typeof engines.node === 'string' && /^>=\s*\d+$/u.test(engines.node);
    add('node-os-matrix', openEnded ? 'fail' : 'pass',
      `engines=${JSON.stringify(engines)}; os=${JSON.stringify(installedManifest.os)}; cpu=${JSON.stringify(installedManifest.cpu)}; observed=${process.version} ${process.platform}/${process.arch}; ${openEnded ? `engines.node="${String(engines.node)}" is an open range, so it admits Node 24+ with no matrix result` : 'the declared range is bounded, so it does not advertise an untested line'}`);
    add('cross-platform-execution', 'skip', `only ${process.platform} was executed here; Linux/macOS (- and Windows Node 24) runs remain unverified`);
    // 12. Licensing statements in the tarball.
    const license = readFileSync(path.join(installed, 'LICENSE'), 'utf8'), notices = readFileSync(path.join(installed, 'THIRD_PARTY_NOTICES.md'), 'utf8'), assessment = assessPackagedLicensing({ manifest: installedManifest, license, notices, readme });
    add('licensing-consistency', assessment.status,
      `manifest.license=${String(installedManifest.license)}; LICENSE=${JSON.stringify(license.split('\n')[0])}; notices-claims-MIT=${String(/MIT/iu.test(notices))}; README-headline=${JSON.stringify(assessment.headline)}; README-policy-link=${assessment.policyLinkPresent ? 'external canonical policy URL' : 'missing'}; README-commercial-restriction=${assessment.hasCommercialRestriction ? 'detected' : 'none'}`);

    return { packageName: PACKAGE_NAME, tarball: tarballInfo, consumer, environment, checks, summary: summarize(checks) };
  } finally {
    rmSync(recorded.buildRoot, { recursive: true, force: true });
    rmSync(recorded.packedDir, { recursive: true, force: true });
    rmSync(workRoot, { recursive: true, force: true });
  }
}
function summarize(checks) {
  return { pass: checks.filter((c) => c.status === 'pass').length, fail: checks.filter((c) => c.status === 'fail').length, skip: checks.filter((c) => c.status === 'skip').length };
}

export function renderReport(report) {
  const { tarball, environment, summary } = report;
  const lines = [
    `Packed-tarball publication contract — ${report.packageName}`,
    `tarball: ${tarball.name} (${String(tarball.bytes)} bytes, ${String(tarball.fileCount)} files)`,
    `tarball sha256: ${tarball.sha256}`,
    `environment: node ${environment.node}, npm ${environment.npm}, ${environment.platform}/${environment.arch}`,
    'checks:',
    ...report.checks.map((c) => `  ${c.status.toUpperCase().padEnd(4)} ${c.id} — ${c.detail}`),
    `summary: ${String(summary.pass)} pass, ${String(summary.fail)} fail, ${String(summary.skip)} skip`,
  ];
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = verifyPackedCli();
  process.stdout.write(renderReport(report));
  if (report.summary.fail > 0) process.exitCode = 1;
}
