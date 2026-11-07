import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateCliJsonDocument } from './cli-schema.js';
import { CLI_ABORTED, runCliOperation } from './cli-process.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = path.join(root, 'pipeline', 'cli', 'n8n-scan.ts');

function workflow(name: string): string {
  return JSON.stringify({
    name,
    nodes: [{ id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} }],
    connections: {},
  });
}

function runProcess(args: string[], input?: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    timeout: 45_000,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    windowsHide: true,
  });
}

describe('CLI executable process smoke', () => {
  it('runs help and v2 version in separate Node processes', () => {
    const help = runProcess(['--help']);
    expect(help.error).toBeUndefined();
    expect(help.status).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain('n8n-scan scan <file|directory|-> [options]');

    const version = runProcess(['version']);
    expect(version.error).toBeUndefined();
    expect(version.status).toBe(0);
    expect(version.stderr).toBe('');
    expect(JSON.parse(version.stdout)).toMatchObject({ schemaVersion: 'n8n-scan-version-v2' });
  });

  it('scans stdin and emits a schema-valid JSON document', () => {
    const result = runProcess(['scan', '-', '--format', 'json'], workflow('process-smoke'));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(validateCliJsonDocument(JSON.parse(result.stdout))).toEqual({ ok: true });
  });

  it('keeps malformed stdin machine-readable and returns the input-error exit code', () => {
    const result = runProcess(['scan', '-', '--format', 'json'], '{"nodes":');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(3);
    expect(result.stderr).toBe('');
    const document = JSON.parse(result.stdout);
    expect(validateCliJsonDocument(document)).toEqual({ ok: true });
    expect(document.results[0]).toMatchObject({
      input: '-',
      ok: false,
      error: { kind: 'input', code: 'INVALID_JSON' },
    });
  });
});

describe('CLI operation lifecycle', () => {
  it('settles an open operation on abort and runs cleanup once', async () => {
    const controller = new AbortController();
    let started = 0;
    let cleaned = 0;
    const pending = runCliOperation(
      () => {
        started += 1;
        return new Promise<string>(() => undefined);
      },
      controller.signal,
      () => { cleaned += 1; },
    );

    controller.abort();

    await expect(pending).resolves.toBe(CLI_ABORTED);
    expect(started).toBe(1);
    expect(cleaned).toBe(1);
  });

  it('does not start an operation when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let started = false;

    const result = await runCliOperation(
      () => {
        started = true;
        return Promise.resolve('unexpected');
      },
      controller.signal,
    );

    expect(result).toBe(CLI_ABORTED);
    expect(started).toBe(false);
  });
});
