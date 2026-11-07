import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJsonBytes } from '@hub/scanner-core/canonical-json';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import { V2_ADAPTER_FIXTURE_MATRIX, V2_ADAPTER_PROFILE } from '@hub/scanner-core/test/v2-adapter-fixtures';
import { runPipelineCli } from './package-wrapper.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function workflow(name: string, risky = false): string {
  return JSON.stringify({
    name,
    nodes: risky
      ? [{ id: 'command', name: 'Run command', type: 'n8n-nodes-base.executeCommand', parameters: { command: 'echo test' } }]
      : [{ id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} }],
    connections: {},
  });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hub-package-wrapper-'));
  roots.push(root);
  return root;
}

describe('pipeline package wrapper', () => {
  it('keeps the v1 default route and stdin result shape', async () => {
    const result = await runPipelineCli(['scan', '-', '--format', 'json'], { stdin: workflow('v1-default') });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 'scanner-cli-v1' });
  });

  it('preserves v1 table bytes when concurrency changes', async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'a.json'), workflow('a'), 'utf8');
    await writeFile(path.join(root, 'nested', 'b.json'), workflow('b'), 'utf8');
    const serial = await runPipelineCli(['scan', '.', '--format', 'table', '--max-concurrency', '1'], { cwd: root });
    const concurrent = await runPipelineCli(['scan', '.', '--format', 'table', '--max-concurrency', '4'], { cwd: root });
    expect(serial).toEqual(concurrent);
  });

  it('preserves v1 fail-on and input-error precedence', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'risky.json'), workflow('risky', true), 'utf8');
    const result = await runPipelineCli(['scan', 'risky.json', 'missing.json', '--format', 'json', '--fail-on', 'HIGH'], { cwd: root });
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 'scanner-cli-v1', summary: { inputErrors: 1, findings: 1 } });
  });
  it('forwards v1 cancellation without changing its envelope', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runPipelineCli(['scan', '-', '--format', 'json'], {
      signal: controller.signal,
      stdin: workflow('cancelled'),
    });
    expect(result.exitCode).toBe(130);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 'scanner-cli-v1',
      summary: { cancelled: 1 },
    });
  });


  it.each(['json', 'ndjson', 'sarif', 'table'] as const)('dispatches explicit v2 %s output to the package runner', async (format) => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'clean.json'), workflow('v2-clean'), 'utf8');
    const result = await runPipelineCli(['--schema', 'v2', 'scan', 'clean.json', '--format', format], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    if (format === 'json') expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 'n8n-scan-v2' });
    if (format === 'ndjson') expect(result.stdout).toContain('n8n-scan-v2-ndjson');
    if (format === 'sarif') expect(JSON.parse(result.stdout)).toMatchObject({ version: '2.1.0' });
    if (format === 'table') expect(result.stdout).toContain('Input');
  });
  it('captures the raw package result from the public envelope', async () => {
    const parityFixture = V2_ADAPTER_FIXTURE_MATRIX.find(({ id }) => id === 'safe-workflow')!;
    const sourceBytes = new TextEncoder().encode(parityFixture.json);
    const expected = scanWorkflowV2({ bytes: sourceBytes, profile: V2_ADAPTER_PROFILE });
    const result = await runPipelineCli(['--schema', 'v2', 'scan', '-', '--format', 'json'], { stdin: sourceBytes });
    expect(result.exitCode).toBe(0);
    const envelope: unknown = JSON.parse(result.stdout);
    if (envelope === null || typeof envelope !== 'object' || !('results' in envelope) || !Array.isArray(envelope.results)) throw new Error('missing results');
    const first: unknown = envelope.results[0];
    if (first === null || typeof first !== 'object' || !('ok' in first) || first.ok !== true || !('result' in first)) throw new Error('missing raw result');
    expect(expected.ok).toBe(true);
    if (expected.ok) expect(canonicalJsonBytes(first.result)).toEqual(canonicalJsonBytes(expected.result));
  });

  it('routes v2 metadata and deterministic help without falling back to v1', async () => {
    const help = await runPipelineCli(['--schema', 'v2', '--help']);
    expect(help).toMatchObject({ exitCode: 0, stderr: '' });
    expect(help.stdout).toContain('sfscanner — deterministic offline n8n workflow scanner (v2)');
    const scanHelp = await runPipelineCli(['--schema', 'v2', 'scan', '--help']);
    expect(scanHelp.stdout).toContain('sfscanner v2 scan');
    const rules = await runPipelineCli(['rules']);
    expect(rules.exitCode).toBe(0);
    expect(JSON.parse(rules.stdout)).toMatchObject({ schemaVersion: 'n8n-scan-rules-v2' });
    const explanation = await runPipelineCli(['explain', 'N8N_EXECUTE_COMMAND']);
    expect(explanation.exitCode).toBe(0);
    expect(JSON.parse(explanation.stdout)).toMatchObject({ schemaVersion: 'n8n-scan-explain-v2' });
    const profiles = await runPipelineCli(['profiles']);
    expect(JSON.parse(profiles.stdout)).toMatchObject({ schemaVersion: 'n8n-scan-profiles-v2' });
    const version = await runPipelineCli(['version']);
    expect(JSON.parse(version.stdout)).toMatchObject({ schemaVersion: 'n8n-scan-version-v2' });
    const rulesTable = await runPipelineCli(['rules', '--format', 'table']);
    expect(rulesTable.exitCode).toBe(0);
    expect(rulesTable.stdout).toContain('Rule ID');
    const invalidConfig = await runPipelineCli(['validate-config', 'missing-config.json']);
    expect(invalidConfig.exitCode).toBe(2);
    expect(invalidConfig.stderr).toBe('Configuration could not be read.\n');
  });

  it('keeps v2 cancellation typed and does not downgrade to v1', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runPipelineCli(['--schema', 'v2', 'scan', '-'], { signal: controller.signal });
    expect(result.exitCode).toBe(130);
    expect(result.stdout).toContain('n8n-scan-v2');
    expect(result.stdout).not.toContain('scanner-cli-v1');
  });

  it('keeps v2 failures closed and sanitized', async () => {
    const result = await runPipelineCli(['--schema', 'v2', 'scan', '/absolute/secret-workflow.json']);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('absolute');
    expect(result.stderr).not.toContain('secret-workflow');
  });

  it('does not invoke the network on the v2 route', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'offline.json'), workflow('offline'), 'utf8');
    const fetch = vi.fn(() => { throw new Error('network access is prohibited'); });
    vi.stubGlobal('fetch', fetch);
    try {
      const result = await runPipelineCli(['--schema', 'v2', 'scan', 'offline.json'], { cwd: root });
      expect(result.exitCode).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
