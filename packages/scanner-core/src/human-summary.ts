import type { ScanFinding, ScanSummary } from './policy/policy';
import type {
  WorkflowFunctionSummary,
  WorkflowInsights,
  WorkflowRiskAssessment,
} from './scan-insights';

export type HumanReadableScanSummary = {
  headline: string;
  verdict: string;
  plainLanguageOverview: string;
  riskNarrative: string;
  recommendedActions: string[];
  findingHighlights: string[];
};

/** Creates the scanner's user-facing prose without model or platform dependencies. */
export function createHumanReadableScanSummary(input: {
  workflow: WorkflowInsights['workflow'];
  functionSummary: WorkflowFunctionSummary;
  integrations: WorkflowInsights['integrations'];
  riskAssessment: WorkflowRiskAssessment;
  summary: ScanSummary;
  findings: readonly ScanFinding[];
}): HumanReadableScanSummary {
  return {
    headline: createHeadline(input.riskAssessment, input.summary),
    verdict: createVerdict(input.riskAssessment),
    plainLanguageOverview: createOverview(input),
    riskNarrative: createRiskNarrative(input.summary, input.riskAssessment),
    recommendedActions: createRecommendedActions(input.findings, input.riskAssessment),
    findingHighlights: createFindingHighlights(input.findings),
  };
}

function createHeadline(riskAssessment: WorkflowRiskAssessment, summary: ScanSummary): string {
  if (summary.critical > 0) return 'This workflow has critical risk and needs immediate security review.';
  switch (riskAssessment.grade) {
    case 'CRITICAL': return 'This workflow is critical risk and needs immediate security review.';
    case 'HIGH': return 'This workflow is high risk and needs security review before production.';
    case 'MEDIUM': return 'This workflow is medium risk and should be reviewed before production.';
    case 'LOW': return 'This workflow is low risk based on the beta policy set.';
  }
}

function createVerdict(riskAssessment: WorkflowRiskAssessment): string {
  switch (riskAssessment.grade) {
    case 'CRITICAL':
    case 'HIGH': return 'Do not move this workflow into production until the highlighted issues are reviewed and remediated.';
    case 'MEDIUM': return 'Review the highlighted issues before production use.';
    case 'LOW': return 'No major beta policy risks were detected. This is a scanner result, not a final production approval.';
  }
}

function createOverview(input: {
  workflow: WorkflowInsights['workflow'];
  functionSummary: WorkflowFunctionSummary;
  integrations: WorkflowInsights['integrations'];
}): string {
  const services = input.integrations
    .filter((integration) => !integration.service.toLowerCase().includes('trigger'))
    .slice(0, 3)
    .map((integration) => integration.service);
  const servicePhrase = services.length > 0
    ? `uses ${formatList(services)}`
    : 'uses no recognized external service';

  return `${input.workflow.name ?? 'This workflow'} has ${input.workflow.nodeCount} ${pluralize('node', input.workflow.nodeCount)}, ${input.workflow.triggerCount} ${pluralize('trigger', input.workflow.triggerCount)}, and ${input.workflow.connectionCount} configured ${pluralize('connection', input.workflow.connectionCount)}. It ${servicePhrase}. ${input.functionSummary.triggerDescription}`;
}

function createRiskNarrative(summary: ScanSummary, riskAssessment: WorkflowRiskAssessment): string {
  const parts = [
    severityPhrase(summary.critical, 'critical'),
    severityPhrase(summary.high, 'high'),
    severityPhrase(summary.medium, 'medium'),
    severityPhrase(summary.low, 'low'),
  ].filter((part): part is string => part !== null);
  const findingPhrase = parts.length > 0
    ? `The scan found ${formatList(parts)}.`
    : 'The scan found no findings.';
  return `${findingPhrase} ${riskAssessment.dataExposure}`;
}

function createRecommendedActions(
  findings: readonly ScanFinding[],
  riskAssessment: WorkflowRiskAssessment,
): string[] {
  const actions = unique(findings.flatMap((finding) =>
    finding.remediationSteps.length > 0 ? finding.remediationSteps : [finding.remediation],
  )).slice(0, 5);
  if (actions.length > 0) return actions;
  return riskAssessment.grade === 'LOW'
    ? ['Keep this workflow in normal review and re-scan it when nodes, credentials, or destinations change.']
    : ['Review the scanner findings before approving this workflow for production use.'];
}

function createFindingHighlights(findings: readonly ScanFinding[]): string[] {
  if (findings.length === 0) return ['No findings were returned by the beta policy set.'];
  return findings.slice(0, 5).map((finding) => {
    const location = finding.location.nodeName
      ? ` in ${finding.location.nodeName}`
      : finding.location.path ? ` at ${finding.location.path}` : '';
    return `${finding.severity}: ${finding.title}${location}.`;
  });
}

function severityPhrase(count: number, label: string): string | null {
  return count === 0 ? null : `${count} ${label}`;
}

function pluralize(noun: string, value: number): string {
  return value === 1 ? noun : `${noun}s`;
}

function formatList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}
