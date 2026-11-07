import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgumentsV2 } from './arguments';
import { runCliV2 } from './cli-runner';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.join(packageRoot, 'dist');
let workspace = '';

beforeAll(async () => {
  try { await readFile(path.join(dist, 'scan-worker.js')); }
  catch { throw new Error('run `npm --workspace packages/scanner-cli run build` before this smoke'); }
  workspace = await mkdtemp(path.join(os.tmpdir(), 'sf-packed-worker-'));
  await writeFile(path.join(workspace, 'wf.json'), '{"nodes":[],"connections":{}}');
});

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

function command() {
  const parsed = parseArgumentsV2(['--schema', 'v2', 'scan', 'wf.json', '--format', 'json']);
  if (!parsed.ok || parsed.command.kind !== 'scan') throw new Error('fixture command must parse');
  return parsed.command;
}

/** External child JSON is untrusted; narrow it once instead of casting at each read. */
function readEnvelope(text: string): { results: Array<{ ok: boolean }> } {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || !('results' in value) || !Array.isArray(value.results)) {
    throw new Error('child output is not an envelope');
  }
  return {
    results: value.results.map((item: unknown) => {
      if (item === null || typeof item !== 'object' || !('ok' in item) || typeof item.ok !== 'boolean') {
        throw new Error('child envelope item is not a result');
      }
      return { ok: item.ok };
    }),
  };
}

function readRun(text: string): { exitCode: number; stdout: string } {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || !('exitCode' in value) || typeof value.exitCode !== 'number' || !('stdout' in value) || typeof value.stdout !== 'string') {
    throw new Error('child run output is malformed');
  }
  return { exitCode: value.exitCode, stdout: value.stdout };
}

async function runChild(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, args, { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { code, stdout, stderr };
}

describe('packed scan worker', () => {
  it('emits one root asset and no v2 duplicate', async () => {
    await expect(readFile(path.join(dist, 'scan-worker.js'), 'utf8')).resolves.toContain('postMessage');
    await expect(readFile(path.join(dist, 'v2', 'scan-worker.js'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs the default source path through the built worker', async () => {
    const result = await runCliV2(command(), { cwd: workspace });
    expect(result.exitCode).toBe(0);
    expect(readEnvelope(result.stdout).results[0]?.ok).toBe(true);
  });

  it('starts the worker from the packed v2 subpath', async () => {
    const consumer = path.join(workspace, 'consumer.mjs');
    const argumentsUrl = pathToFileURL(path.join(dist, 'v2', 'arguments.js')).href;
    const runnerUrl = pathToFileURL(path.join(dist, 'v2', 'cli-runner.js')).href;
    await writeFile(consumer, [
      `import { parseArgumentsV2 } from ${JSON.stringify(argumentsUrl)};`,
      `import { runCliV2 } from ${JSON.stringify(runnerUrl)};`,
      "const parsed = parseArgumentsV2(['--schema', 'v2', 'scan', 'wf.json', '--format', 'json']);",
      "if (!parsed.ok || parsed.command.kind !== 'scan') process.exit(2);",
      'const result = await runCliV2(parsed.command, { cwd: process.cwd() });',
      'process.stdout.write(JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout }));',
      '',
    ].join('\n'));
    const child = await runChild([consumer]);
    expect(child.stderr).toBe('');
    expect(child.code).toBe(0);
    const result = readRun(child.stdout);
    expect(result.exitCode).toBe(0);
    expect(readEnvelope(result.stdout).results[0]?.ok).toBe(true);
  }, 30_000);

  it('starts the worker from the packed bin entry', async () => {
    const child = await runChild([path.join(dist, 'main.js'), '--schema', 'v2', 'scan', 'wf.json', '--format', 'json']);
    expect(child.stderr).toBe('');
    expect(child.code).toBe(0);
    expect(readEnvelope(child.stdout).results[0]?.ok).toBe(true);
  }, 30_000);
});
