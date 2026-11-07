import { readFile } from 'node:fs/promises';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { ADMITTED_CONFIGURATION_KEYS_V2, scanWorkflowV2, validateTargetContextV3, type ScanWorkflowV2Result, type TargetContextV3 } from '@hub/scanner-core/v2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgumentsV2, type CliCommandV2 } from './arguments';
import { runCliV2Internal, type V2CliRunOptions } from './cli-runner-internal';
import type { SnapshotTransportV1 } from './supply-chain-fetch';
import type { SnapshotPinV1 } from './supply-chain-snapshot';

type ScanCommand = Extract<CliCommandV2, { kind: 'scan' }>;
type Fact = { kind: string; properties: Record<string, unknown> };
type Envelope = {
  artifacts: { target: TargetContextV3 };
  supplyChain?: { status: string; inventoryState: string; inventoryDigest: string; evaluation: { status: string; reason: string }; packages: readonly unknown[] };
  results: Array<{ result?: { target: TargetContextV3; facts?: Fact[] } }>;
};

const DEFAULT_TARGET = validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: [], configuration: [] }, { allowedConfigurationKeys: ADMITTED_CONFIGURATION_KEYS_V2 });
const READY_TARGET = validateTargetContextV3({ schemaVersion: 'scanner-target-v3', edition: 'COMMUNITY', communityPackages: [{ name: 'pkg', version: '1.2.3' }], configuration: [] }, { allowedConfigurationKeys: ADMITTED_CONFIGURATION_KEYS_V2 });
const READY_ARGS = ['--audit-supply-chain', '--edition', 'COMMUNITY', '--community-package', 'pkg@1.2.3'];
const packageRoot = process.cwd().replaceAll('\\', '/').endsWith('/packages/scanner-cli');
const cleanInput = `${packageRoot ? 'src/v2/__fixtures__' : 'packages/scanner-cli/src/v2/__fixtures__'}/clean-workflow.json`;

function scanCommand(...args: string[]): ScanCommand {
  const parsed = parseArgumentsV2(['--schema', 'v2', 'scan', cleanInput, ...args]);
  if (!parsed.ok || parsed.command.kind !== 'scan') throw new Error('Expected scan command');
  return parsed.command;
}
function run(args: readonly string[], options: V2CliRunOptions = {}) { return runCliV2Internal(scanCommand(...args), { cwd: '.', ...options }); }
function envelope(stdout: string): Envelope { return JSON.parse(stdout) as Envelope; }
const fixtureBytes = async (): Promise<Uint8Array> => new TextEncoder().encode(await readFile(cleanInput, 'utf8'));
function scanTargeted(bytes: Uint8Array, _item?: unknown, options?: { target?: unknown; limits?: typeof DEFAULT_SCANNER_LIMITS_V2; advisoryRequest?: unknown }): ScanWorkflowV2Result {
  return scanWorkflowV2({
    bytes, profile: { id: 'beta-default', version: '2.0.0' },
    limits: options?.limits ?? DEFAULT_SCANNER_LIMITS_V2,
    target: (options?.target as TargetContextV3 | undefined) ?? READY_TARGET,
    ...(options?.advisoryRequest === undefined ? {} : { advisoryRequest: options.advisoryRequest }),
  });
}

describe('canonical supply-chain request and result through the v2 CLI', () => {
  afterEach(() => vi.restoreAllMocks());

  it('leaves opt-out scans network-free with no request metadata', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const result = await run(['--format', 'json'], { read: fixtureBytes, scan: scanTargeted });
    expect(result.exitCode).toBe(0);
    const output = envelope(result.stdout);
    expect(output.supplyChain).toBeUndefined();
    expect(output.artifacts.target.schemaVersion).toBe('scanner-target-v3');
    expect(spy).not.toHaveBeenCalled();
  });

  it('emits request-v2 and canonical requested UNAVAILABLE facts without a receipt', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const result = await run([...READY_ARGS, '--format', 'json'], { read: fixtureBytes, scan: scanTargeted });
    expect(result.exitCode).toBe(0);
    const output = envelope(result.stdout);
    expect(output.supplyChain).toEqual({
      schemaVersion: 'supply-chain-request-v2', status: 'READY', inventoryDigest: READY_TARGET.contextDigest,
      inventoryState: 'DECLARED', evaluation: { status: 'UNAVAILABLE', reason: 'NO_ADMITTED_SNAPSHOT' },
      packages: [{ state: 'KNOWN', name: 'pkg', version: '1.2.3', inventoryDigest: READY_TARGET.contextDigest }],
    });
    const facts = output.results[0]?.result?.facts ?? [];
    expect(facts.find((fact) => fact.kind === 'advisory.evaluation.v1')?.properties).toMatchObject({
      evaluationState: 'UNAVAILABLE', evaluationReason: 'NO_ADMITTED_SNAPSHOT',
      targetDigest: READY_TARGET.contextDigest, packagesRequested: 1,
    });
    expect(facts.filter((fact) => fact.kind === 'advisory.package-coverage.v1')).toHaveLength(1);
    expect(facts.some((fact) => fact.kind === 'advisory.applicability.v3')).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('places request-v2 only on the NDJSON header', async () => {
    const result = await run([...READY_ARGS, '--format', 'ndjson'], { read: fixtureBytes, scan: scanTargeted });
    const rows = result.stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows[0]).toMatchObject({ type: 'header', supplyChain: { schemaVersion: 'supply-chain-request-v2', inventoryState: 'DECLARED' } });
    for (const row of rows.slice(1)) expect(row).not.toHaveProperty('supplyChain');
  });

  it('does not promote validated caller transport bytes into production authority', async () => {
    const raw = new TextEncoder().encode(JSON.stringify({ schemaVersion: 'scanner-advisories-v2', version: '1.0.0', records: [], sourceId: 'fixture-source', capturedAt: '2026-11-03T00:00:00.000Z' }));
    const pin: SnapshotPinV1 = { sourceId: 'fixture-source', url: 'https://example.test/snapshot.json', sha256: bytesToHex(sha256(raw)), schemaVersion: 'scanner-advisories-v2', capturedAt: '2026-11-03T00:00:00.000Z', maxAgeMs: 60_000 };
    let calls = 0;
    const transport: SnapshotTransportV1 = async () => { calls += 1; return { status: 200, bytes: raw }; };
    const result = await run([...READY_ARGS, '--format', 'json'], { read: fixtureBytes, scan: scanTargeted, transport, snapshotPin: pin, now: () => Date.parse('2026-11-03T00:00:01.000Z') });
    expect(calls).toBe(0);
    const output = envelope(result.stdout);
    expect(output.supplyChain?.evaluation).toEqual({ status: 'UNAVAILABLE', reason: 'NO_ADMITTED_SNAPSHOT' });
    const facts = output.results[0]?.result?.facts ?? [];
    expect(facts.find((fact) => fact.kind === 'advisory.evaluation.v1')?.properties.evaluationReason).toBe('NO_ADMITTED_SNAPSHOT');
    expect(facts.some((fact) => fact.kind === 'advisory.applicability.v3')).toBe(false);
  });
});
