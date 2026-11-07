import {
  createHumanReadableScanSummary as createCoreHumanReadableScanSummary,
  type HumanReadableScanSummary,
} from '@hub/scanner-core/human-summary';
import type { ScanFinding, ScanSummary } from '@hub/scanner-core/policy';
import type {
  WorkflowFunctionSummary,
  WorkflowIntegration,
  WorkflowOverview,
  WorkflowRiskAssessment,
} from './workflow-insights';

export type { HumanReadableScanSummary };

/** Compatibility adapter for the browser scanner's app-local result types. */
export function createHumanReadableScanSummary(input: {
  workflow: WorkflowOverview;
  functionSummary: WorkflowFunctionSummary;
  integrations: WorkflowIntegration[];
  riskAssessment: WorkflowRiskAssessment;
  summary: ScanSummary;
  findings: readonly ScanFinding[];
}): HumanReadableScanSummary {
  return createCoreHumanReadableScanSummary(input as Parameters<typeof createCoreHumanReadableScanSummary>[0]);
}
