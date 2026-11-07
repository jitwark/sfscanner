import type { CanonicalScanFinding, ScanFinding } from './policy/policy';
import { complexityWeight } from './workflow-insights';
import type {
  WorkflowInsights,
  WorkflowRiskAssessment,
  WorkflowRiskGrade,
} from './scan-insights';
import type { NormalizedWorkflow } from './workflow';

export type { WorkflowRiskAssessment, WorkflowRiskGrade } from './scan-insights';

/** Scores the same normalized workflow and findings for every scanner surface. */
export function assessWorkflowRisk(
  workflow: NormalizedWorkflow,
  findings: readonly (ScanFinding | CanonicalScanFinding)[],
  insights: WorkflowInsights,
): WorkflowRiskAssessment {
  const scoredFindings = findings.filter(
    (finding) => (finding as Partial<CanonicalScanFinding>).policyEffect !== 'REPORT_ONLY',
  );
  const weightByPolicy = new Map<string, number>();

  for (const finding of scoredFindings) {
    const weight = severityWeight(finding.severity);
    const accumulated = weightByPolicy.get(finding.policyId);
    weightByPolicy.set(
      finding.policyId,
      accumulated === undefined ? weight : Math.min(accumulated + weight * 0.25, weight * 2),
    );
  }

  const score = Math.round(Math.min(
    100,
    [...weightByPolicy.values()].reduce((total, weight) => total + weight, 0)
      + complexityWeight(insights.workflow.complexity),
  ));
  const topRisks = scoredFindings
    .filter((finding) => finding.severity === 'CRITICAL' || finding.severity === 'HIGH')
    .slice(0, 3)
    .map((finding) => finding.title);
  const riskyNodeCount = workflow.nodes.filter((node) =>
    ['n8n-nodes-base.httpRequest', 'n8n-nodes-base.webhook'].includes(node.type),
  ).length;

  return {
    score,
    grade: gradeForScore(score),
    topRisks: topRisks.length > 0
      ? topRisks
      : ['No critical or high severity risks were detected by the beta policy set.'],
    dataExposure: riskyNodeCount > 0
      ? `${riskyNodeCount} node(s) can receive data from or send data to external systems.`
      : 'No obvious external data ingress or egress nodes were detected by the beta analyzer.',
    complexityDrivers: complexityDrivers(insights),
  };
}

function severityWeight(severity: ScanFinding['severity']): number {
  switch (severity) {
    case 'CRITICAL': return 55;
    case 'HIGH': return 35;
    case 'MEDIUM': return 18;
    case 'LOW': return 6;
    case 'INFO': return 1;
  }
}

function gradeForScore(score: number): WorkflowRiskGrade {
  if (score >= 80) return 'CRITICAL';
  if (score >= 55) return 'HIGH';
  if (score >= 25) return 'MEDIUM';
  return 'LOW';
}

function complexityDrivers(insights: WorkflowInsights): string[] {
  const drivers: string[] = [];
  if (insights.workflow.nodeCount >= 6) drivers.push(`${insights.workflow.nodeCount} functional nodes`);
  if (insights.workflow.connectionCount >= 8) drivers.push(`${insights.workflow.connectionCount} configured connections`);
  if (insights.workflow.integrationCount >= 4) drivers.push(`${insights.workflow.integrationCount} distinct integrations`);
  return drivers.length > 0 ? drivers : ['Small workflow shape by beta complexity thresholds.'];
}
