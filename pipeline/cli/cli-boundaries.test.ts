import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './cli-runner.js';

const roots: string[] = [];

function workflow(name: string, parameters: unknown = {}): string {
  return JSON.stringify({
    name,
    nodes: [{ id: 'node', name: 'Node', type: 'n8n-nodes-base.manualTrigger', parameters }],
    connections: {},
  });
}

function riskyWorkflow(name: string): string {
  return JSON.stringify({
    name,
    nodes: [{ id: 'command', name: 'Run command', type: 'n8n-nodes-base.executeCommand', parameters: { command: 'echo test' } }],
    connections: {},
  });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hub-cli-boundaries-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CLI input and output boundaries', () => {
  it('rejects an existing directory as an output target', async () => {
    const root = await tempRoot();
    const input = path.join(root, 'one.json');
    const outputDirectory = path.join(root, 'reports');
    await writeFile(input, workflow('one'), 'utf8');
    await mkdir(outputDirectory);

    const result = await runCli(['scan', input, '--format', 'json', '--output', outputDirectory]);

    expect(result).toMatchObject({
      exitCode: 2,
      stdout: '',
      stderr: 'Output path must be a regular file, not a directory or special path.\n',
    });
  });

  it.each([
    [[], 3],
    [['--fail-on', 'HIGH'], 3],
    [['--fail-on', 'indeterminate'], 1],
  ] as const)('applies the indeterminate failure threshold %j with exit code %i', async (extra, expectedExitCode) => {
    const root = await tempRoot();
    const file = path.join(root, 'indeterminate.json');
    await writeFile(file, workflow('indeterminate', null), 'utf8');

    const result = await runCli(['scan', file, '--format', 'json', ...extra]);

    expect(result.exitCode).toBe(expectedExitCode);
    expect(JSON.parse(result.stdout)).toMatchObject({
      summary: { total: 1 },
      results: [{ ok: true, result: { analysisStatus: 'INDETERMINATE' } }],
    });
  });

  it('preserves a prior output when an input path collides with it case-insensitively on Windows', async () => {
    if (process.platform !== 'win32') return;
    const root = await tempRoot();
    const input = path.join(root, 'workflow.json');
    const alias = path.join(root, 'WORKFLOW.JSON');
    const original = workflow('original');
    await writeFile(input, original, 'utf8');

    const result = await runCli(['scan', input, '--format', 'json', '--output', alias]);

    expect(result).toMatchObject({ exitCode: 2, stdout: '' });
    expect(await readFile(input, 'utf8')).toBe(original);
  });

  it('lets a finding threshold take precedence over an indeterminate result', async () => {
    const root = await tempRoot();
    const indeterminate = path.join(root, 'indeterminate.json');
    const risky = path.join(root, 'risky.json');
    await writeFile(indeterminate, workflow('indeterminate', null), 'utf8');
    await writeFile(risky, riskyWorkflow('risky'), 'utf8');

    const result = await runCli(['scan', indeterminate, risky, '--format', 'json', '--fail-on', 'CRITICAL']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ summary: { total: 2, findings: 1 } });
  });
});
