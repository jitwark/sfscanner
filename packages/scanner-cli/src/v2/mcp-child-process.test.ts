import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const driver = fileURLToPath(new URL('./__fixtures__/mcp-server-driver.mjs', import.meta.url));
const sourceEntry = fileURLToPath(new URL('./mcp.ts', import.meta.url));
const tsxLoader = fileURLToPath(new URL('../../../../node_modules/tsx/dist/loader.mjs', import.meta.url));
const cleanWorkflow = 'packages/scanner-cli/src/v2/__fixtures__/clean-workflow.json';
const MAX_LINE_BYTES = 1_048_576;
const owned: { child: ChildProcessWithoutNullStreams; lines: Interface }[] = [];

function startProcess(entry: string, options: { sentinel?: boolean; cwd?: string } = {}) {
  const child = spawn(process.execPath, ['--import', pathToFileURL(tsxLoader).href, entry], {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, NO_COLOR: '1', ...(options.sentinel === true ? { MCP_SENTINEL: '1' } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => undefined);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  owned.push({ child, lines });
  const iterator = lines[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const next = async (): Promise<Record<string, unknown>> => {
    const { value } = await iterator.next();
    return JSON.parse(value) as Record<string, unknown>;
  };
  const send = (value: unknown): void => { child.stdin.write(`${JSON.stringify(value)}\n`); };
  return { child, next, send, stderr: () => stderr };
}

function start(options: { sentinel?: boolean } = {}) {
  return startProcess(driver, options);
}

afterEach(() => {
  for (const { child, lines } of owned.splice(0)) {
    lines.close();
    child.stdin.destroy();
    child.kill();
  }
});

describe('MCP child process with stdin held open', () => {
  it('answers notifications silently and still serves the next request', async () => {
    const { send, next } = start();
    send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect((await next()).id).toBe(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', method: 'notifications/cancelled' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const response = await next();
    expect(response.id).toBe(2);
    expect(response.result).toBeDefined();
  });

  it('returns -32602 for stdin "-" without EOF and serves the next request', async () => {
    const { child, send, next } = start();
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'n8n_scan', arguments: { inputs: ['-'] } } });
    expect(await next()).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'Invalid n8n_scan arguments.' } });
    expect(child.stdin.writable).toBe(true);
    send({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
    expect((await next()).id).toBe(4);
  });

  it('rejects a present null id safely', async () => {
    const { send, next } = start();
    send({ jsonrpc: '2.0', id: null, method: 'tools/list' });
    expect(await next()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request.' } });
  });

  it('answers one -32700 for an over-limit multibyte line and keeps serving', async () => {
    const { child, next } = start();
    const chars = Math.ceil(MAX_LINE_BYTES / 2) + 1;
    const huge = `{"jsonrpc":"2.0","id":5,"method":"tools/list","pad":"${'é'.repeat(chars)}"}`;
    child.stdin.write(`${huge}\n${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' })}\n`);
    expect(await next()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } });
    expect((await next()).id).toBe(6);
  });

  it('serves a final unterminated valid line at EOF', async () => {
    const { child, next } = start();
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }));
    child.stdin.end();
    expect((await next()).id).toBe(7);
  });

  it('serves a CRLF request', async () => {
    const { child, next } = start();
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' })}\r\n`);
    expect((await next()).id).toBe(8);
  });

  it('diverts console sentinels to stderr and keeps stdout protocol-only', async () => {
    const { send, next, stderr } = start({ sentinel: true });
    send({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
    expect((await next()).id).toBe(9);
    for (const sentinel of [
      'MCP_SENTINEL_LOG', 'MCP_SENTINEL_INFO', 'MCP_SENTINEL_WARN', 'MCP_SENTINEL_ERROR',
      'MCP_SENTINEL_DIR', 'MCP_SENTINEL_TABLE', 'MCP_SENTINEL_ASSERT', 'MCP_SENTINEL_COUNT',
      'MCP_SENTINEL_GROUP', 'MCP_SENTINEL_TRACE',
    ]) expect(stderr()).toContain(sentinel);
  });

  it('runs the actual mcp.ts source entry with stdin held open and recovers', async () => {
    const { child, send, next } = startProcess(sourceEntry);
    send({ jsonrpc: '2.0', id: 101, method: 'initialize' });
    expect((await next()).id).toBe(101);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', method: 'notifications/cancelled' });
    send({ jsonrpc: '2.0', id: 102, method: 'tools/call', params: { name: 'n8n_scan', arguments: { inputs: ['-'] } } });
    expect(await next()).toEqual({ jsonrpc: '2.0', id: 102, error: { code: -32602, message: 'Invalid n8n_scan arguments.' } });
    expect(child.stdin.writable).toBe(true);
    send({ jsonrpc: '2.0', id: 103, method: 'tools/list' });
    expect((await next()).id).toBe(103);
    const vectors: unknown[] = [
      { inputs: [cleanWorkflow], format: { toString: 'x' } },
      { inputs: [cleanWorkflow], format: ['sarif'] },
      { inputs: [cleanWorkflow], failOn: ['HIGH'] },
      { inputs: [] },
    ];
    for (const [index, args] of vectors.entries()) {
      send({ jsonrpc: '2.0', id: 110 + index, method: 'tools/call', params: { name: 'n8n_scan', arguments: args } });
      expect(await next()).toEqual({
        jsonrpc: '2.0', id: 110 + index, error: { code: -32602, message: 'Invalid n8n_scan arguments.' },
      });
    }
    expect(child.stdin.writable).toBe(true);
    send({
      jsonrpc: '2.0', id: 120, method: 'tools/call',
      params: { name: 'n8n_scan', arguments: { inputs: ['--format', 'sarif', cleanWorkflow] } },
    });
    const injection = await next();
    expect(injection.id).toBe(120);
    expect(injection.result).toMatchObject({ isError: true });
    expect(JSON.stringify(injection)).not.toContain('2.1.0');
    send({ jsonrpc: '2.0', id: 121, method: 'tools/list' });
    expect((await next()).id).toBe(121);
    const chars = Math.ceil(MAX_LINE_BYTES / 2) + 1;
    const huge = `{"jsonrpc":"2.0","id":130,"method":"tools/list","pad":"${'é'.repeat(chars)}"}`;
    child.stdin.write(`${huge}\n${JSON.stringify({ jsonrpc: '2.0', id: 131, method: 'tools/list' })}\n`);
    expect(await next()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } });
    expect((await next()).id).toBe(131);
  }, 15_000);

  it('serves when the advertised bin name is a symlink to the source entry', async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-entry-link-'));
    const alias = join(directory, 'sfscanner-mcp.ts');
    try {
      await symlink(sourceEntry, alias, 'file');
    } catch {
      // Windows without Developer Mode/SeCreateSymbolicLinkPrivilege: the packed
      // sfscanner-mcp-main.js probe is the cross-platform entry proof instead.
      await rm(directory, { recursive: true, force: true });
      context.skip();
      return;
    }
    const { child, send, next } = startProcess(alias);
    try {
      send({ jsonrpc: '2.0', id: 301, method: 'initialize' });
      expect((await next()).id).toBe(301);
      send({ jsonrpc: '2.0', id: 302, method: 'tools/list' });
      expect((await next()).id).toBe(302);
    } finally {
      child.stdin.destroy();
      child.kill();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it('does not start the transport when an unrelated mcp.js imports the module', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-import-'));
    await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
    const consumer = join(directory, 'mcp.js');
    // The sync write plus exit is reached only if the import resolves. The old suffix guard
    // awaited the stdio transport inside the import, so this consumer never got there.
    await writeFile(consumer, `import ${JSON.stringify(pathToFileURL(sourceEntry).href)};\nimport { writeSync } from 'node:fs';\nwriteSync(1, 'IMPORTED_WITHOUT_TRANSPORT\\n');\nprocess.exit(0);\n`);
    const child = spawn(process.execPath, ['--import', pathToFileURL(tsxLoader).href, consumer], {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => undefined);
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    try {
      const [code] = await once(child, 'close') as [number | null];
      expect(code).toBe(0);
      expect(stdout).toContain('IMPORTED_WITHOUT_TRANSPORT');
      expect(stdout).not.toContain('"jsonrpc"');
    } finally {
      child.kill();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);

  it('does not overwrite an existing file through option-like tools/call inputs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-entry-'));
    try {
      await copyFile(new URL('./__fixtures__/clean-workflow.json', import.meta.url), join(directory, 'clean.json'));
      const canary = '{"sentinel":"original"}';
      await writeFile(join(directory, 'existing.json'), canary);
      const { child, send, next } = startProcess(sourceEntry, { cwd: directory });
      send({ jsonrpc: '2.0', id: 201, method: 'initialize' });
      expect((await next()).id).toBe(201);
      send({
        jsonrpc: '2.0', id: 202, method: 'tools/call',
        params: { name: 'n8n_scan', arguments: { inputs: ['--output', 'existing.json', 'clean.json'] } },
      });
      const response = await next();
      expect(response.id).toBe(202);
      expect(response.result).toMatchObject({ isError: true });
      expect(await readFile(join(directory, 'existing.json'), 'utf8')).toBe(canary);
      expect((await readdir(directory)).sort()).toEqual(['clean.json', 'existing.json']);
      expect(child.stdin.writable).toBe(true);
      send({ jsonrpc: '2.0', id: 203, method: 'tools/list' });
      expect((await next()).id).toBe(203);
      child.kill();
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);
});
