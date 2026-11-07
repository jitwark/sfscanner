import {
  analyzeWorkflowInsights as analyzeCoreInsights,
  type WorkflowFunctionSummary,
  type WorkflowInsights,
  type WorkflowOverview,
  type WorkflowRiskGrade,
} from '@hub/scanner-core/scan-insights';
import {
  assessWorkflowRisk as assessCoreRisk,
  type WorkflowRiskAssessment,
} from '@hub/scanner-core/scan-risk';
import type { NormalizedWorkflow } from '@hub/scanner-core/workflow';
import type { ScanFinding } from '@hub/scanner-core/policy';

export type { WorkflowFunctionSummary, WorkflowInsights, WorkflowOverview, WorkflowRiskGrade };
export type { WorkflowComplexity, WorkflowIntegration } from '@hub/scanner-core/workflow-insights';
export {
  classifyComplexity,
  complexityWeight,
  serviceNameFromType,
  summarizeIntegrations,
} from '@hub/scanner-core/workflow-insights';
export type { WorkflowRiskAssessment } from '@hub/scanner-core/scan-risk';

/** Compatibility adapter for the browser scanner's scanner-core workflow type. */
export function analyzeWorkflowInsights(workflow: NormalizedWorkflow): WorkflowInsights {
  return analyzeCoreInsights(workflow as unknown as Parameters<typeof analyzeCoreInsights>[0]);
}

/** Compatibility adapter that keeps risk scoring in scanner-core. */
export function assessWorkflowRisk(
  workflow: NormalizedWorkflow,
  findings: readonly ScanFinding[],
  insights: WorkflowInsights,
): WorkflowRiskAssessment {
  return assessCoreRisk(
    workflow as unknown as Parameters<typeof assessCoreRisk>[0],
    findings as unknown as Parameters<typeof assessCoreRisk>[1],
    insights,
  );
}
