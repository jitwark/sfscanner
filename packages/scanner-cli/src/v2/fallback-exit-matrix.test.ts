import { notRequestedAdvisoryFixture } from '../../../../contracts/scanner-v2-advisory-fixture.test-helper';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScannerResultV2 } from '@hub/contracts/scanner-v2-result';
import { parseArgumentsV2 } from './arguments';
import type { BatchResultV2 } from './batch-runner';
import { runCliV2 } from './cli-runner';
import { reduceExitV2 } from './exit-reducer';

const digest = (letter: string): string => letter.repeat(64);

/** Reducer unit only: this is not the CLI surface-parity proof (see the real-runner cases below). */
const degradedResult: ScannerResultV2 = {
  schemaVersion: 'scanner-result-v2',
  engine: { id: 'secureflow-scanner', version: '2.0.0', buildDigest: digest('a') },
  input: { rawSha256: digest('b'), semanticSha256: digest('c'), ambiguitySha256: digest('d'), ambiguityCount: 0, utf8Bytes: 1 },
  profile: { id: 'beta-default', version: '2.0.0' },
  ruleset: { id: 'builtin', version: '2.0.0', digest: digest('e'), signatureStatus: 'VERIFIED' },
  semantics: { id: 'scanner-core-builtins', version: '2.1.0', digest: digest('f') },
  target: { schemaVersion: 'scanner-target-v3', edition: 'UNKNOWN', deployment: 'UNKNOWN', role: 'UNKNOWN', taskRunner: 'UNKNOWN', communityPackages: [], configuration: [], contextDigest: digest('0') },
  limits: { schemaVersion: 'scanner-limits-v2', digest: digest('1'), usage: [] },
  analysis: { status: 'DEGRADED', capabilities: [], diagnostics: [] },
  workflow: { name: null, nodeCount: 0, rawNodeCount: 0, annotationNodeCount: 0, triggerCount: 0, actionCount: 0, integrationCount: 0, edgeCount: 0, resolvedEdgeCount: 0, payloadBytes: 0, complexity: 'LOW', isSubWorkflow: false },
  facts: [notRequestedAdvisoryFixture()], traces: [], findings: [],
  assessment: { score: 0, grade: 'LOW', scoringPolicyVersion: 'secureflow-risk-v2@2.0.0', basisFindingIds: [], excludedReportOnlyFindingIds: [], excludedUncertainFindingIds: [], excludedNotApplicableFindingIds: [], unknownEvidenceCount: 0 },
  stats: { rejectedCandidates: 0, collapsedCandidates: 0, omittedFindings: 0, serializedBytes: 0 },
};

const degradedBatch: BatchResultV2 = {
  ok: true,
  items: [{ label: 'unknown.json', status: 'COMPLETED', result: { ok: true, result: degradedResult } }],
  cancelled: false, completed: 1, failed: 0, concurrency: 1,
};

describe('SEC-05 fallback exit contract (reducer unit)', () => {
  it('keeps the default exit at 0 for a completed DEGRADED scan', () => {
    expect(reduceExitV2(degradedBatch)).toEqual({ reason: 'UNDER_THRESHOLD', code: 0 });
  });

  it('still fails a DEGRADED scan under --require-complete', () => {
    expect(reduceExitV2(degradedBatch, { requireComplete: true }))
      .toEqual({ reason: 'REQUIRE_COMPLETE', code: 1 });
  });
});

// No secret, URL, or other policy finding: the only non-clean reason is the fallback coverage, so
// exit 0 is not a policy-threshold accident and require-complete isolates incompleteness.
const fallbackWorkflow = JSON.stringify({
  nodes: [
    { id: 'Start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
    { id: 'Unknown', name: 'Unknown', type: 'n8n-nodes-base.discord', typeVersion: 1, parameters: {} },
  ],
  connections: { Start: { main: [[{ node: 'Unknown', type: 'main', index: 0 }]] } },
});

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'fallback-cli-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function scanCommand(...extra: string[]) {
  const parsed = parseArgumentsV2(['--schema', 'v2', 'scan', 'unknown.json', '--format', 'json', ...extra]);
  if (!parsed.ok || parsed.command.kind !== 'scan') throw new Error('Expected a parsed scan command.');
  return parsed.command;
}

async function runFallback(directory: string, document = fallbackWorkflow, extra: string[] = []) {
  await writeFile(join(directory, 'unknown.json'), document);
  return runCliV2(scanCommand(...extra), { cwd: directory });
}

