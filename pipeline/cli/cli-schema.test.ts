import { describe, expect, it } from 'vitest';
import { validateCliJsonDocument, validateSarifDocument } from './cli-schema.js';

const finding = {
  policyId: 'RULE_A', title: 'A finding', severity: 'HIGH',
  location: { nodeName: 'Node' }, evidence: {}, message: 'Message',
  explanation: 'Explanation', whyItMatters: 'Why', possibleImpact: 'Impact',
  remediation: 'Remediate', remediationSteps: ['Do it'], confidence: 'HIGH',
  policyEffect: 'LEGACY_SCORE',
};

function validDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'scanner-cli-v1',
    results: [{ input: 'workflow.json', ok: true, result: scanResult() }],
    summary: { total: 1, completed: 1, inputErrors: 0, internalErrors: 0, cancelled: 0, findings: 1 },
    ...overrides,
  };
}

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

const validSarif = {
  version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  runs: [{
    tool: { driver: { name: 'n8n-scan', version: '0.1.0', rules: [{ id: 'RULE_A', shortDescription: { text: 'A finding' } }] } },
    results: [{ ruleId: 'RULE_A', level: 'error', message: { text: 'A finding' } }],
    invocations: [{ executionSuccessful: true, toolExecutionNotifications: [] }],
  }],
};

