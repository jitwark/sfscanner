import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyPackedBuildWorkspace } from './packed-build.test-helper';

/**
 * The packed scanner is the artifact a consumer runs, so the CLI matrix below is driven through a
 * tarball installed into a directory with no workspace symlinks: stdin, a file, a directory, a
 * relative glob, symlink refusal, empty/malformed/oversized input, the concurrency and timeout
 * bounds, SIGINT cancellation, atomic output, all four formats, the documented exit precedence,
 * the MCP stdio handshake, and the offline closure (`OFFLINE VIOLATION`, the guard mechanism
 * `scripts/verify-packed-cli.mjs` uses). The build runs in a copy under the OS temp directory.
 */
const HUB_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PACKAGE_NAME = 'sfscanner';
const MAX_INPUT_BYTES = 1_536_000;
const WORK_TIMEOUT_MS = 600_000;
const CASE_TIMEOUT_MS = 30_000;

const CLEAN = { name: 'clean', nodes: [{ parameters: {}, id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] }], connections: {}, active: false, settings: {}, versionId: 'v1' };
const RISKY = { name: 'risky', nodes: [...CLEAN.nodes, { parameters: { command: 'printf hi' }, id: 'r', name: 'Run', type: 'n8n-nodes-base.executeCommand', typeVersion: 1, position: [240, 0] }], connections: {}, active: false, settings: {}, versionId: 'v2' };
/** Large enough that no read or scan of it can finish inside a 1 ms deadline. */
const heavy = (): string => JSON.stringify({ name: 'heavy', active: false, settings: {}, versionId: 'heavy', connections: {}, nodes: Array.from({ length: 1500 }, (_, index) => ({ parameters: { text: 'y'.repeat(180) }, id: `n${String(index)}`, name: `N${String(index)}`, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, index] })) });

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
/** A real SIGINT cannot be delivered to a child on Windows, so the packaged entry is given a synthesized one. */
const CANCEL_DRIVER = `import { pathToFileURL } from 'node:url';
const [target, ...argv] = process.argv.slice(2);
process.argv = ['node', 'sfscanner', ...argv];
const timer = setInterval(() => { process.emit('SIGINT'); }, 1);
await import(pathToFileURL(target).href);
clearInterval(timer);
`;

type Run = Readonly<{ status: number | null; stdout: string; stderr: string }>;
type ErrorBody = Readonly<{ kind: string; code: string; message: string }>;
type Envelope = Readonly<{ schemaVersion: string; exitReason: string; results: readonly Readonly<{ input: string; ok: boolean; error?: ErrorBody }>[] }>;
type McpMessage = Readonly<{ id?: unknown; result?: unknown; error?: Readonly<{ code: number; message: string }> }>;
/** A shape the packaged MCP server owns; a wrong one fails the assertion that reads it. */
type ToolCall = Readonly<{ isError: boolean; structuredContent: Readonly<{ exitCode: number }>; content: readonly Readonly<{ type: string; text: string }>[] }>;

