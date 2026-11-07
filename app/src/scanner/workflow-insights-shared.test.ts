import { describe, expect, it } from 'vitest';
import {
  classifyComplexity,
  complexityWeight,
  summarizeIntegrations,
} from './workflow-insights';
import {
  classifyComplexity as coreClassifyComplexity,
  complexityWeight as coreComplexityWeight,
  summarizeIntegrations as coreSummarizeIntegrations,
} from '@hub/scanner-core/workflow-insights';
import { analyzeWorkflowInsights as coreAnalyzeWorkflowInsights } from '@hub/scanner-core/scan-insights';
import { assessWorkflowRisk as coreAssessWorkflowRisk } from '@hub/scanner-core/scan-risk';
import { createHumanReadableScanSummary as coreCreateHumanReadableScanSummary } from '@hub/scanner-core/human-summary';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { analyzeWorkflowInsights, assessWorkflowRisk } from './workflow-insights';
import { createHumanReadableScanSummary } from './human-summary';
import type { NormalizedWorkflowNode } from '@hub/scanner-core/workflow';

function node(type: string, id = type): NormalizedWorkflowNode {
  return { id, name: id, type, parameters: {}, sourcePath: '' };
}

describe('app workflow-insight compatibility exports', () => {
  it('keeps threshold helpers aligned with scanner-core', () => {
    const cases: ReadonlyArray<readonly [number, number, number]> = [
      [5, 7, 3],
      [6, 7, 3],
      [5, 8, 3],
      [5, 7, 4],
      [15, 7, 3],
      [5, 20, 3],
      [5, 7, 8],
    ];
    for (const values of cases) {
      expect(classifyComplexity(...values)).toBe(coreClassifyComplexity(...values));
      expect(complexityWeight(classifyComplexity(...values))).toBe(
        coreComplexityWeight(coreClassifyComplexity(...values)),
      );
    }
  });

  it('keeps the app export representative integration output identical to core', () => {
    const nodes = [
      node('n8n-nodes-base.slack', 'slack-1'),
      node('n8n-nodes-base.httpRequest', 'http-1'),
      node('n8n-nodes-base.slack', 'slack-2'),
      node('n8n-nodes-base.webhook', 'webhook-1'),
    ];

    expect(summarizeIntegrations(nodes)).toEqual(coreSummarizeIntegrations(nodes));
  });

  it('keeps app insights, risk scoring, and human summary byte-identical to core', () => {
    const parsed = parseWorkflowJson(JSON.stringify({
      name: 'Parity workflow',
      nodes: [
        node('n8n-nodes-base.webhook', 'webhook-1'),
        node('n8n-nodes-base.httpRequest', 'http-1'),
        node('n8n-nodes-base.stickyNote', 'note-1'),
      ],
      connections: {},
    }));
    if (!parsed.ok) throw new Error(parsed.message);

    const appInsights = analyzeWorkflowInsights(parsed.workflow);
    const coreInsights = coreAnalyzeWorkflowInsights(parsed.workflow as unknown as Parameters<typeof coreAnalyzeWorkflowInsights>[0]);
    expect(appInsights).toEqual(coreInsights);

    const finding = {
      policyId: 'RAW_SECRET_INDICATOR', title: 'Secret', severity: 'HIGH' as const,
      location: { nodeId: 'http-1' }, evidence: {}, message: 'Review it.',
      explanation: 'A value needs review.', whyItMatters: 'It can grant access.',
      possibleImpact: 'Unauthorized access.', remediation: 'Use a credential.',
      remediationSteps: ['Rotate it.'], confidence: 'HIGH' as const,
    };
    const appRisk = assessWorkflowRisk(parsed.workflow, [finding], appInsights);
    const coreRisk = coreAssessWorkflowRisk(
      parsed.workflow as unknown as Parameters<typeof coreAssessWorkflowRisk>[0],
      [finding],
      coreInsights,
    );
    expect(appRisk).toEqual(coreRisk);

    const appSummary = createHumanReadableScanSummary({
      ...appInsights, riskAssessment: appRisk,
      summary: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, findings: [finding],
    });
    const coreSummary = coreCreateHumanReadableScanSummary({
      ...coreInsights, riskAssessment: coreRisk,
      summary: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, findings: [finding],
    });
    expect(appSummary).toEqual(coreSummary);
  });
});
