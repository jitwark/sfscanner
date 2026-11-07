import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ScanWorkflowV2Result } from '@hub/scanner-core/v2';
import {
  ADMITTED_V2_SCAN_IDENTITY,
  retainCorpusWorkflowV2Evidence,
  scanCorpusWorkflowV2,
  type V2RetainedScanEvidence,
} from './v2-corpus-adapter.js';

const bytes = (value = '{"nodes":[],"connections":{}}') => new TextEncoder().encode(value);

const scanResult = (result: unknown): ScanWorkflowV2Result => ({ ok: true, result }) as unknown as ScanWorkflowV2Result;

/**
 * The shape a required-capability failure produces on the live engine: five diagnostics, a null
 * assessment, and codes only — no message, no limit id, no pointer. Measured on a 58-node /
 * 2,660-member chain at this revision (see the packet report's D-1 note).
 */
const indeterminateResult = () => ({
  engine: { id: 'secureflow-scanner', version: ADMITTED_V2_SCAN_IDENTITY.scannerVersion, buildDigest: ADMITTED_V2_SCAN_IDENTITY.engineBuildDigest },
  profile: { id: ADMITTED_V2_SCAN_IDENTITY.profileId, version: ADMITTED_V2_SCAN_IDENTITY.profileVersion },
  ruleset: { id: 'scanner-core-builtins', version: '2.0.0', digest: ADMITTED_V2_SCAN_IDENTITY.rulesetDigest, signatureStatus: 'VERIFIED' },
  semantics: { id: 'builtin-semantics', version: '2.0.0', digest: ADMITTED_V2_SCAN_IDENTITY.semanticsDigest },
  limits: { schemaVersion: 'scanner-limits-v2', digest: ADMITTED_V2_SCAN_IDENTITY.limitsDigest, usage: [] },
  analysis: {
    status: 'INDETERMINATE',
    capabilities: [
      { id: 'source-normalization', status: 'FAILED', omitted: 1 },
      { id: 'workflow-insights', status: 'SKIPPED', omitted: 1 },
    ],
    diagnostics: [
      { code: 'DEPENDENCY_UNAVAILABLE', category: 'POLICY', capabilityId: 'workflow-insights', aggregateEffect: 'INDETERMINATE', assessmentEligible: false },
      { code: 'REQUIRED_CAPABILITY_FAILED', category: 'POLICY', capabilityId: 'source-normalization', aggregateEffect: 'INDETERMINATE', assessmentEligible: false },
    ],
  },
  findings: [],
  assessment: null,
});

describe('scanCorpusWorkflowV2', () => {
  it('records scanner authority and deterministic input/result hashes', () => {
    const first = scanCorpusWorkflowV2(bytes(), 'fixture-entry', 'redistributable');
    const second = scanCorpusWorkflowV2(bytes(), 'fixture-entry', 'redistributable');

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      entryId: 'fixture-entry',
      sourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      inputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      scannerVersion: '2.0.0',
      engineBuildDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      profileId: 'beta-default',
      profileVersion: '2.0.0',
      rulesetDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      semanticsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      limitsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      analysisStatus: 'COMPLETE',
      resultDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      rightsClass: 'redistributable',
      ok: true,
      securityProjectionVersion: 'v2-entry-security-1',
      securitySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(first.sourceDigest).toBe(first.inputSha256);
    expect(first.findingIds).toEqual([]);
    expect(first.grade).toBe('LOW');
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.limitsDigest).toBe(ADMITTED_V2_SCAN_IDENTITY.limitsDigest);
  });

  it('does not leak workflow content and preserves link-only rights', () => {
    const record = scanCorpusWorkflowV2(bytes('{"nodes":[{"name":"private-secret"}],"connections":{}}'), 'link', 'link_only');
    expect(record.rightsClass).toBe('link_only');
    expect(JSON.stringify(record)).not.toContain('private-secret');
  });

  it('records a bounded scanner rejection without turning it into a clean result', () => {
    const scan = vi.fn(() => ({ ok: false as const, code: 'INVALID_JSON' as const, message: 'invalid' }));
    const record = scanCorpusWorkflowV2(bytes(), 'bad', 'excluded', { scan });
    expect(scan).toHaveBeenCalledOnce();
    expect(record).toMatchObject({ entryId: 'bad', analysisStatus: 'INDETERMINATE', rightsClass: 'excluded', ok: false });
    expect(record.resultDigest).toBeUndefined();
  });
});

