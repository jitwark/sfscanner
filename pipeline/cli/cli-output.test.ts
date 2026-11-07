import { describe, expect, it } from 'vitest';
import type { ScanWorkflowResult } from '../../app/src/scanner/engine';
import type { CanonicalScanFinding } from '@hub/scanner-core/policy';
import { formatScanOutput } from './cli-output';
import { validateCliJsonDocument, validateSarifDocument } from './cli-schema';
import type { CliJsonDocument, CliJsonItem } from './cli-runner';

type Sarif = {
  $schema: string;
  version: string;
  runs: Array<{
    tool: { driver: { name: string; version: string; rules?: Array<{ id: string; properties?: { tags?: string[] } }> } };
    results: Array<{ ruleId: string; locations?: unknown[] }>;
    invocations: Array<{
      executionSuccessful?: boolean;
      toolExecutionNotifications?: Array<{
        descriptor?: { id?: string };
        message: { text: string };
        properties?: { input?: string; kind?: string; code?: string };
      }>;
    }>;
  }>;
};

function finding(policyId: string, title = policyId, sourceSpan?: CanonicalScanFinding['location']['sourceSpan']): CanonicalScanFinding {
  return {
    policyId,
    title,
    severity: 'HIGH',
    location: { nodeName: 'Node', ...(sourceSpan ? { sourceSpan } : {}) },
    evidence: {},
    message: `Message for ${policyId}`,
    explanation: 'Explanation',
    whyItMatters: 'Why it matters',
    possibleImpact: 'Possible impact',
    remediation: 'Remediation',
    remediationSteps: ['Remediate'],
    confidence: 'HIGH',
    policyEffect: 'LEGACY_SCORE',
  };
}

function result(input: string, findings: CanonicalScanFinding[]): CliJsonItem {
  return {
    input,
    ok: true,
    result: {
      schemaVersion: 'scanner-result-v1', scannerVersion: 'scanner-beta-1', policyProfile: 'beta-default',
      analysisStatus: 'COMPLETE', analysisDiagnostics: [],
      workflow: { name: 'Workflow', nodeCount: 1, rawNodeCount: 1, annotationNodeCount: 0, triggerCount: 1, actionCount: 0, integrationCount: 0, connectionCount: 0, payloadBytes: 100, complexity: 'LOW', isSubWorkflow: false },
      functionSummary: { basicPurpose: 'Purpose', triggerDescription: 'Manual', dataFlowSummary: 'No flow', businessCategory: 'MANUAL_AUTOMATION', confidence: 'LOW' },
      integrations: [], findings,
      riskAssessment: { score: 0, grade: 'LOW', topRisks: [], dataExposure: 'None', complexityDrivers: [] },
      humanSummary: { headline: 'Low risk', verdict: 'Review', plainLanguageOverview: 'Overview', riskNarrative: 'No risks', recommendedActions: [], findingHighlights: [] },
      summary: { critical: 0, high: findings.length, medium: 0, low: 0, info: 0 },
    } as unknown as ScanWorkflowResult,
  };
}

function document(results: CliJsonItem[]): CliJsonDocument {
  return {
    schemaVersion: 'scanner-cli-v1',
    results,
    summary: {
      total: results.length,
      completed: results.filter((item) => item.ok).length,
      inputErrors: results.filter((item) => !item.ok && item.error.kind === 'input').length,
      internalErrors: results.filter((item) => !item.ok && item.error.kind === 'internal').length,
      cancelled: results.filter((item) => !item.ok && item.error.kind === 'cancelled').length,
      findings: results.reduce((count, item) => count + (item.ok ? item.result.findings.length : 0), 0),
    },
  };
}

