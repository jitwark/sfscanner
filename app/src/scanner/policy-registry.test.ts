import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { resolvePolicyProfile } from '@hub/scanner-core/policies/profile';
import { scanWorkflow } from './engine';
import { betaDefaultCompatibilityFixture } from './__fixtures__/beta-default-compatibility';

function minimalWorkflowJson(): string {
  return JSON.stringify({
    name: 'Registry fixture',
    nodes: [
      {
        id: 'manual-1',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        parameters: {},
      },
    ],
    connections: {},
  });
}

describe('policy registry', () => {
  it('marks hardened code-analysis findings report-only in the response', () => {
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes: [{
        id: 'c1', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2,
        parameters: { language: 'javaScript', jsCode: 'eval(x)' },
      }],
      connections: {},
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow, { policyProfile: 'beta-hardened' });

    const javascript = result.findings.find((entry) => entry.policyId === 'JAVASCRIPT_DYNAMIC_EXECUTION');
    const legacy = result.findings.find((entry) => entry.policyId === 'N8N_CODE_NODE');
    expect(javascript?.policyEffect).toBe('REPORT_ONLY');
    expect(legacy?.policyEffect).toBe('LEGACY_SCORE');
  });

  it('resolves the beta-default profile with correct metadata', () => {
    const result = resolvePolicyProfile('beta-default');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.version).toBe('scanner-beta-1');
    expect(result.profileId).toBe('beta-default');
    expect(typeof result.createPolicies).toBe('function');
    expect(result.ruleCatalog.map((rule) => rule.policyId)).toEqual([
      'N8N_EXECUTE_COMMAND',
      'N8N_CODE_NODE',
      'RAW_AUTH_HEADER',
      'RAW_SECRET_INDICATOR',
      'UNAPPROVED_DOMAIN',
      'UNKNOWN_NODE_PACKAGE',
      'WEBHOOK_EXPOSURE',
    ]);
    expect(result.ruleCatalog.find((rule) => rule.policyId === 'N8N_EXECUTE_COMMAND')).toMatchObject({
      defaultSeverity: 'CRITICAL', precision: 'HIGH', policyEffect: 'LEGACY_SCORE',
      curationAction: 'NONE', serveAction: 'DISPLAY',
    });
    expect(result.createPolicies({}).map((policy) => policy.id)).toEqual(
      result.ruleCatalog.map((rule) => rule.policyId),
    );
  });

  it.each(['nonexistent-profile', 'toString'])('returns a typed missing result for %s', (profileId) => {
    const result = resolvePolicyProfile(profileId);

    expect(result).toEqual({ ok: false, code: 'UNKNOWN_PROFILE', profileId });
  });
});

describe('engine characterization', () => {
  it('reports scanner-beta-1 version and beta-default profile', () => {
    const parsed = parseWorkflowJson(minimalWorkflowJson());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow);

    expect(result.scannerVersion).toBe('scanner-beta-1');
    expect(result.policyProfile).toBe('beta-default');
  });

  it('produces a safe empty report for a minimal workflow', () => {
    const parsed = parseWorkflowJson(minimalWorkflowJson());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow);

    expect(result.findings).toEqual([]);
    expect(result.summary).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    });
  });

  it('produces the same representative findings as before', () => {
    const parsed = parseWorkflowJson(
      JSON.stringify({
        name: 'Risk fixture',
        nodes: [
          {
            id: 'cmd-1',
            name: 'Run shell',
            type: 'n8n-nodes-base.executeCommand',
            parameters: { command: 'echo hello' },
          },
          {
            id: 'code-1',
            name: 'Transform',
            type: 'n8n-nodes-base.code',
            parameters: { jsCode: 'return items;' },
          },
          {
            id: 'wh-1',
            name: 'Public webhook',
            type: 'n8n-nodes-base.webhook',
            parameters: { path: 'ingest', authentication: 'none' },
          },
        ],
        connections: {},
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ policyId: 'N8N_EXECUTE_COMMAND', severity: 'CRITICAL' }),
        expect.objectContaining({ policyId: 'N8N_CODE_NODE', severity: 'LOW' }),
        expect.objectContaining({ policyId: 'WEBHOOK_EXPOSURE', severity: 'MEDIUM' }),
      ]),
    );
  });

  it('preserves the beta-default compatibility fixture', () => {
    const parsed = parseWorkflowJson(betaDefaultCompatibilityFixture.workflowJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow);

    expect(result).toMatchObject({
      scannerVersion: betaDefaultCompatibilityFixture.expected.scannerVersion,
      policyProfile: betaDefaultCompatibilityFixture.expected.policyProfile,
      analysisStatus: betaDefaultCompatibilityFixture.expected.analysisStatus,
      analysisDiagnostics: betaDefaultCompatibilityFixture.expected.analysisDiagnostics,
      summary: betaDefaultCompatibilityFixture.expected.summary,
    });
    expect(result.findings.map((finding) => ({
      policyId: finding.policyId,
      severity: finding.severity,
      nodeId: finding.location.nodeId,
    }))).toEqual(betaDefaultCompatibilityFixture.expected.findings);
  });

  it('keeps code-analysis catalog metadata hardened-only and report-only', () => {
    const result = resolvePolicyProfile('beta-hardened');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.includesJavaScriptAnalysis).toBe(true);
    expect(result.includesPythonAnalysis).toBe(true);
    expect(result.ruleCatalog).toContainEqual(expect.objectContaining({
      policyId: 'JAVASCRIPT_DYNAMIC_EXECUTION', policyEffect: 'REPORT_ONLY',
      curationAction: 'REVIEW', serveAction: 'DISPLAY',
    }));
    expect(result.ruleCatalog).toContainEqual(expect.objectContaining({
      policyId: 'PYTHON_DYNAMIC_EXECUTION', defaultConfidence: 'MEDIUM', precision: 'MEDIUM',
      policyEffect: 'REPORT_ONLY', curationAction: 'REVIEW', serveAction: 'DISPLAY',
    }));
  });
});
