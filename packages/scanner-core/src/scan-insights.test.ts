import { describe, expect, it } from 'vitest';
import { createHumanReadableScanSummary } from './human-summary';
import { redactScanPresentation } from './presentation-redaction';
import {
  analyzeWorkflowInsights,
} from './scan-insights';
import { assessWorkflowRisk } from './scan-risk';
import { parseWorkflowJson } from './workflow';

const SECRET = 'sk_live_core_fixture_secret';

function parseWorkflow() {
  const parsed = parseWorkflowJson(JSON.stringify({
    name: 'Lead intake alerts',
    nodes: [
      { id: 'webhook-1', name: 'Lead webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
      { id: 'http-1', name: 'Enrich lead', type: 'n8n-nodes-base.httpRequest', parameters: {} },
      { id: 'note-1', name: 'Comment', type: 'n8n-nodes-base.stickyNote', parameters: {} },
    ],
    connections: {
      'Lead webhook': { main: [[{ node: 'Enrich lead', type: 'main', index: 0 }]] },
    },
  }));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.workflow;
}

describe('shared scanner result presentation', () => {
  it('builds one deterministic insight and risk contract from a normalized workflow', () => {
    const workflow = parseWorkflow();
    const insights = analyzeWorkflowInsights(workflow);
    const finding = {
      policyId: 'RAW_SECRET_INDICATOR',
      title: 'Hard-coded secret',
      severity: 'HIGH' as const,
      location: { nodeId: 'http-1', nodeName: 'Enrich lead' },
      evidence: {},
      message: 'Review the value.',
      explanation: 'A secret-shaped value was found.',
      whyItMatters: 'It may grant access.',
      possibleImpact: 'Unauthorized access.',
      remediation: 'Use managed credentials.',
      remediationSteps: ['Rotate the value.'],
      confidence: 'HIGH' as const,
      policyEffect: 'LEGACY_SCORE' as const,
    };

    expect(insights.workflow).toMatchObject({
      name: 'Lead intake alerts',
      nodeCount: 2,
      rawNodeCount: 3,
      annotationNodeCount: 1,
      triggerCount: 1,
      integrationCount: 2,
      complexity: 'LOW',
    });
    expect(assessWorkflowRisk(workflow, [finding], insights)).toEqual({
      score: 35,
      grade: 'MEDIUM',
      topRisks: ['Hard-coded secret'],
      dataExposure: '2 node(s) can receive data from or send data to external systems.',
      complexityDrivers: ['Small workflow shape by beta complexity thresholds.'],
    });
  });

  it('builds the human summary and redacts every presentation string centrally', () => {
    const workflow = parseWorkflow();
    const insights = analyzeWorkflowInsights(workflow);
    const riskAssessment = assessWorkflowRisk(workflow, [], insights);
    const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as const;
    const humanSummary = createHumanReadableScanSummary({
      ...insights,
      riskAssessment,
      summary,
      findings: [],
    });

    expect(humanSummary.plainLanguageOverview).toContain('uses HTTP Request');
    expect(humanSummary.riskNarrative).toContain('no findings');
    expect(redactScanPresentation({ name: SECRET, humanSummary })).toEqual({
      name: '[REDACTED]',
      humanSummary: expect.objectContaining({
        plainLanguageOverview: expect.not.stringContaining(SECRET),
      }),
    });
  });
});
