import type { ChartEdge, ChartNode, EntryStructure } from '@hub/contracts';
import { isFunctionalNode, isSubWorkflow } from '@hub/contracts/functional-nodes';
import { hasAiNode } from './ai-detection';
import { getIntegrationInfo } from '../enrich/integration-map.js';
import { normalizeDiscoverySlug } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';

function nodesOf(workflow: unknown): Record<string, unknown>[] {
  if (!workflow || typeof workflow !== 'object' || !('nodes' in workflow)) return [];
  const value = workflow.nodes;
  if (!Array.isArray(value)) return [];
  return value.filter((node): node is Record<string, unknown> => Boolean(node && typeof node === 'object'));
}

function nodeType(node: Record<string, unknown>): string {
  const type = typeof node.type === 'string' ? node.type : '';
  const nodeTypeVal = typeof node.nodeType === 'string' ? node.nodeType : '';
  const name = typeof node.name === 'string' ? node.name : '';
  return type || nodeTypeVal || name || 'Unknown';
}

function connectionMap(workflow: unknown): Record<string, unknown> {
  if (!workflow || typeof workflow !== 'object' || !('connections' in workflow)) return {};
  const value = workflow.connections;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function edgesOf(workflow: unknown): ChartEdge[] {
  const edges: ChartEdge[] = [];
  const map = connectionMap(workflow);
  const keys = Object.keys(map).sort(compareCanonicalStrings);
  for (const from of keys) {
    const value = map[from];
    if (!value || typeof value !== 'object') continue;
    const kindKeys = Object.keys(value).sort(compareCanonicalStrings);
    for (const kind of kindKeys) {
      const outputs = (value as Record<string, unknown>)[kind];
      if (!Array.isArray(outputs)) continue;
      for (const output of outputs) {
        if (!Array.isArray(output)) continue;
        for (const target of output) {
          if (!target || typeof target !== 'object') continue;
          const to = 'node' in target && typeof target.node === 'string' ? target.node : '';
          if (to) edges.push({ from, to, kind });
        }
      }
    }
  }
  return edges;
}

export function deriveTrigger(input: unknown): string {
  const nodes = Array.isArray(input) ? (input as Record<string, unknown>[]) : nodesOf(input);
  const types = nodes.map(node => {
    const nameStr = typeof node.name === 'string' ? node.name : '';
    return `${nodeType(node)} ${nameStr}`.toLowerCase();
  });

  if (types.some(v => v.includes('webhook'))) return 'Webhook';
  if (types.some(v => v.includes('schedule') || v.includes('cron'))) return 'Schedule';
  if (types.some(v => v.includes('chattrigger') || v.includes('chat trigger') || (v.includes('chat') && v.includes('trigger')))) return 'Chat';
  if (types.some(v => v.includes('email') && (v.includes('trigger') || v.includes('imap') || v.includes('read')))) return 'Email';
  if (types.some(v => v.includes('form') && (v.includes('trigger') || v.includes('formtrigger')))) return 'Form';
  if (types.some(v => v.includes('executeworkflow') || v.includes('execute workflow') || v.includes('executeworkflowtrigger'))) return 'Execute-Workflow';
  if (types.some(v => v.includes('manual') || v.includes('start'))) return 'Manual';

  return 'Manual';
}

/**
 * Tags that describe a capability rather than a vendor product. The whole point
 * of the integration list is "which services does this call", so a node whose
 * only tags are capability tags contributes no integration.
 */
export const NON_VENDOR_TAGS: ReadonlySet<string> = new Set([
  'ai-tool', 'chat', 'code', 'document-loader', 'file-processing', 'form', 'http', 'memory',
  'schedule', 'structured-output', 'text-splitter', 'vector-store', 'webhook',
]);

/**
 * The one canonical vendor label a node type contributes, or `null` when it has
 * none. Exported because a second caller — normalising an already-published
 * integration label on an entry with no body — must apply exactly this mapping,
 * not a re-implementation of it.
 */
export function integrationLabelForNodeType(type: string): string | null {
  const info = getIntegrationInfo(type);
  const vendorTag = info?.tags.map(normalizeDiscoverySlug).find((tag) => !NON_VENDOR_TAGS.has(tag));
  return vendorTag ?? null;
}

export function deriveChart(workflow: unknown): { nodes: ChartNode[]; edges: ChartEdge[] } {
  const nodes = nodesOf(workflow);
  const chartNodes = nodes.map((node, index) => {
    const position = Array.isArray(node.position) ? node.position : [];
    const x = typeof position[0] === 'number' ? position[0] : (index % 4) * 240;
    const y = typeof position[1] === 'number' ? position[1] : Math.floor(index / 4) * 140;
    const type = nodeType(node);
    const nodeName = typeof node.name === 'string' ? node.name : type;
    const nodeId = typeof node.id === 'string' ? node.id : `node-${index}`;
    return { id: nodeId, name: nodeName, type, x, y, isAnnotation: !isFunctionalNode(type) };
  });
  return { nodes: chartNodes, edges: edgesOf(workflow) };
}

/** The band an entry's `structure.complexity` carries. Exported so a migration re-derives it rather than restating it. */
export function complexityBand(nodeCount: number, connectionCount: number): EntryStructure['complexity'] {
  if (nodeCount > 15 || connectionCount > 25) return 'complex';
  return nodeCount > 5 || connectionCount > 8 ? 'medium' : 'simple';
}

export function deriveStructure(workflow: unknown): EntryStructure {
  const allNodes = nodesOf(workflow);
  // Same two channels as the scanner: annotations must leave both the count and
  // the integration list, or the complexity band stays inflated through
  // whichever one was missed. `sticky-note` was a published "integration".
  const nodes = allNodes.filter(node => isFunctionalNode(nodeType(node)));
  const types = [...new Set(nodes.map(nodeType))].sort(compareCanonicalStrings);
  // A connection naming a node the file does not contain is not a connection.
  // Counting them inflated `connectionCount` on 1,158 entries and pushed some
  // of them a complexity band up — complexity is a claim about how much is
  // going on, and nothing is going on down a reference to nothing (CI R-4).
  //
  // Resolved against the *functional* nodes, the same set `nodeCount` counts and
  // `check-graph-coherence.mjs` checks. An edge to a sticky note is not data
  // flow, and counting it would put the two halves of one claim out of step.
  const declared = edgesOf(workflow);
  const nodeNames = new Set(nodes.map(node => (typeof node.name === 'string' ? node.name : '')));
  const edges = declared.filter(edge => nodeNames.has(edge.from) && nodeNames.has(edge.to));
  const lowered = types.map(type => type.toLowerCase());
  const nodeCount = nodes.length;
  return {
    nodeCount,
    rawNodeCount: allNodes.length,
    annotationNodeCount: allNodes.length - nodeCount,
    connectionCount: edges.length,
    nodeTypes: types,
    integrations: [...new Set(types.map(integrationLabelForNodeType).filter((value): value is string => Boolean(value)))].sort(compareCanonicalStrings),
    trigger: deriveTrigger(allNodes),
    isSubWorkflow: isSubWorkflow(allNodes.map(node => ({ type: nodeType(node) }))),
    complexity: complexityBand(nodeCount, edges.length),
    hasCode: lowered.some(type => type.includes('code') || type.includes('function')),
    // Vendor names, never a substring: `ai` matches `airtable`, `gmail`, and
    // `emailSend`, which flagged 21.8% of the catalogue as calling an AI model
    // when it calls none. See `ai-detection.ts`.
    hasAI: hasAiNode(types),
    hasWebhook: lowered.some(type => type.includes('webhook')),
  };
}