describe('CLI machine-output schemas', () => {
  it('accepts a scanner-cli-v1 document and rejects malformed top-level values', () => {
    expect(validateCliJsonDocument(validDocument())).toEqual({ ok: true });
    for (const value of [null, [], { schemaVersion: 'scanner-cli-v2' }, { ...validDocument(), results: {} }]) {
      const result = validateCliJsonDocument(value);
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ errors: expect.any(Array) });
    }
  });

  it('reports summary count mismatches without throwing', () => {
    const result = validateCliJsonDocument(validDocument({ summary: { total: 2, completed: 0, inputErrors: 0, internalErrors: 0, cancelled: 0, findings: 9 } }));
    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([
      expect.objectContaining({ path: 'summary.total', code: 'COUNT' }),
      expect.objectContaining({ path: 'summary.completed', code: 'COUNT' }),
      expect.objectContaining({ path: 'summary.findings', code: 'COUNT' }),
    ]) });
  });

  it('rejects malformed result items, findings, and source spans', () => {
    const badFinding = { ...finding, severity: 'urgent', remediationSteps: ['ok', 2], location: { sourceSpan: { start: { line: 0, column: 1, offset: 4 }, end: { line: 1, column: 1, offset: 2 } } } };
    const result = validateCliJsonDocument(validDocument({ results: [
      { input: '', ok: true, result: { findings: [badFinding] } },
      { input: 'broken.json', ok: false, error: { kind: 'unknown', code: '', message: 4 } },
    ], summary: { total: 2, completed: 1, inputErrors: 0, internalErrors: 0, cancelled: 0, findings: 1 } }));
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ errors: expect.arrayContaining([
      expect.objectContaining({ path: 'results[0].input', code: 'VALUE' }),
      expect.objectContaining({ path: 'results[0].result.findings[0].severity', code: 'VALUE' }),
      expect.objectContaining({ path: 'results[0].result.findings[0].remediationSteps[1]', code: 'TYPE' }),
      expect.objectContaining({ path: 'results[0].result.findings[0].location.sourceSpan.start.line', code: 'VALUE' }),
      expect.objectContaining({ path: 'results[1].error.kind', code: 'VALUE' }),
    ]) });
  });

  it('rejects unknown fields and invalid scanner metadata inside successful results', () => {
    const bad = structuredClone(validDocument()) as Record<string, any>;
    bad.results[0].result.unexpected = true;
    bad.results[0].result.schemaVersion = 'scanner-result-v0';
    bad.results[0].result.analysisStatus = 'BROKEN';
    const result = validateCliJsonDocument(bad);
    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([
      expect.objectContaining({ path: 'results[0].result.unexpected', code: 'UNKNOWN' }),
      expect.objectContaining({ path: 'results[0].result.schemaVersion', code: 'VALUE' }),
      expect.objectContaining({ path: 'results[0].result.analysisStatus', code: 'VALUE' }),
    ]) });
  });

  it('accepts and validates SARIF diagnostics and optional source locations', () => {
    expect(validateSarifDocument(validSarif)).toEqual({ ok: true });
    const withLocation = structuredClone(validSarif) as Record<string, any>;
    withLocation.runs[0].results[0].locations = [{ physicalLocation: {
      artifactLocation: { uri: 'workflow.json' },
      region: { startLine: 2, startColumn: 3, endLine: 2, endColumn: 8, charOffset: 10, charLength: 5 },
    } }];
    expect(validateSarifDocument(withLocation)).toEqual({ ok: true });
    withLocation.runs[0].invocations[0].toolExecutionNotifications = [{
      descriptor: { id: 'INVALID_JSON' }, message: { text: 'bad.json: invalid' },
      properties: { input: 'bad.json', kind: 'input', code: 'INVALID_JSON' },
    }];
    withLocation.runs[0].invocations[0].executionSuccessful = false;
    expect(validateSarifDocument(withLocation)).toEqual({ ok: true });
  });

  it('rejects SARIF contract, rule-order, reference, notification, and location errors', () => {
    const bad = structuredClone(validSarif) as Record<string, any>;
    bad.version = '2.0.0';
    bad.runs[0].tool.driver.rules = [
      { id: 'RULE_Z', shortDescription: { text: 'Z' } },
      { id: 'RULE_A', shortDescription: { text: 'A' } },
    ];
    bad.runs[0].results = [{ ruleId: 'MISSING', level: 'bogus', message: { text: 'x' }, locations: [{ physicalLocation: { artifactLocation: { uri: '' }, region: { startLine: 0, startColumn: 1, endLine: 1, endColumn: 1, charOffset: -1, charLength: 0 } } }] }];
    bad.runs[0].invocations[0].toolExecutionNotifications = [{ descriptor: {}, message: { text: 'x' }, properties: { input: 'x', kind: 'unknown', code: '' } }];
    const result = validateSarifDocument(bad);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ errors: expect.arrayContaining([
      expect.objectContaining({ path: 'version', code: 'VALUE' }),
      expect.objectContaining({ path: 'runs[0].tool.driver.rules', code: 'ORDER' }),
      expect.objectContaining({ path: 'runs[0].results[0].ruleId', code: 'REFERENCE' }),
      expect.objectContaining({ path: 'runs[0].results[0].level', code: 'VALUE' }),
      expect.objectContaining({ path: 'runs[0].results[0].locations[0].physicalLocation.region.startLine', code: 'VALUE' }),
      expect.objectContaining({ path: 'runs[0].invocations[0].toolExecutionNotifications[0].properties.kind', code: 'VALUE' }),
    ]) });
  });

  it('rejects SARIF regions whose end precedes their start', () => {
    const bad = structuredClone(validSarif) as Record<string, any>;
    bad.runs[0].results[0].locations = [{ physicalLocation: {
      artifactLocation: { uri: 'workflow.json' },
      region: { startLine: 4, startColumn: 2, endLine: 3, endColumn: 9, charOffset: 20, charLength: 0 },
    } }];
    const result = validateSarifDocument(bad);
    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([
      expect.objectContaining({ path: 'runs[0].results[0].locations[0].physicalLocation.region', code: 'VALUE' }),
    ]) });
  });

  it('rejects SARIF invocations that report success while carrying diagnostics', () => {
    const bad = structuredClone(validSarif) as Record<string, any>;
    bad.runs[0].invocations[0].toolExecutionNotifications = [{
      descriptor: { id: 'INVALID_JSON' }, message: { text: 'bad.json: invalid' },
      properties: { input: 'bad.json', kind: 'input', code: 'INVALID_JSON' },
    }];

    expect(validateSarifDocument(bad)).toMatchObject({ ok: false, errors: expect.arrayContaining([
      expect.objectContaining({ path: 'runs[0].invocations[0].executionSuccessful', code: 'VALUE' }),
    ]) });
  });
});
