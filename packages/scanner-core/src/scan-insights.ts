import type { NormalizedWorkflow, NormalizedWorkflowNode } from './workflow';
import {
  classifyComplexity,
  serviceNameFromType,
  summarizeIntegrations,
  type WorkflowComplexity,
  type WorkflowIntegration,
} from './workflow-insights';

export type WorkflowRiskGrade = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type WorkflowOverview = {
  name: string | null;
  nodeCount: number;
  rawNodeCount: number;
  annotationNodeCount: number;
  triggerCount: number;
  actionCount: number;
  integrationCount: number;
  connectionCount: number;
  payloadBytes: number;
  complexity: WorkflowComplexity;
  isSubWorkflow: boolean;
};

export type WorkflowFunctionSummary = {
  basicPurpose: string;
  triggerDescription: string;
  dataFlowSummary: string;
  businessCategory:
    | 'MANUAL_AUTOMATION'
    | 'WEBHOOK_API'
    | 'SCHEDULED_AUTOMATION'
    | 'DATA_SYNC'
    | 'NOTIFICATION'
    | 'CUSTOM_LOGIC'
    | 'GENERAL_AUTOMATION';
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
};

export type WorkflowInsights = {
  workflow: WorkflowOverview;
  functionSummary: WorkflowFunctionSummary;
  integrations: WorkflowIntegration[];
};

export type WorkflowRiskAssessment = {
  score: number;
  grade: WorkflowRiskGrade;
  topRisks: string[];
  dataExposure: string;
  complexityDrivers: string[];
};

const triggerHints = ['trigger', 'webhook', 'cron', 'schedule', 'formtrigger', 'manualtrigger'];

/** Builds the browser and CLI workflow description from the same pure contract. */
export function analyzeWorkflowInsights(workflow: NormalizedWorkflow): WorkflowInsights {
  const nodes = functionalNodes(workflow.nodes);
  const integrations = summarizeIntegrations(nodes);
  const triggerCount = nodes.filter(isTriggerNode).length;
  const nodeCount = nodes.length;
  const connectionCount = workflow.graph.edges.length;
  const overview: WorkflowOverview = {
    name: workflow.name ?? null,
    nodeCount,
    rawNodeCount: workflow.nodeCount,
    annotationNodeCount: workflow.nodeCount - nodeCount,
    triggerCount,
    actionCount: Math.max(nodeCount - triggerCount, 0),
    integrationCount: integrations.length,
    connectionCount,
    payloadBytes: workflow.payloadBytes,
    complexity: classifyComplexity(nodeCount, connectionCount, integrations.length),
    isSubWorkflow: isSubWorkflow(workflow.nodes),
  };

  return {
    workflow: overview,
    functionSummary: summarizeFunction(nodes, overview, integrations),
    integrations,
  };
}

function summarizeFunction(
  nodes: NormalizedWorkflowNode[],
  overview: WorkflowOverview,
  integrations: WorkflowIntegration[],
): WorkflowFunctionSummary {
  const triggers = nodes.filter(isTriggerNode).map((node) => serviceNameFromType(node.type));
  const services = integrations
    .filter((integration) => !integration.service.toLowerCase().includes('trigger'))
    .slice(0, 3)
    .map((integration) => integration.service);
  const prefix = isWebhookWorkflow(nodes)
    ? 'Webhook-triggered workflow'
    : isScheduledWorkflow(nodes)
      ? 'Scheduled workflow'
      : overview.triggerCount > 0
        ? 'Manual workflow'
        : 'Workflow';

  return {
    basicPurpose: `${prefix} with ${overview.nodeCount} node(s) that ${services.length > 0 ? `uses ${formatList(services)}` : 'does not use a recognized external service'}.`,
    triggerDescription: triggers.length > 0
      ? `Triggered by ${formatList(unique(triggers))}.`
      : 'No explicit trigger node was detected.',
    dataFlowSummary: overview.connectionCount > 0
      ? `The workflow has ${overview.connectionCount} configured connection(s) linking ${overview.nodeCount} node(s).`
      : 'No explicit node-to-node connections were found in the workflow JSON.',
    businessCategory: categorizeWorkflow(nodes, integrations),
    confidence: overview.nodeCount > 1 ? 'MEDIUM' : 'LOW',
  };
}

function isTriggerNode(node: NormalizedWorkflowNode): boolean {
  return triggerHints.some((hint) => compactNodeType(node.type).toLowerCase().includes(hint));
}

function isWebhookWorkflow(nodes: NormalizedWorkflowNode[]): boolean {
  return nodes.some((node) => compactNodeType(node.type).toLowerCase().includes('webhook'));
}

function isScheduledWorkflow(nodes: NormalizedWorkflowNode[]): boolean {
  return nodes.some((node) => {
    const type = compactNodeType(node.type).toLowerCase();
    return type.includes('schedule') || type.includes('cron');
  });
}

function categorizeWorkflow(
  nodes: NormalizedWorkflowNode[],
  integrations: WorkflowIntegration[],
): WorkflowFunctionSummary['businessCategory'] {
  if (isWebhookWorkflow(nodes)) return 'WEBHOOK_API';
  if (isScheduledWorkflow(nodes)) return 'SCHEDULED_AUTOMATION';
  if (integrations.some((integration) => integration.service === 'Slack')) return 'NOTIFICATION';
  if (integrations.some((integration) => integration.service === 'HTTP Request')) return 'DATA_SYNC';
  if (integrations.some((integration) => integration.service === 'Code')) return 'CUSTOM_LOGIC';
  if (nodes.some((node) => compactNodeType(node.type) === 'manualTrigger')) return 'MANUAL_AUTOMATION';
  return 'GENERAL_AUTOMATION';
}

function isSubWorkflow(nodes: NormalizedWorkflowNode[]): boolean {
  const triggers = nodes.filter(isTriggerLikeType);
  return triggers.length > 0 && triggers.every(
    (node) => compactNodeType(node.type).toLowerCase() === 'executeworkflowtrigger',
  );
}

function isTriggerLikeType(node: NormalizedWorkflowNode): boolean {
  return triggerHints.some((hint) => compactNodeType(node.type).toLowerCase().includes(hint));
}

function functionalNodes(nodes: NormalizedWorkflowNode[]): NormalizedWorkflowNode[] {
  return nodes.filter((node) => !['stickynote', 'noop'].includes(compactNodeType(node.type).toLowerCase()));
}

function compactNodeType(type: string): string {
  const segments = type.split('.');
  return segments[segments.length - 1] ?? type;
}

function formatList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}
