import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import type { ScanPolicy } from '@hub/scanner-core/policy';
import { MAX_HARDENED_FINDINGS_PER_SCAN, scanWorkflow } from './engine';
import { nodeFinding } from '@hub/scanner-core/policy-helpers';
import type { PolicyProfileId } from '@hub/scanner-core/policies/profile';

function workflowWithNodes(nodes: unknown[]): string {
  return JSON.stringify({
    name: 'Policy fixture',
    nodes,
    connections: {},
  });
}

function scanNodes(nodes: unknown[], options: Parameters<typeof scanWorkflow>[1] = {}) {
  const parsed = parseWorkflowJson(workflowWithNodes(nodes));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }

  return scanWorkflow(parsed.workflow, options);
}

describe('scanWorkflow', () => {
  it('returns no findings for a minimal safe workflow', () => {
    const nodes = [
      {
        id: 'manual-1',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        parameters: {},
      },
    ];
    const result = scanNodes(nodes);
    const hardened = scanNodes(nodes, { policyProfile: 'beta-hardened' });

    expect(result.findings).toEqual([]);
    expect(result.summary).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    });
    expect(result.analysisStatus).toBe('COMPLETE');
    expect(result.analysisDiagnostics).toEqual([]);
    expect(hardened.analysisStatus).toBe('COMPLETE');
    expect(hardened.analysisDiagnostics).toEqual([]);
  });

  it('adds source spans only for the hardened profile', () => {
    const parsed = parseWorkflowJson(workflowWithNodes([
      {
        id: 'cmd-1', name: 'Run shell', type: 'n8n-nodes-base.executeCommand',
        parameters: { command: 'echo hello' },
      },
    ]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const beta = scanWorkflow(parsed.workflow);
    const hardened = scanWorkflow(parsed.workflow, { policyProfile: 'beta-hardened' });

    expect(beta.policyProfile).toBe('beta-default');
    expect(beta.findings[0].location.sourceSpan).toBeUndefined();
    expect(hardened.policyProfile).toBe('beta-hardened');
    expect(hardened.findings[0].location.sourceSpan).toEqual(parsed.workflow.nodes[0].sourceSpan);
  });

  it('omits an ambiguous source span and degrades instead of silently dropping it', () => {
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes: [
        { id: 'dup', name: 'First', type: 'n8n-nodes-base.executeCommand', parameters: { command: 'ls' } },
        { id: 'dup', name: 'Second', type: 'n8n-nodes-base.noOp', parameters: {} },
      ],
      connections: {},
    }));
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow, { policyProfile: 'beta-hardened' });

    const finding = result.findings.find((candidate) => candidate.policyId === 'N8N_EXECUTE_COMMAND');
    expect(finding?.location.sourceSpan).toBeUndefined();
    expect(result.analysisStatus).toBe('DEGRADED');
    expect(result.analysisDiagnostics).toContainEqual({ code: 'SOURCE_SPAN_UNAVAILABLE', category: 'SOURCE' });
  });

  it('degrades when the submitted workflow contains duplicate JSON keys', () => {
    const parsed = parseWorkflowJson('{"nodes":[],"nodes":[],"connections":{}}');
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow, { policyProfile: 'beta-hardened' });

    expect(result.analysisStatus).toBe('DEGRADED');
    expect(result.analysisDiagnostics).toContainEqual({ code: 'DUPLICATE_JSON_KEY', category: 'SOURCE' });
  });

  it('adds JavaScript indicators only to the hardened profile without changing the legacy risk grade', () => {
    const parsed = parseWorkflowJson(workflowWithNodes([
      { id: 'code-1', name: 'Dynamic code', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return eval(input);' } },
    ]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const beta = scanWorkflow(parsed.workflow, { policyProfile: 'beta-default' });
    const hardened = scanWorkflow(parsed.workflow, { policyProfile: 'beta-hardened' });

    expect(beta.findings.map((finding) => finding.policyId)).not.toContain('JAVASCRIPT_DYNAMIC_EXECUTION');
    expect(hardened.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ policyId: 'JAVASCRIPT_DYNAMIC_EXECUTION', evidence: { indicator: 'EVAL', start: expect.any(Number), end: expect.any(Number) } }),
    ]));
    expect(hardened.riskAssessment).toEqual(beta.riskAssessment);
  });

  it('adds taint findings only to the hardened profile, report-only and without changing the grade', () => {
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes: [
        { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
        { id: 's', name: 'Runner', type: 'n8n-nodes-base.executeCommand', parameters: { command: '={{ $json.cmd }}' } },
      ],
      connections: { Webhook: { main: [[{ node: 'Runner', type: 'main', index: 0 }]] } },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const beta = scanWorkflow(parsed.workflow, { policyProfile: 'beta-default' });
    const hardened = scanWorkflow(parsed.workflow, { policyProfile: 'beta-hardened' });

    expect(beta.findings.map((finding) => finding.policyId)).not.toContain('TAINTED_COMMAND');
    expect(hardened.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ policyId: 'TAINTED_COMMAND', policyEffect: 'REPORT_ONLY' }),
    ]));
    expect(hardened.riskAssessment).toEqual(beta.riskAssessment);
    expect(hardened.summary).not.toEqual(beta.summary);
  });

  it('suppresses the hardened grade for an unreviewed trigger-shaped node', () => {
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes: [
        { id: 'u', name: 'Unreviewed', type: 'n8n-nodes-base.unreviewedTrigger', parameters: {} },
        { id: 's', name: 'Runner', type: 'n8n-nodes-base.executeCommand', parameters: { command: '={{ $json.cmd }}' } },
      ],
      connections: { Unreviewed: { main: [[{ node: 'Runner', type: 'main', index: 0 }]] } },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow, { policyProfile: 'beta-hardened' });

    expect(result.findings.map((finding) => finding.policyId)).not.toContain('TAINTED_COMMAND');
    expect(result.analysisDiagnostics).toContainEqual({
      code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY', location: { path: '/nodes/0' },
    });
    expect(result.analysisStatus).toBe('INDETERMINATE');
    expect(result.riskAssessment).toBeUndefined();
    expect(result.humanSummary).toBeUndefined();
    expect(result.summary).toBeUndefined();
  });

  it('reports an ungated AI agent only in the hardened profile', () => {
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes: [
        { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
        { id: 'a', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', parameters: {} },
        { id: 't', name: 'Tool', type: 'n8n-nodes-base.httpRequestTool', parameters: {} },
      ],
      connections: {
        Webhook: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
        Tool: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
      },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const beta = scanWorkflow(parsed.workflow, { policyProfile: 'beta-default' });
    const hardened = scanWorkflow(parsed.workflow, { policyProfile: 'beta-hardened' });

    expect(beta.findings.map((finding) => finding.policyId)).not.toContain('AI_AGENT_UNGATED_TOOL');
    expect(hardened.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ policyId: 'AI_AGENT_UNGATED_TOOL', policyEffect: 'REPORT_ONLY' }),
    ]));
    expect(hardened.riskAssessment).toEqual(beta.riskAssessment);
  });

  it('suppresses the grade when the expression stage cannot read a unit', () => {
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes: [
        { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
        { id: 's', name: 'Runner', type: 'n8n-nodes-base.executeCommand', parameters: { command: '={{ $json.( }}' } },
      ],
      connections: { Webhook: { main: [[{ node: 'Runner', type: 'main', index: 0 }]] } },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow, { policyProfile: 'beta-hardened' });

    expect(result.analysisDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY', location: { path: '/nodes/1' } }),
    );
    expect(result.analysisStatus).toBe('INDETERMINATE');
    expect(result.riskAssessment).toBeUndefined();
    expect(result.humanSummary).toBeUndefined();
    expect(result.summary).toBeUndefined();
  });

  it('adds Python indicators only to the hardened profile without changing the legacy risk grade', () => {
    const parsed = parseWorkflowJson(workflowWithNodes([
      {
        id: 'code-1', name: 'Dynamic Python', type: 'n8n-nodes-base.code', typeVersion: 2,
        parameters: { language: 'pythonNative', pythonCode: 'exec(payload)' },
      },
    ]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const beta = scanWorkflow(parsed.workflow, { policyProfile: 'beta-default' });
    const hardened = scanWorkflow(parsed.workflow, { policyProfile: 'beta-hardened' });

    expect(beta.findings.map((finding) => finding.policyId)).not.toContain('PYTHON_DYNAMIC_EXECUTION');
    expect(hardened.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ policyId: 'PYTHON_DYNAMIC_EXECUTION', evidence: { indicator: 'EXEC', start: expect.any(Number), end: expect.any(Number) } }),
    ]));
    expect(hardened.riskAssessment).toEqual(beta.riskAssessment);
  });

  it('suppresses the grade when JavaScript cannot be parsed instead of grading unknown coverage', () => {
    const parsed = parseWorkflowJson(workflowWithNodes([
      { id: 'code-1', name: 'Broken code', type: 'n8n-nodes-base.code', parameters: { jsCode: 'const = ;' } },
    ]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow, { policyProfile: 'beta-hardened' });

    expect(result.analysisStatus).toBe('INDETERMINATE');
    expect(result.analysisDiagnostics).toContainEqual({ code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY', location: { path: '/nodes/0' } });
    expect(result.analysisDiagnostics.map((diagnostic) => diagnostic.code)).not.toContain('JAVASCRIPT_PARSE_FAILED');
    expect(result.riskAssessment).toBeUndefined();
    expect(result.humanSummary).toBeUndefined();
    expect(result.summary).toBeUndefined();
  });

  it('suppresses the grade when a code-node stage cannot read its source at all', () => {
    const parsed = parseWorkflowJson(workflowWithNodes([
      { id: 'odd-1', name: 'Odd logic', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { language: 'ruby', jsCode: 'eval(input)' } },
      { id: 'py-1', name: 'Python logic', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { language: 'pythonNative' } },
    ]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow, { policyProfile: 'beta-hardened' });

    expect(result.analysisStatus).toBe('INDETERMINATE');
    expect(result.analysisDiagnostics).toContainEqual({ code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY', location: { path: '/nodes/0' } });
    expect(result.analysisDiagnostics).toContainEqual({ code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY', location: { path: '/nodes/1' } });
    expect(result.riskAssessment).toBeUndefined();
    expect(result.humanSummary).toBeUndefined();
    expect(result.summary).toBeUndefined();
  });

  it('keeps the grade for cosmetic omissions and analyzer caps', () => {
    const nodes = Array.from({ length: 20 }, (_, index) => ({
      id: `code-${index}`, name: `Code ${index}`, type: 'n8n-nodes-base.code', typeVersion: 2,
      parameters: { language: 'javaScript', jsCode: 'eval(a);\n'.repeat(10) },
    }));

    const result = scanNodes(nodes, { policyProfile: 'beta-hardened' });

    // Truncation at the per-scan cap is an omission, not a failed stage: the scan still
    // reports a grade, and the diagnostic is the limit's own DEGRADED-class code.
    expect(result.analysisStatus).toBe('DEGRADED');
    expect(result.analysisDiagnostics).toContainEqual({ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' });
    expect(result.riskAssessment).toBeDefined();
    expect(result.humanSummary).toBeDefined();
    expect(result.summary).toBeDefined();
  });

  it('caps hardened findings per scan and degrades when it truncates', () => {
    const nodes = Array.from({ length: 20 }, (_, index) => ({
      id: `code-${index}`, name: `Code ${index}`, type: 'n8n-nodes-base.code', typeVersion: 2,
      parameters: { language: 'javaScript', jsCode: 'eval(a);\n'.repeat(10) },
    }));

    const result = scanNodes(nodes, { policyProfile: 'beta-hardened' });

    expect(result.findings.filter((finding) => finding.policyId === 'JAVASCRIPT_DYNAMIC_EXECUTION'))
      .toHaveLength(MAX_HARDENED_FINDINGS_PER_SCAN);
    expect(result.analysisStatus).toBe('DEGRADED');
    expect(result.analysisDiagnostics).toContainEqual({ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' });
  });

  it('does not emit a per-scan limit diagnostic when hardened findings fit the cap', () => {
    const result = scanNodes([
      {
        id: 'code-1', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2,
        parameters: { language: 'javaScript', jsCode: 'eval(a);\n'.repeat(10) },
      },
    ], { policyProfile: 'beta-hardened' });

    expect(result.findings.filter((finding) => finding.policyId === 'JAVASCRIPT_DYNAMIC_EXECUTION'))
      .toHaveLength(10);
    expect(result.analysisStatus).toBe('COMPLETE');
    expect(result.analysisDiagnostics).toEqual([]);
  });

  it('marks graph-dependent analysis degraded when connections are invalid', () => {
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes: [
        { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger' },
        { id: 'finish', name: 'Finish', type: 'n8n-nodes-base.noOp' },
      ],
      connections: { Missing: { main: [[{ node: 'Finish' }]] } },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow);

    expect(result.analysisStatus).toBe('DEGRADED');
    expect(result.analysisDiagnostics).toEqual([
      { code: 'GRAPH_ANALYSIS_DEGRADED', category: 'GRAPH' },
    ]);
  });

  it('reports one source-free diagnostic for any unclassified connection edges', () => {
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes: [
        { id: 'source', name: 'Source', type: 'n8n-nodes-base.code', parameters: {} },
        { id: 'target', name: 'Target', type: 'n8n-nodes-base.code', parameters: {} },
      ],
      connections: {
        Source: {
          ai_chain: [[{ node: 'Target', type: 'ai_chain', index: 0 }]],
          ai_future: [[{ node: 'Target', type: 'ai_future', index: 0 }]],
        },
      },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow);

    expect(result.analysisDiagnostics).toEqual([
      { code: 'UNCLASSIFIED_CONNECTION_TYPE', category: 'GRAPH' },
    ]);
    expect(JSON.stringify(result.analysisDiagnostics)).not.toContain('ai_chain');
    expect(JSON.stringify(result.analysisDiagnostics)).not.toContain('Source');
    expect(JSON.stringify(result.analysisDiagnostics)).not.toContain('Target');
  });

  it('marks the scan indeterminate when a policy emits a malformed finding', () => {
    const parsed = parseWorkflowJson(workflowWithNodes([
      { id: 'manual-1', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger' },
    ]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const policies: ScanPolicy[] = [{
      id: 'test-policy', name: 'Test policy', description: 'Test only',
      evaluate: () => [
        {
          policyId: 'VALID_POLICY', title: 'Valid', severity: 'LOW', location: {}, evidence: {},
          message: 'Message', explanation: 'Explanation', whyItMatters: 'Why',
          possibleImpact: 'Impact', remediation: 'Fix', remediationSteps: ['Fix'], confidence: 'HIGH',
        },
        { policyId: 'BROKEN_POLICY', severity: 'HIGH' },
      ] as unknown as ReturnType<ScanPolicy['evaluate']>,
    }];

    const result = scanWorkflow(parsed.workflow, { policyFactory: () => policies });

    expect(result.findings.map((finding) => finding.policyId)).toEqual(['VALID_POLICY']);
    expect(result.analysisStatus).toBe('INDETERMINATE');
    expect(result.analysisDiagnostics).toContainEqual({ code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' });
  });

  it('isolates a throwing policy, keeps the other findings, and still marks the scan indeterminate', () => {
    const throwing: ScanPolicy = {
      id: 'BOOM', name: 'Boom', description: 'throws',
      evaluate: () => { throw new Error('secret-value-abc123 leaked in message'); },
    };
    const working: ScanPolicy = {
      id: 'OK', name: 'Ok', description: 'works',
      evaluate: (workflow) => [nodeFinding({
        policyId: 'OK', severity: 'LOW', node: workflow.nodes[0],
        evidence: {}, message: 'fine', remediation: 'none',
      })],
    };

    const result = scanNodes([
      { id: 'manual-1', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger' },
    ], { policyFactory: () => [throwing, working] });

    expect(result.findings.map((finding) => finding.policyId)).toEqual(['OK']);
    expect(result.analysisStatus).toBe('INDETERMINATE');
    expect(result.analysisDiagnostics).toEqual([{ code: 'POLICY_EXECUTION_FAILED', category: 'POLICY' }]);
    expect(JSON.stringify(result)).not.toContain('secret-value-abc123');
  });

  it('never carries a risk grade or human summary when a scoring policy crashed', () => {
    const throwing: ScanPolicy = {
      id: 'BOOM', name: 'Boom', description: 'throws',
      evaluate: () => { throw new Error('boom'); },
    };

    const result = scanNodes([
      { id: 'manual-1', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger' },
    ], { policyFactory: () => [throwing] });

    expect(result.analysisStatus).toBe('INDETERMINATE');
    expect(result.riskAssessment).toBeUndefined();
    expect(result.humanSummary).toBeUndefined();
    expect(result.summary).toBeUndefined();
  });

  it('marks the scan indeterminate, not merely degraded, when a node has malformed parameters', () => {
    const parsed = parseWorkflowJson(workflowWithNodes([
      { id: 'n', name: 'Node', type: 'n8n-nodes-base.noOp', parameters: 'not-an-object' },
    ]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    const result = scanWorkflow(parsed.workflow);

    expect(result.analysisStatus).toBe('INDETERMINATE');
    expect(result.analysisDiagnostics).toContainEqual({
      code: 'MALFORMED_NODE_PARAMETERS',
      category: 'SOURCE',
      location: { path: '/nodes/0/parameters' },
    });
    expect(result.riskAssessment).toBeUndefined();
    expect(result.humanSummary).toBeUndefined();
    expect(result.summary).toBeUndefined();
  });

  it('still throws for an unknown internal profile because that is a programmer error', () => {
    const parsed = parseWorkflowJson(workflowWithNodes([]));
    if (!parsed.ok) throw new Error(parsed.message);

    expect(() => scanWorkflow(parsed.workflow, { policyProfile: 'nope' as PolicyProfileId }))
      .toThrow(/Unknown scanner profile/);
  });

  it('flags Execute Command nodes as critical', () => {
    const result = scanNodes([
      {
        id: 'cmd-1',
        name: 'Run shell',
        type: 'n8n-nodes-base.executeCommand',
        parameters: { command: 'rm -rf /tmp/example' },
      },
    ]);

    expect(result.findings).toMatchObject([
      {
        policyId: 'N8N_EXECUTE_COMMAND',
        title: 'Execute Command node can run shell commands',
        severity: 'CRITICAL',
        location: { nodeId: 'cmd-1', nodeName: 'Run shell' },
        confidence: 'HIGH',
      },
    ]);
    expect(result.findings[0].explanation).toContain('shell command');
    expect(result.findings[0].whyItMatters).toContain('host');
    expect(result.findings[0].possibleImpact).toContain('command execution');
    expect(result.findings[0].remediationSteps).toContain(
      'Remove the Execute Command node when shell access is not explicitly required.',
    );
    expect(result.humanSummary).toMatchObject({
      headline: expect.stringContaining('critical risk'),
      verdict: expect.stringContaining('Do not move this workflow into production'),
      riskNarrative: expect.stringContaining('1 critical'),
      recommendedActions: expect.arrayContaining([
        'Remove the Execute Command node when shell access is not explicitly required.',
      ]),
      findingHighlights: expect.arrayContaining([
        expect.stringContaining('CRITICAL: Execute Command node can run shell commands'),
      ]),
    });
  });

  it('redacts token-shaped node names from returned finding locations', () => {
    const secret = 'sk_live_abc123456789';
    const result = scanNodes([
      {
        id: 'cmd-1',
        name: `Run ${secret}`,
        type: 'n8n-nodes-base.executeCommand',
        parameters: { command: 'echo hello' },
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].location.nodeName).toBe('Run [REDACTED]');
    expect(JSON.stringify(result.findings)).not.toContain(secret);
  });

  it('returns detailed workflow report sections with the scan result', () => {
    const result = scanNodes([
      {
        id: 'manual-1',
        name: 'Manual Trigger',
        type: 'n8n-nodes-base.manualTrigger',
        parameters: {},
      },
      {
        id: 'http-1',
        name: 'Call CRM',
        type: 'n8n-nodes-base.httpRequest',
        parameters: { url: 'https://crm.example.com/leads' },
      },
      {
        id: 'slack-1',
        name: 'Notify sales',
        type: 'n8n-nodes-base.slack',
        parameters: { channel: '#sales' },
      },
    ]);

    expect(result.workflow).toMatchObject({
      name: 'Policy fixture',
      nodeCount: 3,
      triggerCount: 1,
      actionCount: 2,
      integrationCount: 3,
      complexity: 'LOW',
    });
    expect(result.functionSummary.basicPurpose).toContain('Manual workflow');
    expect(result.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ service: 'Manual Trigger' }),
        expect.objectContaining({ service: 'HTTP Request' }),
        expect.objectContaining({ service: 'Slack' }),
      ]),
    );
    expect(result.riskAssessment).toMatchObject({
      grade: 'LOW',
      score: expect.any(Number),
      dataExposure: expect.any(String),
    });
    expect(result.humanSummary).toMatchObject({
      headline: expect.stringContaining('low risk'),
      verdict: expect.stringContaining('No major beta policy risks'),
      plainLanguageOverview: expect.stringContaining('3 nodes'),
      recommendedActions: expect.arrayContaining([
        expect.stringContaining('Keep this workflow in normal review'),
      ]),
    });
  });

  it('reports Code and Function-style script nodes as low-severity anatomy', () => {
    const result = scanNodes([
      {
        id: 'code-1',
        name: 'Transform with code',
        type: 'n8n-nodes-base.code',
        parameters: { jsCode: 'return items;' },
      },
      {
        id: 'function-1',
        name: 'Legacy function',
        type: 'n8n-nodes-base.functionItem',
        parameters: { functionCode: 'return item;' },
      },
    ]);

    expect(result.findings.map((finding) => finding.policyId)).toEqual([
      'N8N_CODE_NODE',
      'N8N_CODE_NODE',
    ]);
    // Presence of a Code node is anatomy, not a high-severity defect: real code
    // risk is reported by the JavaScript, Python, and taint policies.
    expect(result.summary!.high).toBe(0);
    expect(result.summary!.low).toBe(2);
    expect(result.riskAssessment!.grade).toBe('LOW');
  });

  it('flags raw Authorization headers in HTTP-like nodes', () => {
    const result = scanNodes([
      {
        id: 'http-1',
        name: 'Call API',
        type: 'n8n-nodes-base.httpRequest',
        parameters: {
          url: 'https://api.trusted.example/customers',
          sendHeaders: true,
          headerParameters: {
            parameters: [{ name: 'Authorization', value: 'Bearer hard-coded-token' }],
          },
        },
      },
    ]);
    const serializedResult = JSON.stringify(result);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
        policyId: 'RAW_AUTH_HEADER',
        severity: 'HIGH',
        location: expect.objectContaining({ nodeId: 'http-1' }),
        }),
      ]),
    );
    expect(serializedResult).not.toContain('hard-coded-token');
    expect(serializedResult).not.toContain('Bearer hard-coded-token');
  });

  it('flags raw secret indicators without echoing secret values', () => {
    const result = scanNodes([
      {
        id: 'http-1',
        name: 'Call API',
        type: 'n8n-nodes-base.httpRequest',
        parameters: {
          apiKey: 'sk_live_super_secret_value',
          nested: {
            password: 'plaintext-password',
          },
        },
      },
    ]);
    const serializedResult = JSON.stringify(result);

    expect(result.findings.map((finding) => finding.policyId)).toContain(
      'RAW_SECRET_INDICATOR',
    );
    expect(
      result.findings
        .filter((finding) => finding.policyId === 'RAW_SECRET_INDICATOR')
        .map((finding) => ({
          severity: finding.severity,
          path: finding.evidence.parameterPath,
          kind: finding.evidence.secretKind,
          indicator: finding.evidence.indicator,
        })),
    ).toEqual([
      // The value matches a provider pattern, so it is reported as a confirmed
      // secret and the `apiKey` key name is not reported a second time.
      {
        severity: 'HIGH',
        path: 'parameters.apiKey',
        kind: 'Stripe API key',
        indicator: 'sensitive_value',
      },
      // No provider pattern here: a secret-named key holding an unclassified
      // literal is plausible but unconfirmed.
      {
        severity: 'MEDIUM',
        path: 'parameters.nested.password',
        kind: 'password',
        indicator: 'sensitive_key',
      },
    ]);
    expect(serializedResult).not.toContain('sk_live_super_secret_value');
    expect(serializedResult).not.toContain('plaintext-password');
  });

  it('classifies provider-shaped secret values and ignores dynamic references as values', () => {
    const googleApiKey = `AIza${'A'.repeat(35)}`;
    const result = scanNodes([
      {
        id: 'http-1', name: 'Call API', type: 'n8n-nodes-base.httpRequest',
        parameters: { note: googleApiKey, apiKey: '={{ $env.API_KEY }}' },
      },
    ]);
    const secretFindings = result.findings.filter((finding) => finding.policyId === 'RAW_SECRET_INDICATOR');

    // The expression-valued apiKey is the correct way to write this and must
    // produce no finding at all; only the pasted Google key is reported.
    expect(secretFindings).toEqual([
      expect.objectContaining({
        severity: 'HIGH',
        evidence: expect.objectContaining({ secretKind: 'Google API key', indicator: 'sensitive_value' }),
      }),
    ]);
    expect(
      secretFindings.some((finding) => finding.evidence.parameterPath === 'parameters.apiKey'),
    ).toBe(false);
    expect(JSON.stringify(result)).not.toContain(googleApiKey);
  });

  it('flags external domains outside the approved allowlist', () => {
    const result = scanNodes(
      [
        {
          id: 'http-1',
          name: 'Call unknown API',
          type: 'n8n-nodes-base.httpRequest',
          parameters: { url: 'https://unapproved.example/v1/events' },
        },
      ],
      { approvedDomains: ['api.trusted.example'] },
    );

    expect(result.findings).toMatchObject([
      {
        policyId: 'UNAPPROVED_DOMAIN',
        severity: 'MEDIUM',
        evidence: { domain: 'unapproved.example' },
      },
    ]);
  });

  it('does not flag approved external domains', () => {
    const result = scanNodes(
      [
        {
          id: 'http-1',
          name: 'Call trusted API',
          type: 'n8n-nodes-base.httpRequest',
          parameters: { url: 'https://api.trusted.example/v1/events' },
        },
      ],
      { approvedDomains: ['api.trusted.example'] },
    );

    expect(result.findings).toEqual([]);
  });

  it('reports third-party node packages once each and ignores official namespaces', () => {
    const result = scanNodes([
      {
        id: 'custom-1',
        name: 'Community node',
        type: '@acme/n8n-nodes-risky.customNode',
        parameters: {},
      },
      {
        id: 'custom-2',
        name: 'Same package again',
        type: '@acme/n8n-nodes-risky.otherNode',
        parameters: {},
      },
      {
        id: 'langchain-1',
        name: 'Official AI agent',
        type: '@n8n/n8n-nodes-langchain.agent',
        parameters: {},
      },
    ]);

    // One finding per distinct package, and `@n8n/` ships with n8n itself.
    expect(result.findings).toMatchObject([
      {
        policyId: 'UNKNOWN_NODE_PACKAGE',
        severity: 'LOW',
        location: { nodeId: 'custom-1' },
        evidence: { nodePackage: '@acme/n8n-nodes-risky' },
      },
    ]);
  });


  it('flags webhook triggers without clear authentication markers', () => {
    const result = scanNodes([
      {
        id: 'webhook-1',
        name: 'Public webhook',
        type: 'n8n-nodes-base.webhook',
        parameters: { path: 'lead-submit', authentication: 'none' },
      },
    ]);

    expect(result.findings).toMatchObject([
      {
        policyId: 'WEBHOOK_EXPOSURE',
        severity: 'MEDIUM',
        location: { nodeId: 'webhook-1' },
      },
    ]);
  });
});