function indeterminateResult(input: string): CliJsonItem {
  return {
    input,
    ok: true,
    result: {
      schemaVersion: 'scanner-result-v1', scannerVersion: 'scanner-beta-1', policyProfile: 'beta-default',
      analysisStatus: 'INDETERMINATE', analysisDiagnostics: [{ code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' }],
      workflow: { name: 'Workflow', nodeCount: 1, rawNodeCount: 1, annotationNodeCount: 0, triggerCount: 1, actionCount: 0, integrationCount: 0, connectionCount: 0, payloadBytes: 100, complexity: 'LOW', isSubWorkflow: false },
      functionSummary: { basicPurpose: 'Purpose', triggerDescription: 'Manual', dataFlowSummary: 'No flow', businessCategory: 'MANUAL_AUTOMATION', confidence: 'LOW' },
      integrations: [], findings: [],
    } as unknown as ScanWorkflowResult,
  };
}

function sarifOf(value: CliJsonDocument): Sarif {
  return JSON.parse(formatScanOutput(value, 'sarif')) as Sarif;
}

describe('CLI SARIF output', () => {
  it('emits a valid-shaped SARIF document when there are no findings', () => {
    const value = document([result('empty.json', [])]);
    const json = JSON.parse(formatScanOutput(value, 'json')) as unknown;
    const sarif = sarifOf(value);
    const run = sarif.runs[0]!;

    expect(validateCliJsonDocument(json)).toEqual({ ok: true });
    expect(validateSarifDocument(sarif)).toEqual({ ok: true });
    expect(sarif).toMatchObject({
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
    });
    expect(run.tool.driver).toMatchObject({ name: 'n8n-scan', version: '0.1.0', rules: [] });
    expect(run.results).toEqual([]);
    expect(run.invocations[0]!.toolExecutionNotifications).toEqual([]);
  });

  it('tags each rule with its CWE in the form GitHub code scanning reads', () => {
    // The CLI's SARIF is the output that reaches a Security tab. The browser
    // report had CWE tags and this did not, so the same finding carried its CWE
    // in the place nobody automated and lost it in the place everybody does.
    const sarif = sarifOf(document([result('workflow.json', [finding('N8N_EXECUTE_COMMAND')])]));
    const rule = sarif.runs[0]!.tool.driver.rules![0]!;

    expect(rule.properties?.tags).toContain('external/cwe/cwe-078');
  });

  it('tags an agentic rule with its OWASP Agentic category as well as its CWE', () => {
    const sarif = sarifOf(document([result('workflow.json', [finding('AI_AGENT_UNGATED_TOOL')])]));
    const tags = sarif.runs[0]!.tool.driver.rules![0]!.properties?.tags ?? [];

    expect(tags).toContain('external/cwe/cwe-269');
    expect(tags.some((tag) => tag.startsWith('owasp-agentic/'))).toBe(true);
  });

  it('omits tags entirely for a policy ID the catalogue does not know', () => {
    // A synthetic or test policy ID must not produce an empty `tags` array that
    // reads as "reviewed, no CWE applies".
    const sarif = sarifOf(document([result('workflow.json', [finding('NOT_A_REAL_RULE')])]));

    expect(sarif.runs[0]!.tool.driver.rules![0]!.properties?.tags).toBeUndefined();
  });

  it('sorts findings and rule descriptors by stable identifiers', () => {
    const sarif = sarifOf(document([result('workflow.json', [finding('Z_RULE'), finding('A_RULE')])]));
    const run = sarif.runs[0]!;

    expect(run.results.map((item) => item.ruleId)).toEqual(['A_RULE', 'Z_RULE']);
    expect(run.tool.driver.rules?.map((rule) => rule.id)).toEqual(['A_RULE', 'Z_RULE']);
  });

  it('omits locations without source spans and maps complete spans when present', () => {
    const sarif = sarifOf(document([result('workflow.json', [
      finding('NO_SPAN'),
      finding('WITH_SPAN', 'With span', { start: { line: 2, column: 3, offset: 18 }, end: { line: 2, column: 12, offset: 27 } }),
    ])]));
    const [withoutSpan, withSpan] = sarif.runs[0]!.results;

    expect(withoutSpan!.locations).toBeUndefined();
    expect(withSpan!.locations).toEqual([{
      physicalLocation: {
        artifactLocation: { uri: 'workflow.json' },
        region: { startLine: 2, startColumn: 3, endLine: 2, endColumn: 12, charOffset: 18, charLength: 9 },
      },
    }]);
  });

  it('emits machine-readable notifications for input, internal, and cancelled items', () => {
    const sarif = sarifOf(document([
      { input: 'bad.json', ok: false, error: { kind: 'input', code: 'INVALID_JSON', message: 'Invalid JSON.' } },
      { input: 'broken.json', ok: false, error: { kind: 'internal', code: 'WORKER_FAILED', message: 'Worker failed.' } },
      { input: 'stopped.json', ok: false, error: { kind: 'cancelled', code: 'CANCELLED', message: 'Scan cancelled.' } },
    ]));
    const notifications = sarif.runs[0]!.invocations[0]!.toolExecutionNotifications!;

    expect(sarif.runs[0]!.invocations[0]).toMatchObject({ executionSuccessful: false });
    expect(notifications).toEqual([
      { descriptor: { id: 'INVALID_JSON' }, message: { text: 'bad.json: Invalid JSON.' }, properties: { input: 'bad.json', kind: 'input', code: 'INVALID_JSON' } },
      { descriptor: { id: 'WORKER_FAILED' }, message: { text: 'broken.json: Worker failed.' }, properties: { input: 'broken.json', kind: 'internal', code: 'WORKER_FAILED' } },
      { descriptor: { id: 'CANCELLED' }, message: { text: 'stopped.json: Scan cancelled.' }, properties: { input: 'stopped.json', kind: 'cancelled', code: 'CANCELLED' } },
    ]);
    expect(validateSarifDocument(sarif)).toEqual({ ok: true });
  });

  it('marks SARIF execution unsuccessful when a scan is indeterminate', () => {
    const value = document([indeterminateResult('incomplete.json')]);
    const sarif = sarifOf(value);

    expect(validateCliJsonDocument(JSON.parse(formatScanOutput(value, 'json')))).toEqual({ ok: true });
    expect(validateSarifDocument(sarif)).toEqual({ ok: true });
    expect(sarif.runs[0]!.invocations[0]!.executionSuccessful).toBe(false);
  });

  it('is byte-identical across repeated runs', () => {
    const value = document([result('workflow.json', [finding('B_RULE'), finding('A_RULE')])]);

    expect(formatScanOutput(value, 'sarif')).toBe(formatScanOutput(value, 'sarif'));
  });
});

describe('CLI table output', () => {
  it('keeps columns aligned for long input names', () => {
    const value = document([
      result('short.json', []),
      result('a-very-long-workflow-file-name.json', [finding('LONG_RULE')]),
    ]);

    const lines = formatScanOutput(value, 'table').trimEnd().split('\n');
    expect(lines[0]).toContain('Input');
    expect(lines[1]).toMatch(/^[- ]+$/);
    expect(lines[2]!.indexOf('COMPLETE')).toBe(lines[3]!.indexOf('COMPLETE'));
    expect(lines[2]!.indexOf('0')).toBeGreaterThan(lines[2]!.indexOf('COMPLETE'));
  });

  it('adds status color only when explicitly requested for a TTY', () => {
    const value = document([result('workflow.json', [])]);
    expect(formatScanOutput(value, 'table', { color: true })).toContain('\u001b[32mCOMPLETE\u001b[39m');
    expect(formatScanOutput(value, 'table', { color: false })).not.toContain('\u001b[');
    expect(formatScanOutput(value, 'table')).not.toContain('\u001b[');
  });

  it('escapes control characters in untrusted table cells', () => {
    const value = document([{
      input: 'workflow\n\u001b[31m.json', ok: false,
      error: { kind: 'input', code: 'BAD\tCODE', message: 'Invalid.' },
    }]);
    const output = formatScanOutput(value, 'table');
    expect(output).toContain('workflow\\n\\u001b[31m.json');
    expect(output).toContain('BAD\\tCODE');
    expect(output).not.toContain('\u001b[');
    expect(output.trimEnd().split('\n')).toHaveLength(3);
  });
});