type Envelope = {
  exitReason: string;
  results: Array<{
    result: {
      engine: { version: string };
      profile: { id: string; version: string };
      analysis: { status: string; diagnostics: Array<{ code: string; location?: { pointer?: string } }> };
      assessment: { grade?: string } | null;
      findings: Array<{ ruleId: string }>;
    };
  }>;
};

const codesAt = (envelope: Envelope, pointer: string) =>
  envelope.results[0]!.result.analysis.diagnostics
    .filter(({ location }) => location?.pointer === pointer)
    .map(({ code }) => code);

describe('fallback surface parity: public CLI runner, same candidate', () => {
  it('carries both codes, DEGRADED, and a grade at the default exit', async () => {
    await withTempDirectory(async (directory) => {
      const result = await runFallback(directory);
      const envelope = JSON.parse(result.stdout) as Envelope;

      expect(result.exitCode).toBe(0);
      expect(envelope.exitReason).toBe('UNDER_THRESHOLD');
      expect(envelope.results[0]!.result.engine.version).toBe('2.0.0');
      expect(envelope.results[0]!.result.profile).toMatchObject({ id: 'beta-default', version: '2.0.0' });
      expect(envelope.results[0]!.result.analysis.status).toBe('DEGRADED');
      expect(codesAt(envelope, '/nodes/1')).toEqual([
        'SEMANTIC_CATALOGUE_MISS',
        'GENERIC_NODE_UNMODELED_CAPABILITY',
      ]);
      expect(envelope.results[0]!.result.assessment?.grade).toBeTruthy();
    });
  }, 20_000);

  it('changes only the exit under --require-complete on an innocuous unknown', async () => {
    await withTempDirectory(async (directory) => {
      const result = await runFallback(directory, fallbackWorkflow, ['--require-complete', '--fail-on', 'CRITICAL']);
      const envelope = JSON.parse(result.stdout) as Envelope;

      expect(result.exitCode).toBe(1);
      expect(envelope.exitReason).toBe('REQUIRE_COMPLETE');
      expect(envelope.results[0]!.result.analysis.status).toBe('DEGRADED');
      expect(codesAt(envelope, '/nodes/1')).toEqual([
        'SEMANTIC_CATALOGUE_MISS',
        'GENERIC_NODE_UNMODELED_CAPABILITY',
      ]);
      expect(envelope.results[0]!.result.assessment?.grade).toBeTruthy();
    });
  }, 20_000);

  it('retains the secret finding while keeping the raw secret out of CLI output', async () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const secretWorkflow = JSON.stringify({
      nodes: [
        { id: 'Start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
        { id: 'Unknown', name: 'Unknown', type: 'n8n-nodes-base.discord', typeVersion: 1, parameters: { url: 'https://example.invalid/x', awsSecretAccessKey: secret } },
      ],
      connections: { Start: { main: [[{ node: 'Unknown', type: 'main', index: 0 }]] } },
    });
    await withTempDirectory(async (directory) => {
      const result = await runFallback(directory, secretWorkflow);
      const envelope = JSON.parse(result.stdout) as Envelope;

      expect(result.exitCode).toBe(1);
      expect(envelope.results[0]!.result.analysis.status).toBe('DEGRADED');
      expect(envelope.results[0]!.result.findings.map(({ ruleId }) => ruleId)).toContain('RAW_SECRET_INDICATOR');
      expect(result.stdout).not.toContain(secret);
    });
  }, 20_000);

  it('leaves a genuinely unresolved node INDETERMINATE with no assessment', async () => {
    const unreadableWorkflow = JSON.stringify({
      nodes: [
        { id: 'Start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
        { id: 'Broken', name: 'Broken', type: 'n8n-nodes-base.discord', typeVersion: 1, parameters: 'not-an-object' },
      ],
      connections: { Start: { main: [[{ node: 'Broken', type: 'main', index: 0 }]] } },
    });
    await withTempDirectory(async (directory) => {
      const result = await runFallback(directory, unreadableWorkflow);
      const envelope = JSON.parse(result.stdout) as Envelope;

      expect(result.exitCode).toBe(3);
      expect(envelope.results[0]!.result.analysis.status).toBe('INDETERMINATE');
      expect(envelope.results[0]!.result.assessment).toBeNull();
      expect(envelope.results[0]!.result.analysis.diagnostics.map(({ code }) => code).sort())
        .toEqual(['MALFORMED_NODE_PARAMETERS', 'SEMANTIC_CATALOGUE_MISS']);
    });
  }, 20_000);
});
