import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCANNER_LIMITS } from '@hub/contracts';
import { parseCliArguments } from './cli-contract.js';
import { runCli } from './cli-runner.js';
import { validateCliJsonDocument } from './cli-schema.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function workflow(name: string): string { return JSON.stringify({ name, nodes: [{ id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} }], connections: {} }); }
function riskyWorkflow(name: string): string { return JSON.stringify({ name, nodes: [{ id: 'command', name: 'Run command', type: 'n8n-nodes-base.executeCommand', parameters: { command: 'echo test' } }], connections: {} }); }
async function tempRoot(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), 'hub-cli-runner-')); roots.push(root); return root; }
describe('CLI runner', () => {
  it('parses help topics and the top-level version alias', () => {
    expect(parseCliArguments(['--help'])).toEqual({ ok: true, command: { kind: 'help', topic: 'general' } });
    expect(parseCliArguments(['scan', '--help'])).toEqual({ ok: true, command: { kind: 'help', topic: 'scan' } });
    expect(parseCliArguments(['--version'])).toEqual({ ok: true, command: { kind: 'version', json: false } });
  });
  it('renders deterministic machine-independent general help with scan guidance', async () => {
    const first = await runCli(['--help']);
    const second = await runCli(['--help']);

    expect(first).toEqual(second);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe('');
    expect(first.stdout).toContain('n8n-scan scan <file|directory|-> [options]');
    expect(first.stdout).toContain('Run "n8n-scan scan --help" for scan options.');
    expect(first.stdout).not.toMatch(/\\|\/[A-Za-z]:/);
  });
  it('renders the scan option reference without touching the filesystem', async () => {
    const result = await runCli(['scan', '--help']);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('--format <table|json|sarif>');
    expect(result.stdout).toContain('--approved-domain <domain>');
    expect(result.stdout).toContain('--max-concurrency <positive-int>');
    expect(result.stdout).toContain('--timeout <positive-int>');
  });
  it('scans one file and emits a valid JSON document', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'one.json');
    await writeFile(file, workflow('one'), 'utf8');

    const result = await runCli(['scan', file, '--format', 'json']);

    expect(result.exitCode).toBe(0);
    const document = JSON.parse(result.stdout) as { results: Array<{ input: string; ok: boolean }> };
    expect(validateCliJsonDocument(document)).toEqual({ ok: true });
    expect(document.results).toHaveLength(1);
    expect(document.results[0]).toMatchObject({ input: file.replaceAll('\\', '/'), ok: true });
  });
  it('recursively discovers JSON files, deduplicates, and sorts independent of concurrency', async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, 'nested'));
    const first = path.join(root, 'nested', 'a.json');
    const second = path.join(root, 'z.json');
    await writeFile(first, workflow('a'), 'utf8');
    await writeFile(second, workflow('z'), 'utf8');

    const serial = await runCli(['scan', second, root, first, '--format', 'json', '--max-concurrency', '1']);
    const concurrent = await runCli(['scan', root, '--format', 'json', '--max-concurrency', '4']);

    expect(serial.exitCode).toBe(0);
    expect(concurrent.exitCode).toBe(0);
    expect(serial.stdout).toBe(concurrent.stdout);
    expect(JSON.parse(serial.stdout).results.map((item: { input: string }) => item.input)).toEqual([
      first.replaceAll('\\', '/'), second.replaceAll('\\', '/'),
    ]);
  });
  it('accepts stdin with a UTF-8 BOM and Unicode content', async () => {
    const input = new TextEncoder().encode(`\uFEFF${workflow('日本語')}`);
    const result = await runCli(['scan', '-', '--format', 'json'], { stdin: input });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).results[0]).toMatchObject({ input: '-', ok: true });
  });
  it('keeps an empty stdin failure as a valid JSON document', async () => {
    const result = await runCli(['scan', '-', '--format', 'json'], { stdin: new Uint8Array() });

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout).results[0]).toMatchObject({
      input: '-', ok: false, error: { kind: 'input', code: 'INVALID_JSON' },
    });
  });
  it('returns a typed cancellation when an open stdin iterator is aborted', async () => {
    const controller = new AbortController();
    const stdin = {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        await new Promise<void>(() => undefined);
      },
    };
    const pending = runCli(['scan', '-', '--format', 'json'], {
      stdin,
      signal: controller.signal,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const result = await pending;

    expect(result.exitCode).toBe(130);
    expect(result.stderr).toBe('');
    expect(result.document).toMatchObject({
      summary: { total: 1, cancelled: 1 },
      results: [{ input: '-', ok: false, error: { kind: 'cancelled', code: 'CANCELLED' } }],
    });
  });
  it('keeps JSON valid and records invalid UTF-8 and oversized inputs', async () => {
    const root = await tempRoot();
    const invalid = path.join(root, 'invalid.json');
    const oversized = path.join(root, 'oversized.json');
    await writeFile(invalid, Buffer.from([0xc3, 0x28]));
    await writeFile(oversized, Buffer.alloc(DEFAULT_SCANNER_LIMITS.maxBytes + 1, 0x20));

    const result = await runCli(['scan', invalid, oversized, '--format', 'json']);
    const document = JSON.parse(result.stdout) as { results: Array<{ ok: boolean; error?: { code: string } }> };

    expect(result.exitCode).toBe(3);
    expect(document.results).toEqual([
      { input: invalid.replaceAll('\\', '/'), ok: false, error: { kind: 'input', code: 'INVALID_UTF8', message: 'Input is not valid UTF-8.' } },
      { input: oversized.replaceAll('\\', '/'), ok: false, error: { kind: 'input', code: 'WORKFLOW_TOO_LARGE', message: 'Input exceeds the scanner payload limit.' } },
    ]);
  });
  it('writes JSON atomically and refuses an output path that is an input', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'one.json');
    const output = path.join(root, 'report.json');
    await writeFile(file, workflow('one'), 'utf8');

    const written = await runCli(['scan', file, '--format', 'json', '--output', output]);
    expect(written.exitCode).toBe(0);
    expect(written.stdout).toBe('');
    expect(JSON.parse(await readFile(output, 'utf8')).results).toHaveLength(1);

    const before = await readFile(file, 'utf8');
    const collision = await runCli(['scan', file, '--format', 'json', '--output', file]);
    expect(collision).toMatchObject({ exitCode: 2, stdout: '' });
    expect(await readFile(file, 'utf8')).toBe(before);
  });
  it('emits deterministic table and SARIF output', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'one.json');
    await writeFile(file, workflow('one'), 'utf8');

    const table = await runCli(['scan', file, '--format=table']);
    expect(table.exitCode).toBe(0);
    expect(table.stdout).toContain('Input');
    expect(table.stdout).toContain('one.json');

    const sarif = await runCli(['scan', file, '--format=sarif']);
    expect(sarif.exitCode).toBe(0);
    expect(JSON.parse(sarif.stdout)).toMatchObject({ version: '2.1.0', runs: [{ tool: { driver: { name: 'n8n-scan' } } }] });
  });
  it.each(['json', 'sarif'] as const)('keeps %s output parseable for malformed and missing inputs', async (format) => {
    const root = await tempRoot();
    const malformed = path.join(root, 'malformed.json');
    const missing = path.join(root, 'missing.json');
    await writeFile(malformed, '{"nodes":', 'utf8');
    const result = await runCli(['scan', malformed, missing, '--format', format]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('');
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    if (format === 'json') {
      expect(document).toMatchObject({ schemaVersion: 'scanner-cli-v1', summary: { inputErrors: 2 } });
      expect(document.results).toEqual([
        { input: malformed.replaceAll('\\', '/'), ok: false, error: { kind: 'input', code: 'INVALID_JSON', message: 'Workflow JSON is not valid JSON.' } },
        { input: missing.replaceAll('\\', '/'), ok: false, error: { kind: 'input', code: 'FILE_READ_FAILED', message: 'Unable to read input path.' } },
      ]);
    } else {
      expect(document).toMatchObject({ version: '2.1.0', runs: [{ invocations: [{ toolExecutionNotifications: [
        { message: { text: expect.stringContaining('Workflow JSON is not valid JSON.') } }, { message: { text: expect.stringContaining('Unable to read input path.') } },
      ] }] }] });
    }
  });
  it('prioritizes input errors over a matching fail-on finding exit', async () => {
    const root = await tempRoot();
    const risky = path.join(root, 'risky.json');
    const missing = path.join(root, 'missing.json');
    await writeFile(risky, riskyWorkflow('risky'), 'utf8');
    const result = await runCli(['scan', risky, missing, '--format', 'json', '--fail-on', 'HIGH']);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ summary: { inputErrors: 1, findings: 1 } });
  });
  it.each(['json', 'sarif', 'table'] as const)('emits byte-identical %s output across repeated runs', async (format) => {
    const root = await tempRoot();
    const file = path.join(root, 'stable.json');
    await writeFile(file, workflow('stable'), 'utf8');
    const first = await runCli(['scan', file, '--format', format]);
    const second = await runCli(['scan', file, '--format', format]);
    expect(second).toEqual(first);
  });
  it('does not invoke the network while scanning a workflow', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'offline.json');
    await writeFile(file, workflow('offline'), 'utf8');
    const fetch = vi.fn(() => { throw new Error('network access is prohibited'); });
    vi.stubGlobal('fetch', fetch);
    try {
      const result = await runCli(['scan', file, '--format', 'json']);
      expect(result.exitCode).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('serves rules, explanations, and machine-readable version metadata', async () => {
    const rules = await runCli(['rules']);
    expect(rules.exitCode).toBe(0);
    expect(rules.stdout).toContain('N8N_EXECUTE_COMMAND');
    const explanation = await runCli(['explain', 'N8N_EXECUTE_COMMAND']);
    expect(explanation.exitCode).toBe(0);
    expect(explanation.stdout).toContain('Execute Command node');
    const version = await runCli(['version', '--json']);
    expect(version.exitCode).toBe(0);
    expect(JSON.parse(version.stdout)).toMatchObject({ schemaVersion: 'scanner-cli-v1', scannerVersion: 'scanner-beta-1' });
    const alias = await runCli(['--version']);
    const command = await runCli(['version']);
    expect(alias).toEqual(command);
    expect(alias.stdout).toBe('n8n-scan 0.1.0\n');
  });
});
