import { describe, expect, it } from 'vitest';
import { validateCliJsonDocument } from './cli-schema.js';

const finding = {
  policyId: 'RULE_A', title: 'A finding', severity: 'HIGH', location: { nodeName: 'Node' }, evidence: {},
  message: 'Message', explanation: 'Explanation', whyItMatters: 'Why', possibleImpact: 'Impact', remediation: 'Remediate',
  remediationSteps: ['Do it'], confidence: 'HIGH', policyEffect: 'LEGACY_SCORE',
};

function scanResult(findings: unknown[] = [finding], status: 'COMPLETE' | 'INDETERMINATE' = 'COMPLETE'): Record<string, unknown> {
  const base = {
    schemaVersion: 'scanner-result-v1', scannerVersion: 'scanner-beta-1', policyProfile: 'beta-default',
    analysisStatus: status, analysisDiagnostics: status === 'INDETERMINATE' ? [{ code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' }] : [],
    workflow: { name: 'Workflow', nodeCount: 1, rawNodeCount: 1, annotationNodeCount: 0, triggerCount: 1, actionCount: 0, integrationCount: 0, connectionCount: 0, payloadBytes: 100, complexity: 'LOW', isSubWorkflow: false },
    functionSummary: { basicPurpose: 'Purpose', triggerDescription: 'Manual', dataFlowSummary: 'No flow', businessCategory: 'MANUAL_AUTOMATION', confidence: 'LOW' },
    integrations: [], findings,
  };
  if (status === 'INDETERMINATE') return base;
  return {
    ...base,
    riskAssessment: { score: 0, grade: 'LOW', topRisks: [], dataExposure: 'None', complexityDrivers: [] },
    humanSummary: { headline: 'Low risk', verdict: 'Review', plainLanguageOverview: 'Overview', riskNarrative: 'No risks', recommendedActions: [], findingHighlights: [] },
    summary: { critical: 0, high: findings.length, medium: 0, low: 0, info: 0 },
  };
}

function document(results: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: 'scanner-cli-v1', results,
    summary: {
      total: results.length, completed: results.filter((item) => (item as { ok?: boolean }).ok === true).length,
      inputErrors: results.filter((item) => (item as { error?: { kind?: string } }).error?.kind === 'input').length,
      internalErrors: results.filter((item) => (item as { error?: { kind?: string } }).error?.kind === 'internal').length,
      cancelled: results.filter((item) => (item as { error?: { kind?: string } }).error?.kind === 'cancelled').length,
      findings: 0,
    },
  };
}

describe('CLI result contract', () => {
  it('rejects successful results that omit required scanner fields', () => {
    const result = validateCliJsonDocument(document([{ input: 'workflow.json', ok: true, result: { findings: [finding] } }]));

    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([
      expect.objectContaining({ path: 'results[0].result.scannerVersion', code: 'TYPE' }),
      expect.objectContaining({ path: 'results[0].result.workflow', code: 'TYPE' }),
      expect.objectContaining({ path: 'results[0].result.analysisDiagnostics', code: 'TYPE' }),
    ]) });
  });

  it('accepts input, internal, cancelled, and indeterminate records with valid nullability', () => {
    const value = document([
      { input: 'cancelled.json', ok: false, error: { kind: 'cancelled', code: 'CANCELLED', message: 'Stopped.' } },
      { input: 'indeterminate.json', ok: true, result: scanResult([], 'INDETERMINATE') },
      { input: 'input.json', ok: false, error: { kind: 'input', code: 'INVALID_JSON', message: 'Invalid.' } },
      { input: 'internal.json', ok: false, error: { kind: 'internal', code: 'WORKER_FAILED', message: 'Failed.' } },
    ]);
    expect(validateCliJsonDocument(value)).toEqual({ ok: true });

    const contradictory = structuredClone(value) as Record<string, any>;
    contradictory.results[1].result.riskAssessment = null;
    expect(validateCliJsonDocument(contradictory)).toMatchObject({ ok: false, errors: expect.arrayContaining([
      expect.objectContaining({ path: 'results[1].result.riskAssessment', code: 'VALUE' }),
    ]) });
  });

  // AUDIT-SCAN-001: the CLI JSON contract has its own diagnostic-code allowlist, separate
  // from the browser worker's. A malformed connection target index must be able to cross
  // this boundary too, or the pipeline path would still silently look COMPLETE-shaped even
  // after the scanner-core and app fixes.
  it('accepts a DEGRADED result carrying a MALFORMED_CONNECTION_INDEX diagnostic', () => {
    const degraded = {
      ...scanResult([]),
      analysisStatus: 'DEGRADED',
      analysisDiagnostics: [
        { code: 'MALFORMED_CONNECTION_INDEX', category: 'GRAPH', location: { path: '/connections/Webhook/main/0/0/index' } },
      ],
    };
    const value = document([{ input: 'degraded.json', ok: true, result: degraded }]);

    expect(validateCliJsonDocument(value)).toEqual({ ok: true });
  });

  it('rejects contradictory result variants and non-canonical result ordering', () => {
    const result = validateCliJsonDocument(document([
      { input: 'z.json', ok: true, result: scanResult([]), error: { kind: 'input', code: 'INVALID_JSON', message: 'Invalid.' } },
      { input: 'a.json', ok: false, result: {}, error: { kind: 'input', code: 'INVALID_JSON', message: 'Invalid.' } },
    ]));
    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([
      expect.objectContaining({ path: 'results', code: 'ORDER' }),
      expect.objectContaining({ path: 'results[0].error', code: 'UNKNOWN' }),
      expect.objectContaining({ path: 'results[1].result', code: 'UNKNOWN' }),
    ]) });
  });

  it('rejects dangerous own keys in nested JSON evidence', () => {
    const dangerousFinding = { ...finding, evidence: JSON.parse('{"__proto__":"blocked"}') };
    const result = validateCliJsonDocument(document([{ input: 'workflow.json', ok: true, result: scanResult([dangerousFinding]) }]));
    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([
      expect.objectContaining({ path: 'results[0].result.findings[0].evidence', code: 'TYPE' }),
    ]) });
  });
});
