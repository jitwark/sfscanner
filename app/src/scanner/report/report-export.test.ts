import cleanJsonFixture from '../../../e2e/fixtures/clean.json';
import fallbackJsonFixture from '../../../e2e/fixtures/fallback.json';
import { describe, expect, it } from 'vitest';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import type { ScanWorkflowResult } from '../engine';
import { createMockScanResult } from '../run-scan.test-support';
import { toScannerReportModelV2, type ScannerReportModelV2 } from '../scanner-v2-presentation';
import { buildExportReport } from './report-export';

const fixture = (name: 'clean.json' | 'fallback.json') => JSON.stringify(name === 'clean.json' ? cleanJsonFixture : fallbackJsonFixture);
const RAW_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const API_KEY_CANARY = 'api_key_canary_9ab712345678';
const SECRET_TOKEN_CANARY = 'secret_token_canary_AWS_credential';
const SECRET_JSON = JSON.stringify({
  nodes: [{ id: 'http-1', name: 'Call API', type: 'n8n-nodes-base.httpRequest', typeVersion: 1, parameters: { apiKey: 'sk_live_super_secret_value' } }],
  connections: {},
});

function v2Model(json: string): ScannerReportModelV2 {
  const result = scanWorkflowV2({ bytes: Uint8Array.from(new TextEncoder().encode(json)), profile: { id: 'beta-default', version: '2.0.0' } });
  if (!result.ok) throw new Error(result.code);
  return toScannerReportModelV2(result.result);
}

/** A model built from a result produced before label redaction: the finding subject carries canaries. */
function poisonedV2Model(): ScannerReportModelV2 {
  const scanned = scanWorkflowV2({ bytes: Uint8Array.from(new TextEncoder().encode(SECRET_JSON)), profile: { id: 'beta-default', version: '2.0.0' } });
  if (!scanned.ok) throw new Error(scanned.code);
  const result = scanned.result;
  const finding = result.findings.find(({ subject }) => subject.kind === 'NODE');
  if (!finding || finding.subject.kind !== 'NODE') throw new Error('Expected a node-subject finding');
  const { node } = finding.subject;
  return toScannerReportModelV2({
    ...result,
    findings: result.findings.map((entry) => entry.findingId === finding.findingId
      ? { ...entry, subject: { kind: 'NODE' as const, node: { ...node, explicitId: API_KEY_CANARY, name: SECRET_TOKEN_CANARY } } }
      : entry),
  });
}

describe('buildExportReport', () => {
  it('exports the real v2 envelope instead of the compatibility projection', () => {
    const scan = v2Model(fixture('fallback.json'));
    const report = JSON.parse(buildExportReport(scan)).report;

    expect(report.schemaVersion).toBe('scanner-result-v2');
    expect(report.analysis.status).toBe('DEGRADED');
    expect(report.assessment.grade).toBe(scan.assessment!.grade);
    expect(report.findings.map((finding: { ruleId: string }) => finding.ruleId)).toContain('RAW_SECRET_INDICATOR');
    expect(JSON.stringify(report)).not.toContain(RAW_SECRET);
    expect(JSON.stringify(report)).not.toContain('POLICY_EXECUTION_FAILED');
  });

  it('keeps the v1 projection payload for a detached scan', () => {
    const scan: ScanWorkflowResult = createMockScanResult('beta-default');
    const report = JSON.parse(buildExportReport(scan)).report;

    expect(report.schemaVersion).toBe('scanner-result-v1');
    expect(report.analysisStatus).toBe('COMPLETE');
    expect(report.riskAssessment.grade).toBe('LOW');
  });

  it('keeps secret-shaped labels out of the JSON export when the model still carries them', () => {
    const model = poisonedV2Model();
    const text = buildExportReport(model);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).not.toContain(API_KEY_CANARY);
    expect(text).not.toContain(SECRET_TOKEN_CANARY);
    const report = JSON.parse(text).report;
    // Identity, status and counts are unchanged by the label redaction.
    expect(report.schemaVersion).toBe('scanner-result-v2');
    expect(report.engine).toEqual(model.v2.engine);
    expect(report.analysis.status).toBe(model.v2.analysis.status);
    expect(report.findings.length).toBe(model.v2.findings.length);
    expect(report.workflow.nodeCount).toBe(model.v2.workflow.nodeCount);
  });
});
