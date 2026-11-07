import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import { runCliV2 } from './cli-runner';
import { parseArgumentsV2 } from './arguments';
import * as workerHost from './scan-worker-host';

describe('Q08 public runner and worker request boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['unverified', 'empty', 'two versions'] as const)('keeps %s inventory explicit through the public entry', async (scope) => {
    const directory = await mkdtemp(join(tmpdir(), 'q08-public-'));
    try {
      const network = vi.spyOn(globalThis, 'fetch');
      // Exercise current core source after structured cloning the exact worker payload. The package
      // build is a separate release check; this focused test cannot read stale dist as source proof.
      const worker = vi.spyOn(workerHost, 'runScanInWorker').mockImplementation(async (payload) => ({
        status: 'COMPLETED', value: scanWorkflowV2(structuredClone(payload)),
      }) as Awaited<ReturnType<typeof workerHost.runScanInWorker>>);
      const args = ['--schema', 'v2', 'scan', '-', '--audit-supply-chain'];
      if (scope !== 'unverified') {
        await writeFile(join(directory, 'target.json'), JSON.stringify({ schemaVersion: 'scanner-target-v3',
          communityPackages: scope === 'empty' ? [] : [{ name: 'pkg', version: '1.2.3' }, { name: 'pkg', version: '2.0.0' }],
        }));
        args.push('--target', 'target.json');
      }
      const command = parseArgumentsV2(args);
      expect(command.ok).toBe(true); if (!command.ok || command.command.kind !== 'scan') return;
      const run = await runCliV2(command.command, { cwd: directory, stdin: '{"nodes":[],"connections":{}}' });
      expect(run.exitCode).toBe(0);
      const output = JSON.parse(run.stdout);
      const state = scope === 'unverified' ? 'REFUSED' : scope === 'empty' ? 'NO_DECLARED_PACKAGES' : 'UNAVAILABLE';
      expect(output.supplyChain).toMatchObject({ schemaVersion: 'supply-chain-request-v2', inventoryState: scope === 'unverified' ? 'UNVERIFIED' : 'DECLARED', evaluation: { status: state } });
      const result = output.results[0].result;
      expect(result.facts.find((fact: { kind: string }) => fact.kind === 'advisory.evaluation.v1').properties)
        .toMatchObject({ evaluationState: state, packagesRequested: scope === 'two versions' ? 2 : 0 });
      expect(result.facts.filter((fact: { kind: string }) => fact.kind === 'advisory.package-coverage.v1')).toHaveLength(scope === 'two versions' ? 2 : 0);
      expect(worker).toHaveBeenCalledTimes(1);
      expect(network).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
