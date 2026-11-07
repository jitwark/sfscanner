import cleanJsonFixture from '../../../e2e/fixtures/clean.json';
import fallbackJsonFixture from '../../../e2e/fixtures/fallback.json';
import { describe, expect, it } from 'vitest';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import type { ScanWorkflowResult } from '../engine';
import { toScannerReportModelV2, type ScannerReportModelV2 } from '../scanner-v2-presentation';
import { buildSarifReport } from './report-sarif';

const baseFinding = {
  policyId: 'TOKEN', title: 'Token finding', severity: 'HIGH' as const, location: { nodeName: 'Charge card' },
  evidence: {}, message: 'Review', explanation: 'Review', whyItMatters: 'Review', possibleImpact: 'Review',
  remediation: 'Review', remediationSteps: ['Review'], confidence: 'HIGH' as const, policyEffect: 'LEGACY_SCORE' as const,
};

const baseScan = {
  scannerVersion: 'scanner-beta-1', analysisStatus: 'DEGRADED', analysisDiagnostics: [], findings: [baseFinding],
} as unknown as ScanWorkflowResult;

describe('SARIF report ordering', () => {
  it('canonically orders tied findings and diagnostics before serializing', () => {
    const tied = {
      ...baseScan,
      findings: ['first', 'second'].map((label) => ({ ...baseFinding, evidence: { label }, remediation: `Remediate ${label}`, remediationSteps: [`Step ${label}`] })),
      analysisDiagnostics: ['node-a', 'node-b'].map((nodeId) => ({ code: 'SOURCE_SPAN_UNAVAILABLE' as const, category: 'SOURCE' as const, location: { nodeName: 'Charge card', nodeId, path: '/nodes/0', sourceSpan: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 2, offset: 1 } } } })),
    };

    expect(buildSarifReport(tied)).toBe(buildSarifReport({ ...tied, findings: [...tied.findings].reverse(), analysisDiagnostics: [...tied.analysisDiagnostics].reverse() }));
  });
});

describe('SARIF rule CWE tags', () => {
  it('tags a catalogued rule with its CWE ID in GitHub code-scanning form', () => {
    const scan = { ...baseScan, findings: [{ ...baseFinding, policyId: 'N8N_EXECUTE_COMMAND' }] };

    const rule = JSON.parse(buildSarifReport(scan)).runs[0].tool.driver.rules[0];

    expect(rule.properties.tags).toEqual(['external/cwe/cwe-078']);
  });

  it('tags an agentic rule with both its CWE and OWASP Agentic category', () => {
    const scan = { ...baseScan, findings: [{ ...baseFinding, policyId: 'AI_AGENT_UNGATED_TOOL' }] };

    const rule = JSON.parse(buildSarifReport(scan)).runs[0].tool.driver.rules[0];

    expect(rule.properties.tags).toEqual(['external/cwe/cwe-269', 'owasp-agentic/excessive-agency']);
  });

  it('omits tags for a policy ID the rule catalog does not recognize', () => {
    const rule = JSON.parse(buildSarifReport(baseScan)).runs[0].tool.driver.rules[0];

    expect(rule.properties.tags).toBeUndefined();
  });

  it('marks a completed degraded scan successful and gives rules a helpUri', () => {
    const report = JSON.parse(buildSarifReport(baseScan));
    expect(report.runs[0].invocations[0].executionSuccessful).toBe(true);
    expect(report.runs[0].tool.driver.rules[0].helpUri).toMatch(/^https:\/\//);
  });
});

// --- attached v2 authority -------------------------------------------------
const fixture = (name: 'clean.json' | 'fallback.json') => JSON.stringify(name === 'clean.json' ? cleanJsonFixture : fallbackJsonFixture);
const RAW_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

function v2Model(json: string): ScannerReportModelV2 {
  const result = scanWorkflowV2({ bytes: Uint8Array.from(new TextEncoder().encode(json)), profile: { id: 'beta-default', version: '2.0.0' } });
  if (!result.ok) throw new Error(result.code);
  return toScannerReportModelV2(result.result);
}

describe('SARIF report v2 authority', () => {
  it('reports the real degraded status, both coverage notifications, the retained finding and the worker grade', () => {
    const scan = v2Model(fixture('fallback.json'));
    const report = JSON.parse(buildSarifReport(scan));
    const [run] = report.runs;

    expect(run.invocations[0].executionSuccessful).toBe(true);
    const codes = run.invocations[0].toolExecutionNotifications.map((item: { descriptor: { id: string } }) => item.descriptor.id);
    expect(codes).toEqual(expect.arrayContaining(['SEMANTIC_CATALOGUE_MISS', 'GENERIC_NODE_UNMODELED_CAPABILITY']));
    expect(codes).not.toContain('POLICY_EXECUTION_FAILED');
    expect(run.results.map((item: { ruleId: string }) => item.ruleId)).toContain('RAW_SECRET_INDICATOR');
    expect(run.properties).toMatchObject({ analysisStatus: 'DEGRADED', riskGrade: scan.assessment!.grade, secureflow: expect.objectContaining({ analysisStatus: 'DEGRADED' }) });
    expect(JSON.stringify(report)).not.toContain(RAW_SECRET);
  });

  it('keeps a complete scan clean and a genuine indeterminate scan ungraded', () => {
    const complete = JSON.parse(buildSarifReport(v2Model(fixture('clean.json'))));
    expect(complete.runs[0].properties).toMatchObject({ analysisStatus: 'COMPLETE', riskGrade: v2Model(fixture('clean.json')).assessment!.grade, secureflow: expect.objectContaining({ analysisStatus: 'COMPLETE' }) });
    expect(complete.runs[0].invocations[0].toolExecutionNotifications).toEqual([]);

    const unreadable = JSON.stringify({
      nodes: [
        { id: 'Start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
        { id: 'Broken', name: 'Broken', type: 'n8n-nodes-base.discord', typeVersion: 1, parameters: 'not-an-object' },
      ],
      connections: {},
    });
    const withheld = JSON.parse(buildSarifReport(v2Model(unreadable)));
    expect(withheld.runs[0].properties).toMatchObject({ analysisStatus: 'INDETERMINATE', secureflow: expect.objectContaining({ analysisStatus: 'INDETERMINATE' }) });
    expect(withheld.runs[0].invocations[0].executionSuccessful).toBe(true);
    const withheldNotifications = withheld.runs[0].invocations[0].toolExecutionNotifications;
    expect(withheldNotifications.map((item: { descriptor: { id: string } }) => item.descriptor.id))
      .toEqual(['MALFORMED_NODE_PARAMETERS', 'SEMANTIC_CATALOGUE_MISS']);
    expect(withheldNotifications.every((item: { level: string }) => item.level === 'error')).toBe(true);
  });
});
