import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from './cli-runner.js';
import { scanJsonWithIsolation } from './scan-isolation.js';

const workflow = JSON.stringify({
  name: 'isolated CLI fixture',
  nodes: [{ id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} }],
  connections: {},
});

describe('CLI scanner isolation', () => {
  it('returns a typed timeout and can recover after terminating the worker', async () => {
    const timedOut = await scanJsonWithIsolation(workflow, { profile: 'beta-default', approvedDomains: [] }, { timeoutMs: 1 });

    expect(timedOut).toEqual({
      ok: false,
      kind: 'cancelled',
      code: 'TIMEOUT',
      message: 'Scan timed out after 1ms; worker terminated.',
    });

    const recovered = await scanJsonWithIsolation(workflow, { profile: 'beta-default', approvedDomains: [] }, { timeoutMs: 15_000 });
    expect(recovered.ok).toBe(true);
  });

  it('cancels an active worker and can recover without leaving it running', async () => {
    const controller = new AbortController();
    const pending = scanJsonWithIsolation(
      workflow,
      { profile: 'beta-default', approvedDomains: [] },
      { timeoutMs: 15_000, signal: controller.signal },
    );
    controller.abort();

    await expect(pending).resolves.toEqual({
      ok: false,
      kind: 'cancelled',
      code: 'CANCELLED',
      message: 'Scan was cancelled; worker terminated.',
    });

    const recovered = await scanJsonWithIsolation(workflow, { profile: 'beta-default', approvedDomains: [] }, { timeoutMs: 15_000 });
    expect(recovered.ok).toBe(true);
  });

  it('does not replace an existing output when a scan times out', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hub-cli-isolation-'));
    try {
      const input = path.join(root, 'workflow.json');
      const output = path.join(root, 'report.json');
      const original = '{"previous":"report"}\n';
      await writeFile(input, workflow, 'utf8');
      await writeFile(output, original, 'utf8');

      const result = await runCli(
        ['scan', input, '--format', 'json', '--output', output, '--timeout', '1'],
        { cwd: root },
      );

      expect(result).toMatchObject({
        exitCode: 130,
        stdout: '',
        stderr: 'Scan cancelled; output was not replaced.\n',
        document: { results: [{ input: 'workflow.json', ok: false, error: { kind: 'cancelled', code: 'TIMEOUT' } }] },
      });
      expect(await readFile(output, 'utf8')).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a worker exits cleanly before returning a result', async () => {
    class CleanExitWorker {
      private readonly listeners = new Map<string, (value: unknown) => void>();

      once(event: string, listener: (value: unknown) => void): this {
        this.listeners.set(event, listener);
        return this;
      }

      postMessage(): void {
        queueMicrotask(() => this.listeners.get('exit')?.(0));
      }

      terminate(): Promise<number> {
        return Promise.resolve(0);
      }
    }

    vi.doMock('node:worker_threads', () => ({ Worker: CleanExitWorker }));
    vi.resetModules();
    try {
      const isolatedModule = await import('./scan-isolation.js');
      const result = await Promise.race([
        isolatedModule.scanJsonWithIsolation(workflow, { profile: 'beta-default', approvedDomains: [] }),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100)),
      ]);

      expect(result).toEqual({
        ok: false,
        kind: 'internal',
        code: 'INTERNAL',
        message: 'Scanner worker exited before returning a result.',
      });
    } finally {
      vi.doUnmock('node:worker_threads');
      vi.resetModules();
    }
  });
});