describe('retainCorpusWorkflowV2Evidence', () => {
  it('retains the admitted identity tuple, the body digest and the result digest of a real body', () => {
    const input = bytes();
    const evidence = retainCorpusWorkflowV2Evidence(input, 'fixture-entry', 'link_only');

    expect(evidence.identity).toEqual(ADMITTED_V2_SCAN_IDENTITY);
    expect(evidence.bodySha256).toBe(scanCorpusWorkflowV2(input, 'fixture-entry', 'link_only').inputSha256);
    expect(evidence.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.analysisStatus).toBe('COMPLETE');
    expect(evidence.assessment).toMatchObject({ grade: 'LOW' });
    expect(evidence.security.grade).toBe('LOW');
    expect(evidence.security.scannerVersion).toBe('2.0.0');
    expect(evidence.security.schemaVersion).toBe('scanner-result-v2');
    expect(evidence.diagnosticCodes).toEqual([]);
    expect(evidence).toMatchObject({ entryId: 'fixture-entry', rightsClass: 'link_only', ok: true });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.identity)).toBe(true);
  });

  it('records an INDETERMINATE analysis as its status with diagnostic codes and a null assessment', () => {
    const evidence = retainCorpusWorkflowV2Evidence(bytes(), 'indeterminate', 'redistributable', {
      scan: () => scanResult(indeterminateResult()),
    });
    const summary = scanCorpusWorkflowV2(bytes(), 'indeterminate', 'redistributable', { scan: () => scanResult(indeterminateResult()) });

    expect(evidence).toMatchObject({ ok: true, analysisStatus: 'INDETERMINATE', assessment: null });
    expect(evidence.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.diagnosticCodes).toEqual(['DEPENDENCY_UNAVAILABLE', 'REQUIRED_CAPABILITY_FAILED']);
    expect(evidence.security.grade).toBe('UNKNOWN');
    expect(evidence.security.score).toBe(0);
    expect(evidence.security.findings).toEqual([]);
    expect(summary.grade).toBeUndefined();
    expect(summary.analysisStatus).toBe('INDETERMINATE');
  });

  it('keeps real findings and severity counts when the engine publishes no assessment', () => {
    const result = indeterminateResult();
    const evidence = retainCorpusWorkflowV2Evidence(bytes(), 'observed-findings', 'link_only', {
      scan: () => scanResult({
        ...result,
        findings: [
          { findingId: 'a'.repeat(64), ruleId: 'N8N_EXECUTE_COMMAND', ruleRevision: '1', effect: 'SCORING', severity: 'CRITICAL', confidence: 'HIGH', evidenceClass: 'CAPABILITY', conclusion: 'OBSERVED', applicability: 'APPLICABLE', subject: { kind: 'WORKFLOW' }, factRefs: [], traceRefs: [], remediationId: 'r' },
          { findingId: 'b'.repeat(64), ruleId: 'N8N_CODE_NODE', ruleRevision: '1', effect: 'SCORING', severity: 'LOW', confidence: 'HIGH', evidenceClass: 'CAPABILITY', conclusion: 'OBSERVED', applicability: 'APPLICABLE', subject: { kind: 'WORKFLOW' }, factRefs: [], traceRefs: [], remediationId: 'r' },
        ],
      }),
    });

    expect(evidence.assessment).toBeNull();
    expect(evidence.security.grade).toBe('UNKNOWN');
    expect(evidence.security.score).toBe(0);
    expect(evidence.security.counts).toEqual({ critical: 1, high: 0, medium: 0, low: 1, info: 0 });
    expect(evidence.security.findings.map((finding) => finding.id)).toEqual(['N8N_EXECUTE_COMMAND', 'N8N_CODE_NODE']);
    expect(evidence.security.analysisStatus).toBe('INDETERMINATE');
  });

  it('retains no workflow content, private path or credential value', () => {
    const input = bytes(
      '{"nodes":[{"name":"/srv/private/bodies/secret-workflow.json"}],"connections":{},"password":"hunter2"}',
    );
    const evidence: V2RetainedScanEvidence = retainCorpusWorkflowV2Evidence(input, 'leak', 'link_only');
    const serialized = JSON.stringify(evidence);

    expect(serialized).not.toContain('secret-workflow');
    expect(serialized).not.toContain('/srv/private');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toMatch(/https?:\/\//);
  });

  it('stays truthful on a document at the live required-capability ceiling', () => {
    const nodes = Array.from({ length: 58 }, (_, index) => ({
      id: `n${index}`,
      name: `Node ${index}`,
      type: 'n8n-nodes-base.code',
      typeVersion: 1,
      position: [index * 10, 0],
      parameters: { jsCode: `return { json: { v: ${JSON.stringify('a'.repeat(2_000))} } };` },
    }));
    const connections: Record<string, unknown> = {};
    for (let index = 0; index < nodes.length - 1; index += 1) {
      connections[`Node ${index}`] = { main: [[{ node: `Node ${index + 1}`, type: 'main', index: 0 }]] };
    }
    const evidence = retainCorpusWorkflowV2Evidence(
      new TextEncoder().encode(JSON.stringify({ name: 'chain', nodes, connections })),
      'ceiling',
      'redistributable',
    );

    expect(['COMPLETE', 'DEGRADED', 'INDETERMINATE']).toContain(evidence.analysisStatus);
    expect(evidence.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.diagnosticCodes.length === 0).toBe(evidence.analysisStatus === 'COMPLETE');
    if (evidence.analysisStatus === 'INDETERMINATE') expect(evidence.assessment).toBeNull();
  });

  it('retains both fallback codes, DEGRADED, and the grade from the same scan', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      nodes: [
        { id: 'Start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
        { id: 'Unknown', name: 'Unknown', type: 'n8n-nodes-base.discord', typeVersion: 1, parameters: {} },
      ],
      connections: { Start: { main: [[{ node: 'Unknown', type: 'main', index: 0 }]] } },
    }));

    const evidence = retainCorpusWorkflowV2Evidence(bytes, 'semantic-fallback', 'redistributable');
    expect(evidence).toMatchObject({
      ok: true,
      identity: { profileId: 'beta-default', profileVersion: '2.0.0' },
      analysisStatus: 'DEGRADED',
      assessment: { grade: expect.any(String) },
      diagnosticCodes: expect.arrayContaining([
        'SEMANTIC_CATALOGUE_MISS',
        'GENERIC_NODE_UNMODELED_CAPABILITY',
      ]),
    });
  });

  const authenticFixturePath = path.resolve(import.meta.dirname, '__fixtures__', 'f1804862f3d4c9f7.json');
  const hasAuthenticFixture = fs.existsSync(authenticFixturePath);

  it.skipIf(!hasAuthenticFixture)('preserves typed engine refusal and exact provenance on authentic 29,591-byte f1804862f3d4c9f7 input', () => {
    const rawBytes = fs.readFileSync(authenticFixturePath);
    expect(rawBytes.length).toBe(29_591);
    const evidence = retainCorpusWorkflowV2Evidence(new Uint8Array(rawBytes), 'f1804862f3d4c9f7', 'link_only');
    expect(evidence.bodySha256).toBe('a4be1be8802edb4ef3ba2b22aa5e276a268f1e563938eb8f1978b7b84cdcd0a1');
    expect(evidence.ok).toBe(false);
    expect(evidence.refusalCode).toBe('SEMANTIC_CATALOGUE_INVALID');
    expect(evidence.security).toMatchObject({
      analysisStatus: 'INDETERMINATE', noResult: true, noResultCode: 'SEMANTIC_CATALOGUE_INVALID',
    });
  });

  it('preserves typed engine refusal projection on non-conforming node type with space', () => {
    const syntheticBytes = new TextEncoder().encode(JSON.stringify({
      nodes: [{ id: '1', name: 'PDF', type: 'n8n-nodes-pdfco.PDFco Api', typeVersion: 1, position: [0, 0], parameters: {} }],
      connections: {},
    }));
    const evidence = retainCorpusWorkflowV2Evidence(syntheticBytes, 'synthetic-refusal', 'link_only');
    expect(evidence.ok).toBe(false);
    expect(evidence.resultDigest).toBeNull();
    expect(evidence.analysisStatus).toBe('INDETERMINATE');
    expect(evidence.refusalCode).toBe('SEMANTIC_CATALOGUE_INVALID');
    expect(evidence.security).toMatchObject({
      schemaVersion: 'scanner-result-v2', grade: 'UNKNOWN', score: 0,
      analysisStatus: 'INDETERMINATE', noResult: true, noResultCode: 'SEMANTIC_CATALOGUE_INVALID',
    });
  });
});
