import type { NormalizedWorkflowNode } from './workflow';
import { compareCanonicalStrings } from './stable-order';

export type WorkflowComplexity = 'LOW' | 'MEDIUM' | 'HIGH';

export type WorkflowIntegration = {
  service: string;
  nodeTypes: string[];
  nodeCount: number;
  usage: string;
  riskNotes: string[];
};

const serviceLabels: Record<string, string> = {
  code: 'Code',
  executeCommand: 'Execute Command',
  function: 'Function',
  functionItem: 'Function Item',
  httpRequest: 'HTTP Request',
  manualTrigger: 'Manual Trigger',
  scheduleTrigger: 'Schedule Trigger',
  slack: 'Slack',
  webhook: 'Webhook',
};

export function summarizeIntegrations(nodes: NormalizedWorkflowNode[]): WorkflowIntegration[] {
  const byService = new Map<string, NormalizedWorkflowNode[]>();

  for (const node of nodes) {
    const service = serviceNameFromType(node.type);
    byService.set(service, [...(byService.get(service) ?? []), node]);
  }

  return [...byService.entries()]
    .map(([service, serviceNodes]) => ({
      service,
      nodeTypes: unique(serviceNodes.map((node) => node.type)),
      nodeCount: serviceNodes.length,
      usage: usageForService(service, serviceNodes),
      riskNotes: riskNotesForService(service, serviceNodes),
    }))
    .sort((left, right) => compareCanonicalStrings(left.service, right.service));
}

export function classifyComplexity(
  nodeCount: number,
  connectionCount: number,
  integrationCount: number,
): WorkflowComplexity {
  if (nodeCount >= 15 || connectionCount >= 20 || integrationCount >= 8) {
    return 'HIGH';
  }

  if (nodeCount >= 6 || connectionCount >= 8 || integrationCount >= 4) {
    return 'MEDIUM';
  }

  return 'LOW';
}

export function complexityWeight(complexity: WorkflowComplexity): number {
  switch (complexity) {
    case 'HIGH':
      return 20;
    case 'MEDIUM':
      return 10;
    case 'LOW':
      return 0;
  }
}

/** Shared with app-only trigger prose so service labels cannot drift. */
export function serviceNameFromType(type: string): string {
  const compactType = compactNodeType(type);
  return serviceLabels[compactType] ?? titleCase(splitCamelCase(compactType));
}

function compactNodeType(type: string): string {
  const segments = type.split('.');
  return segments[segments.length - 1] ?? type;
}

function usageForService(service: string, nodes: NormalizedWorkflowNode[]): string {
  if (service === 'Webhook') return 'Receives external HTTP requests into the workflow.';
  if (service === 'HTTP Request') return 'Calls external HTTP APIs or internal web services.';
  if (service === 'Slack') return 'Sends or manages Slack workspace messages and notifications.';
  if (service === 'Execute Command') return 'Runs operating-system commands from a workflow node.';
  if (service === 'Code' || service === 'Function' || service === 'Function Item') {
    return 'Runs custom JavaScript logic inside the workflow.';
  }
  return `Uses ${nodes.length} ${service} node(s) in the workflow.`;
}

function riskNotesForService(service: string, nodes: NormalizedWorkflowNode[]): string[] {
  if (service === 'Execute Command') return ['Can run shell commands on the n8n host or worker environment.'];
  if (service === 'HTTP Request') return ['Can send workflow data to external URLs configured in node parameters.'];
  if (service === 'Webhook') return ['Can expose an inbound endpoint that may need authentication and rate limits.'];
  if (service === 'Code' || service === 'Function' || service === 'Function Item') {
    return ['Custom code should be reviewed for secret handling and data exfiltration.'];
  }
  return nodes.some((node) => !node.type.startsWith('n8n-nodes-base.'))
    ? ['This integration comes from a non-core or community package namespace.']
    : [];
}

function titleCase(value: string): string {
  return value
    .split(' ')
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function splitCamelCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}
