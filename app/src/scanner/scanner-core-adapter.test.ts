import { describe, expect, it } from 'vitest';
import type { CoreAnalyzer } from '@hub/scanner-core/engine';
import { resolvePolicyProfile } from '@hub/scanner-core/policies/profile';
import { parseWorkflowJson, type NormalizedWorkflow } from '@hub/scanner-core/workflow';
import type { ScanPolicy } from '@hub/scanner-core/policy';
import { createAnalyzers, scanWithScannerCore } from './scanner-core-adapter';

function workflowOf(nodes: unknown[], connections: Record<string, unknown> = {}) {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.workflow;
}

function hardenedProfile() {
  const profile = resolvePolicyProfile('beta-hardened');
  if (!profile.ok) throw new Error(`Unknown scanner profile: ${profile.profileId}`);
  return profile;
}

describe('scanWithScannerCore', () => {
  it('uses package analyzers only for the hardened profile', () => {
    const workflow = workflowOf([
      {
        id: 'code-1',
        name: 'Dynamic code',
        type: 'n8n-nodes-base.code',
        parameters: { jsCode: 'return eval(input);' },
      },
    ]);

    const beta = scanWithScannerCore(workflow, { profileId: 'beta-default' });
    const hardened = scanWithScannerCore(workflow, { profileId: 'beta-hardened' });

    expect(beta.findings.map(({ policyId }) => policyId)).not.toContain('JAVASCRIPT_DYNAMIC_EXECUTION');
    expect(hardened.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ policyId: 'JAVASCRIPT_DYNAMIC_EXECUTION', policyEffect: 'REPORT_ONLY' }),
    ]));
  });

  it('adapts an app policy factory without bypassing core canonicalization', () => {
    const policy: ScanPolicy = {
      id: 'TEST_POLICY',
      name: 'Test policy',
      description: 'Test policy',
      evaluate: (workflow) => workflow.nodes.map((node) => ({
        policyId: 'TEST_POLICY',
        title: 'Test finding',
        severity: 'LOW' as const,
        location: { nodeId: node.id, nodeName: node.name, path: node.sourcePath },
        evidence: {},
        message: 'Test message',
        explanation: 'Test explanation',
        whyItMatters: 'Test importance',
        possibleImpact: 'Test impact',
        remediation: 'Test remediation',
        remediationSteps: ['Test step'],
        confidence: 'HIGH' as const,
      })),
    };

    const result = scanWithScannerCore(workflowOf([
      { id: 'manual-1', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
    ]), {
      profileId: 'beta-default',
      policies: [policy],
    });

    expect(result.findings).toEqual([
      expect.objectContaining({ policyId: 'TEST_POLICY', policyEffect: 'LEGACY_SCORE' }),
    ]);
    expect(result.summary.low).toBe(1);
  });
});

describe('createAnalyzers', () => {
  const webhook = { id: 'w', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} };
  const agent = { id: 'a', name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent', parameters: {} };
  const tool = { id: 't', name: 'Tool', type: 'n8n-nodes-base.httpRequestTool', parameters: {} };
  const connections = {
    Webhook: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
    Tool: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
  };

  /** Collects analyzer findings the way the engine does: once per analyzer, in list order. */
  function aiFindings(analyzers: readonly CoreAnalyzer[], workflow: NormalizedWorkflow) {
    return analyzers
      .flatMap((analyzer) => analyzer(workflow).findings)
      .filter((finding) => finding.policyId === 'AI_AGENT_UNGATED_TOOL');
  }

  it('produces the same AI-capability findings whichever order the engine runs the analyzers', () => {
    const workflow = workflowOf([webhook, agent, tool], connections);
    // The engine builds its analyzer list once per scan, so each order gets a fresh list rather than
    // reusing one whose state an earlier run may already have written.
    const run = (order: 'declared' | 'reversed') => {
      const analyzers = createAnalyzers(hardenedProfile());
      return aiFindings(order === 'reversed' ? [...analyzers].reverse() : analyzers, workflow);
    };

    expect(run('declared')).toEqual([
      expect.objectContaining({ policyId: 'AI_AGENT_UNGATED_TOOL', location: expect.objectContaining({ nodeName: 'Agent' }) }),
    ]);
    expect(run('reversed')).toEqual(run('declared'));
  });
});
