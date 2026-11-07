import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Candidate, EntrySecurity } from '@hub/contracts';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import { runScanStage } from './scan-stage';
import {
  ADMITTED_V2_SCAN_IDENTITY,
  ENTRY_SECURITY_PROJECTION_VERSION,
  type V2RescanRecord,
} from '../scan/v2-corpus-adapter';
import { readV2RescanManifest } from '../scan/v2-rescan-manifest';
import {
  buildScannerSourceReceipt,
  computeSourceBuildDigest,
  type V2SourceReceipt,
} from '../scan/v2-source-receipt';

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

const sampleWorkflowJson = {
  nodes: [{ id: 'n1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [100, 200], parameters: {} }],
  connections: {},
};

function createCandidate(id = 'wf-1', status: 'link_only' | 'redistributable' = 'link_only'): Candidate & Record<string, any> {
  return {
    id, name: 'Test Workflow', description: 'Test', source: 'community', sourceUrl: 'https://example.com/test',
    author: { name: 'Tester' }, tags: ['test'], categories: ['Utility'],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: '1.0.0',
    rights: { status, reason: 'community-license' }, json: sampleWorkflowJson,
  } as unknown as Candidate;
}

function mockPrev(entryId: string): { security: EntrySecurity; record: V2RescanRecord } {
  const bodySha = hash(new TextEncoder().encode(JSON.stringify(sampleWorkflowJson)));
  const security: EntrySecurity = {
    schemaVersion: 'scanner-result-v2', grade: 'LOW', score: 100,
    counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [], hardenedExtra: 0,
    scannerVersion: ADMITTED_V2_SCAN_IDENTITY.scannerVersion, profile: 'beta-default', analysisStatus: 'COMPLETE',
  };
  const securitySha = hash(canonicalizeJson(security));
  const record: V2RescanRecord = {
    entryId, sourceDigest: bodySha, inputSha256: bodySha, ...ADMITTED_V2_SCAN_IDENTITY,
    analysisStatus: 'COMPLETE', rightsClass: 'link_only', ok: true, findingIds: [], grade: 'LOW',
    securityProjectionVersion: ENTRY_SECURITY_PROJECTION_VERSION, securitySha256: securitySha,
  };
  return { security, record };
}

describe('runScanStage with source-bound cache authority', () => {
  it('executes full scan stage and persists source receipt on cold run', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'scan-stage-cold-'));
    const candidate = createCandidate('cold-1');
    let scanCalls = 0;
    await runScanStage({
      runId: 'cold-run', workDir: tmp, candidates: [candidate],
      ledgerPath: join(tmp, 'stage-ledger.jsonl'),
      onScanExecuted: () => { scanCalls += 1; },
    });
    expect(scanCalls).toBe(1);
    expect(candidate.security?.grade).toBeDefined();

    const manifest = await readV2RescanManifest(join(tmp, 'v2-rescan-manifest.json'));
    expect(manifest.records.length).toBe(1);
    expect(manifest.receipt?.schemaVersion).toBe('v2-source-receipt');
    expect(manifest.receipt?.sourceBuildDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fast-forwards (HIT) with 0 scan calls on same-source persisted warm run', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'scan-stage-hit-'));
    const ledgerPath = join(tmp, 'stage-ledger.jsonl');
    const candidateCold = createCandidate('hit-1');
    let coldScanCalls = 0;
    await runScanStage({
      runId: 'cold-run', workDir: tmp, candidates: [candidateCold], ledgerPath,
      onScanExecuted: () => { coldScanCalls += 1; },
    });
    expect(coldScanCalls).toBe(1);
    const coldSecurity = candidateCold.security;

    const manifest = await readV2RescanManifest(join(tmp, 'v2-rescan-manifest.json'));
    expect(manifest.receipt).toBeDefined();

    const candidateWarm = createCandidate('hit-1');
    let warmScanCalls = 0;
    await runScanStage({
      runId: 'warm-run', workDir: tmp, candidates: [candidateWarm], ledgerPath,
      previousRun: {
        manifestRecords: new Map(manifest.records.map((r) => [r.entryId, r])),
        securitySummaries: new Map([['hit-1', coldSecurity]]),
        receipt: manifest.receipt,
      },
      onScanExecuted: () => { warmScanCalls += 1; },
    });
    expect(warmScanCalls).toBe(0);
    expect(candidateWarm.security).toEqual(coldSecurity);
  });

  it('forces re-scan (MISS) when scanner source changes despite identical workflow and config', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'scan-stage-src-miss-'));
    const receipt = await buildScannerSourceReceipt({ runId: 'prior-run' });
    const { security: prevSecurity, record: prevRecord } = mockPrev('miss-1');

    const mutatedFiles = [...receipt.sourceFiles, { path: 'packages/scanner-core/src/v2/new-rule.ts', sha256: '1'.repeat(64) }];
    const newBuildDigest = computeSourceBuildDigest({
      sourceFiles: mutatedFiles, lockfileDigest: receipt.lockfileDigest,
      runtimeVersion: receipt.runtimeVersion, effectiveConfigDigest: receipt.effectiveConfigDigest,
    });
    const changedReceipt: V2SourceReceipt = { ...receipt, sourceBuildDigest: newBuildDigest, sourceFiles: mutatedFiles };

    const candidate = createCandidate('miss-1');
    let scanCalls = 0;
    await runScanStage({
      runId: 'source-change-run', workDir: tmp, candidates: [candidate],
      ledgerPath: join(tmp, 'stage-ledger.jsonl'),
      previousRun: {
        manifestRecords: new Map([['miss-1', prevRecord]]),
        securitySummaries: new Map([['miss-1', prevSecurity]]),
        receipt,
      },
      currentReceipt: changedReceipt,
      onScanExecuted: () => { scanCalls += 1; },
    });
    expect(scanCalls).toBe(1);
    expect(candidate.security.score).toBe(0);
  });

  it('forces re-scan (MISS) when prior receipt is absent or rights change', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'scan-stage-legacy-miss-'));
    const ledgerPath = join(tmp, 'stage-ledger.jsonl');
    const { security: prevSecurity, record: prevRecord } = mockPrev('legacy-1');

    const candidateLegacy = createCandidate('legacy-1');
    let scanCalls1 = 0;
    await runScanStage({
      runId: 'legacy-run', workDir: tmp, candidates: [candidateLegacy], ledgerPath,
      previousRun: {
        manifestRecords: new Map([['legacy-1', prevRecord]]),
        securitySummaries: new Map([['legacy-1', prevSecurity]]),
      },
      onScanExecuted: () => { scanCalls1 += 1; },
    });
    expect(scanCalls1).toBe(1);

    const receipt = await buildScannerSourceReceipt({ runId: 'rights-run' });
    const candidateRights = createCandidate('legacy-1', 'redistributable');
    let scanCalls2 = 0;
    await runScanStage({
      runId: 'rights-run', workDir: tmp, candidates: [candidateRights], ledgerPath,
      previousRun: {
        manifestRecords: new Map([['legacy-1', prevRecord]]),
        securitySummaries: new Map([['legacy-1', prevSecurity]]),
        receipt,
      },
      currentReceipt: receipt,
      onScanExecuted: () => { scanCalls2 += 1; },
    });
    expect(scanCalls2).toBe(1);
  });

  it('buildScannerSourceReceipt computes deterministic digest and detects source file mutation', async () => {
    const receiptA = await buildScannerSourceReceipt({ runId: 'det-1' });
    const receiptB = await buildScannerSourceReceipt({ runId: 'det-2' });
    expect(receiptA.sourceBuildDigest).toBe(receiptB.sourceBuildDigest);
    expect(receiptA.sourceFiles.length).toBeGreaterThan(0);

    const mutatedFiles = [
      ...receiptA.sourceFiles.slice(1),
      { path: receiptA.sourceFiles[0]!.path, sha256: 'f'.repeat(64) },
    ];
    const mutatedDigest = computeSourceBuildDigest({
      sourceFiles: mutatedFiles,
      lockfileDigest: receiptA.lockfileDigest,
      runtimeVersion: receiptA.runtimeVersion,
      effectiveConfigDigest: receiptA.effectiveConfigDigest,
    });
    expect(mutatedDigest).not.toBe(receiptA.sourceBuildDigest);
  });
});
