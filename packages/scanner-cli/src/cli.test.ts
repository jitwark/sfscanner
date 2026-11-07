import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './cli';
import type { ScanDocument } from './scan';
import { toSarifDocument } from './sarif';

const SAFE_WORKFLOW = JSON.stringify({
  name: 'CLI fixture',
  nodes: [{
    id: 'start',
    name: 'Start',
    type: 'n8n-nodes-base.manualTrigger',
    parameters: {},
  }],
  connections: {},
});

const RISKY_WORKFLOW = JSON.stringify({
  name: 'Risky fixture',
  nodes: [{
    id: 'command',
    name: 'Run command',
    type: 'n8n-nodes-base.executeCommand',
    parameters: { command: 'echo fixture' },
  }],
  connections: {},
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('sfscanner CLI', () => {
  it('renders help without loading an input', async () => {
    const result = await runCli(['--help']);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('sfscanner <file|->');
    expect(result.stdout).toContain('--version --json');
  });

  it('renders a stable machine-readable version document', async () => {
    const result = await runCli(['--version', '--json']);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 'n8n-scan-v1',
      cliVersion: '0.1.0',
      scannerVersion: 'scanner-beta-1',
      profile: 'beta-default',
      mode: 'offline',
    });
  });

  it('scans one workflow file with deterministic JSON output', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'n8n-scan-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'workflow.json');
    await writeFile(file, SAFE_WORKFLOW, 'utf8');

    const first = await runCli([file]);
    const second = await runCli([file]);

    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe('');
    expect(first.stdout).toBe(second.stdout);
    expect(JSON.parse(first.stdout)).toMatchObject({
      schemaVersion: 'n8n-scan-v1',
      ok: true,
      scannerVersion: 'scanner-beta-1',
      profile: 'beta-default',
      workflow: { name: 'CLI fixture', nodeCount: 1 },
      analysis: { status: 'COMPLETE', diagnostics: [] },
      summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      findings: [],
    });
  });

  it('scans stdin and returns findings with a non-zero findings exit code', async () => {
    const result = await runCli(['-'], { stdin: RISKY_WORKFLOW });
    const document = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(document).toMatchObject({ ok: true, input: '-', profile: 'beta-default' });
    expect(document.findings).toEqual([
      expect.objectContaining({ policyId: 'N8N_EXECUTE_COMMAND', severity: 'CRITICAL' }),
    ]);
  });

  it('returns a typed JSON input error for malformed workflow input', async () => {
    const result = await runCli(['-'], { stdin: '{"nodes":' });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 'n8n-scan-v1',
      scannerVersion: 'scanner-beta-1',
      profile: 'beta-default',
      input: '-',
      ok: false,
      error: { code: 'INVALID_JSON', message: 'Workflow JSON is not valid JSON.' },
    });
  });

  it('returns a distinct JSON input error when a file cannot be read', async () => {
    const result = await runCli(['missing-workflow.json']);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 'n8n-scan-v1',
      input: 'missing-workflow.json',
      ok: false,
      error: { code: 'INPUT_READ_FAILED', message: 'Unable to read workflow input.' },
    });
  });

  it('rejects ambiguous command-line input instead of guessing', async () => {
    const result = await runCli(['one.json', 'two.json']);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Exactly one workflow input is required.');
  });

  it('emits SARIF 2.1.0 with a CWE tag for a risky workflow', async () => {
    const result = await runCli(['-', '--format', 'sarif'], { stdin: RISKY_WORKFLOW });
    const sarif = JSON.parse(result.stdout) as {
      version: string;
      $schema: string;
      runs: Array<{
        tool: { driver: { name: string; rules: Array<{ id: string; properties?: { tags?: string[] } }> } };
        results: Array<{ ruleId: string }>;
        invocations: Array<{ executionSuccessful: boolean }>;
      }>;
    };

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(sarif).toMatchObject({ version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json' });
    const run = sarif.runs[0]!;
    expect(run.results.map((item) => item.ruleId)).toEqual(['N8N_EXECUTE_COMMAND']);
    expect(run.tool.driver.rules[0]!.properties?.tags).toContain('external/cwe/cwe-078');
    expect(run.invocations[0]!.executionSuccessful).toBe(true);
  });

  it('emits an empty-rules SARIF document for a clean workflow, accepting --format after the input', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'n8n-scan-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'workflow.json');
    await writeFile(file, SAFE_WORKFLOW, 'utf8');

    const result = await runCli(['scan', file, '--format', 'sarif']);
    const sarif = JSON.parse(result.stdout) as { runs: Array<{ results: unknown[]; tool: { driver: { rules: unknown[] } } }> };

    expect(result.exitCode).toBe(0);
    expect(sarif.runs[0]!.results).toEqual([]);
    expect(sarif.runs[0]!.tool.driver.rules).toEqual([]);
  });

  it('is byte-identical across repeated SARIF runs', async () => {
    const first = await runCli(['-', '--format', 'sarif'], { stdin: RISKY_WORKFLOW });
    const second = await runCli(['-', '--format', 'sarif'], { stdin: RISKY_WORKFLOW });

    expect(first.stdout).toBe(second.stdout);
  });

  it('reports an unreadable input as a SARIF notification when SARIF was requested', async () => {
    const result = await runCli(['missing-workflow.json', '--format', 'sarif']);
    const sarif = JSON.parse(result.stdout) as {
      runs: Array<{ invocations: Array<{ executionSuccessful: boolean; toolExecutionNotifications: Array<{ descriptor: { id: string }; message: { text: string } }> }> }>;
    };

    expect(result.exitCode).toBe(3);
    const invocation = sarif.runs[0]!.invocations[0]!;
    expect(invocation.executionSuccessful).toBe(false);
    expect(invocation.toolExecutionNotifications).toEqual([
      { descriptor: { id: 'INPUT_READ_FAILED' }, message: { text: 'missing-workflow.json: Unable to read workflow input.' }, properties: { input: 'missing-workflow.json', code: 'INPUT_READ_FAILED' } },
    ]);
  });

  it('rejects an unknown --format value as a usage error', async () => {
    const result = await runCli(['-', '--format', 'xml'], { stdin: SAFE_WORKFLOW });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--format must be one of: json, sarif');
  });

  it('emits a physical location for a v1 finding when the node has a source span', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'n8n-scan-span-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'risky.json');
    await writeFile(file, RISKY_WORKFLOW, 'utf8');
    const result = await runCli(['scan', file, '--format', 'sarif']);
    const sarif = JSON.parse(result.stdout) as { runs: Array<{ results: Array<{ locations?: Array<{ physicalLocation: { region: { startLine: number } } }> }> }> };
    expect(result.exitCode).toBe(1);
    expect(sarif.runs[0]!.results[0]!.locations?.[0]!.physicalLocation.region.startLine).toBeGreaterThan(0);
  });

  it('marks a completed INDETERMINATE v1 document successful', () => {
    const document = { ok: true, input: '-', analysis: { status: 'INDETERMINATE' }, findings: [] } as unknown as ScanDocument;
    const sarif = toSarifDocument(document) as { runs: Array<{ invocations: Array<{ executionSuccessful: boolean }> }> };
    expect(sarif.runs[0]!.invocations[0]!.executionSuccessful).toBe(true);
  });
});