function run(command: string, args: readonly string[], cwd: string, input?: string): Run {
  const result = spawnSync(command, args, { cwd, input, encoding: 'utf8', timeout: 120_000 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function ok(result: Run, label: string): Run {
  if (result.status !== 0) throw new Error(`${label} exited ${String(result.status)}\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** `npm` is a shell shim on Windows, so prefer the npm CLI entry npm itself exports. */
function npm(args: readonly string[], cwd: string): Run {
  const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const quoted = args.map((value) => (/[\s"']/u.test(value) ? `"${value}"` : value));
  return npmCli.endsWith('.js') ? run(process.execPath, [npmCli, ...args], cwd) : run('npm', quoted, cwd);
}

const packed = { sha256: '', consumer: '', main: '', mcp: '', linkDir: false };
let workRoot = '';

const envelope = (result: Run): Envelope => JSON.parse(result.stdout) as Envelope;

/** Drives the installed entry with the same argv a consumer would type. */
function scan(args: readonly string[], options: Readonly<{ input?: string; guard?: boolean }> = {}): Run {
  const nodeArgs = options.guard === true ? ['--import', './offline-guard.mjs'] : [];
  return run(process.execPath, [...nodeArgs, packed.main, '--schema', 'v2', 'scan', ...args], packed.consumer, options.input);
}

function mcp(lines: readonly string[], guard = false): Run {
  const nodeArgs = guard ? ['--import', './offline-guard.mjs'] : [];
  return run(process.execPath, [...nodeArgs, packed.mcp], packed.consumer, `${lines.join('\n')}\n`);
}

/** The stdio server answers one JSON line per request, so the transcript is parsed line by line. */
const messages = (session: Run): readonly McpMessage[] => session.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as McpMessage);

beforeAll(() => {
  workRoot = mkdtempSync(path.join(os.tmpdir(), 'sfscanner-matrix-'));
  const copy = copyPackedBuildWorkspace(workRoot, HUB_ROOT);
  ok(run(process.execPath, ['build.mjs'], copy), 'build');

  const packedDir = path.join(workRoot, 'packed');
  mkdirSync(packedDir);
  const release: readonly Readonly<{ filename?: string; entryCount?: number }>[] = JSON.parse(ok(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', packedDir], copy), 'npm pack').stdout);
  const tarball = path.join(packedDir, path.basename(release[0]?.filename ?? ''));
  packed.sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');

  packed.consumer = path.join(workRoot, 'consumer');
  mkdirSync(packed.consumer);
  writeFileSync(path.join(packed.consumer, 'package.json'), `${JSON.stringify({ name: 'sfscanner-matrix-consumer', version: '0.0.0', private: true, type: 'module' })}\n`);
  ok(npm(['install', '--no-save', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund', tarball], packed.consumer), 'npm install');

  const installed = path.join(packed.consumer, 'node_modules', PACKAGE_NAME);
  packed.main = path.join(installed, 'dist', 'main.js');
  packed.mcp = path.join(installed, 'dist', 'mcp.js');

  const fixtures: Readonly<Record<string, string>> = {
    'clean.json': `${JSON.stringify(CLEAN)}\n`, 'wfdir/a.json': `${JSON.stringify(CLEAN)}\n`,
    'risky.json': `${JSON.stringify(RISKY)}\n`, 'wfdir/b.json': `${JSON.stringify(RISKY)}\n`,
    'bad.json': '{ not json\n', 'oversized.json': `{"pad":"${'x'.repeat(MAX_INPUT_BYTES + 1024)}"}`, 'heavy.json': heavy(),
    'cancel-driver.mjs': CANCEL_DRIVER, 'offline-guard.mjs': OFFLINE_GUARD, 'guard-control.mjs': GUARD_CONTROL,
  };
  for (const [name, content] of Object.entries(fixtures)) {
    mkdirSync(path.dirname(path.join(packed.consumer, name)), { recursive: true });
    writeFileSync(path.join(packed.consumer, name), content);
  }
  mkdirSync(path.join(packed.consumer, 'empty'));

  try {
    symlinkSync(path.join(packed.consumer, 'wfdir'), path.join(packed.consumer, 'link-dir'), process.platform === 'win32' ? 'junction' : 'dir');
    packed.linkDir = true;
  } catch {
    process.stdout.write('packed-cli-matrix: GAP symlink refusal not exercised (link creation is not permitted here)\n');
  }
  process.stdout.write(`packed-cli-matrix: ${path.basename(tarball)} sha256=${packed.sha256} entries=${String(release[0]?.entryCount ?? 0)}\n`);
}, WORK_TIMEOUT_MS);

afterAll(() => {
  // Node removes junctions themselves, without traversing their external dependency targets.
  rmSync(workRoot, { recursive: true, force: true });
});

describe('packed scanner CLI', () => {
  const EXITS: readonly (readonly [string, readonly string[], number, string, boolean])[] = [
    ['a directory filtered by a relative glob', ['wfdir', '--include', '**/a*.json'], 0, '', false],
    ['a relative glob that matches nothing', ['wfdir', '--include', '**/z*.json'], 2, 'No matching workflow inputs found.', true],
    ['--max-concurrency 1', ['wfdir', '--max-concurrency', '1'], 1, '', false],
    ['--max-concurrency 16', ['wfdir', '--max-concurrency', '16'], 1, '', false],
    ['--max-concurrency 17', ['clean.json', '--max-concurrency', '17'], 2, 'Invalid command usage: Numeric option is invalid. (--max-concurrency)', true],
    ['--timeout 60000', ['clean.json', '--timeout', '60000'], 0, '', false],
    ['a usage error beside a finding', ['risky.json', '--max-concurrency', '17'], 2, 'Invalid command usage: Numeric option is invalid. (--max-concurrency)', true],
  ];
  for (const [name, args, code, message, silent] of EXITS) {
    it(`${name} exits ${String(code)}`, () => {
      const result = scan(args);
      expect([result.status, result.stderr.trim(), result.stdout === '']).toEqual([code, message, silent]);
    }, CASE_TIMEOUT_MS);
  }

  it('reports one selection-relative label per selected input', () => {
    const file = scan(['clean.json']);
    const directory = scan(['wfdir']);
    const glob = scan(['wfdir', '--include', '**/a*.json']);
    expect([file.status, envelope(file).results.map(({ input }) => input)]).toEqual([0, ['clean.json']]);
    expect([directory.status, envelope(directory).results.map(({ input }) => input)]).toEqual([1, ['wfdir/a.json', 'wfdir/b.json']]);
    // The glob excludes the only risky file, so a clean result proves the filter applied.
    expect([glob.status, envelope(glob).results.map(({ input }) => input)]).toEqual([0, ['wfdir/a.json']]);
  }, CASE_TIMEOUT_MS);

  it('reads a workflow from stdin and refuses an empty stdin', () => {
    const piped = scan(['-'], { input: readFileSync(path.join(packed.consumer, 'clean.json'), 'utf8') });
    const empty = scan(['-'], { input: '' });
    expect([piped.status, envelope(piped).results.map(({ input }) => input), empty.status, envelope(empty).results[0]?.error?.code]).toEqual([0, ['-'], 3, 'INVALID_JSON']);
  }, CASE_TIMEOUT_MS);

  it('refuses a directory symlink and an empty directory', (context) => {
    context.skip(!packed.linkDir, 'symlink creation is not permitted in this environment');
    const link = scan(['link-dir']);
    const nothing = scan(['empty']);
    expect([link.status, link.stderr.trim()]).toEqual([2, 'Direct symlink must resolve to a regular file.']);
    // A pre-scan selection failure carries no machine envelope; the message is the whole report.
    expect([nothing.status, nothing.stdout, nothing.stderr.trim()]).toEqual([2, '', 'No matching workflow inputs found.']);
  }, CASE_TIMEOUT_MS);

  it('classifies malformed, oversized, and timed-out inputs in the envelope', () => {
    const malformed = scan(['bad.json']);
    const oversized = scan(['oversized.json']);
    const expired = scan(['heavy.json', '--timeout', '1']);
    expect([malformed.status, envelope(malformed).results[0]?.error, oversized.status, envelope(oversized).results[0]?.error?.code, expired.status, envelope(expired).results[0]?.error])
      .toEqual([3, { kind: 'INPUT', code: 'INVALID_JSON', message: 'Input is not valid JSON.' }, 3, 'WORKFLOW_TOO_LARGE', 3, { kind: 'INCOMPLETE', code: 'SCAN_TIMEOUT', message: 'Scan timed out.' }]);
  }, CASE_TIMEOUT_MS);

  it('exits 130 with a valid envelope when SIGINT interrupts the scan', () => {
    const cancelled = run(process.execPath, [path.join(packed.consumer, 'cancel-driver.mjs'), packed.main, '--schema', 'v2', 'scan', 'heavy.json'], packed.consumer);
    expect([cancelled.status, cancelled.stderr, envelope(cancelled).exitReason]).toEqual([130, '', 'CANCELLED']);
  }, CASE_TIMEOUT_MS);

  it('preserves a prior output file byte-identical when the next run collides with an input', () => {
    const input = path.join(packed.consumer, 'clean.json');
    const report = path.join(packed.consumer, 'report.json');
    const first = scan(['clean.json', '--output', 'report.json']);
    expect([first.status, first.stdout]).toEqual([0, '']);
    const before = [readFileSync(input), readFileSync(report)];

    const collision = scan(['clean.json', '--output', 'clean.json']);
    expect([collision.status, collision.stderr.trim()]).toEqual([2, 'Output path collides with an input file.']);
    expect([readFileSync(input), readFileSync(report)]).toEqual(before);
    expect(readdirSync(packed.consumer).filter((name) => name.startsWith('.') && name.includes('.tmp-'))).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it('emits json, ndjson, table, and sarif for the same findings', () => {
    const json = scan(['risky.json']);
    const lines = scan(['risky.json', '--format', 'ndjson']).stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as Readonly<{ schemaVersion: string; type: string }>);
    const table = scan(['risky.json', '--format', 'table']);
    const sarif: Readonly<{ version: string; runs: readonly Readonly<{ results?: readonly unknown[] }>[] }> = JSON.parse(scan(['risky.json', '--format', 'sarif']).stdout);
    expect([json.status, envelope(json).schemaVersion, lines.map(({ schemaVersion, type }) => [schemaVersion, type]), table.stdout.includes('Input'), sarif.version, sarif.runs.length > 0, (sarif.runs[0]?.results?.length ?? 0) > 0])
      .toEqual([1, 'n8n-scan-v2', [['n8n-scan-v2-ndjson', 'header'], ['n8n-scan-v2-ndjson', 'result'], ['n8n-scan-v2-ndjson', 'summary']], true, '2.1.0', true, true]);
  }, CASE_TIMEOUT_MS);

  it('applies the documented precedence: usage, then finding threshold, then item failure', () => {
    const itemFailure = scan(['bad.json']);
    const threshold = scan(['bad.json', 'risky.json']);
    expect([itemFailure.status, envelope(itemFailure).exitReason]).toEqual([3, 'ITEM_FAILURE']);
    expect([threshold.status, envelope(threshold).exitReason, envelope(threshold).results.map(({ ok: succeeded }) => succeeded)]).toEqual([1, 'FINDING_THRESHOLD', [false, true]]);
  }, CASE_TIMEOUT_MS);

  it('fails closed on a guarded network call and never trips the guard while scanning', () => {
    const control = run(process.execPath, ['--import', './offline-guard.mjs', 'guard-control.mjs'], packed.consumer);
    expect([control.status, control.stdout]).toEqual([0, '']);
    const scans = [scan(['risky.json'], { guard: true }), scan(['-'], { input: readFileSync(path.join(packed.consumer, 'clean.json'), 'utf8'), guard: true })];
    expect(scans.map(({ status, stderr }) => [status, /OFFLINE VIOLATION/u.test(stderr)])).toEqual([[1, false], [0, false]]);
  }, CASE_TIMEOUT_MS);
});

describe('packed sfscanner-mcp stdio handshake', () => {
  it('initialises, lists the one tool, and scans an installed fixture without a network call', () => {
    const session = mcp([
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"n8n_scan","arguments":{"inputs":["clean.json"]}}}',
    ], true);
    const [initialised, listed, scanned] = messages(session);
    const call = scanned?.result as ToolCall | undefined;
    expect([/OFFLINE VIOLATION/u.test(session.stderr), initialised, listed]).toEqual([false, { jsonrpc: '2.0', id: 1, result: expect.objectContaining({ protocolVersion: '2025-06-18' }) }, { jsonrpc: '2.0', id: 2, result: { tools: [expect.objectContaining({ name: 'n8n_scan' })] } }]);
    expect([call?.isError, call?.structuredContent.exitCode, call?.content[0]?.type]).toEqual([false, 0, 'text']);
    // The scan ran in the install against the fixture already there, never a private body.
    expect(JSON.parse(call?.content[0]?.text ?? '')).toMatchObject({ schemaVersion: 'n8n-scan-v2', exitReason: 'UNDER_THRESHOLD', results: [{ input: 'clean.json' }] });
  }, CASE_TIMEOUT_MS);
});
