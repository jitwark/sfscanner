import type { ScannerLimitsV2 } from '@hub/contracts';
import type { ReadonlySourceDocumentV2, SourceObjectMemberV2, SourceMemberRefV2 } from '../source/source-types';
import { resolveScannerLimits } from '../source/scanner-limit-resolution';
import { createAmbiguity, sortAmbiguities } from './ambiguity';
import { collectDuplicateAmbiguities } from './duplicate-ambiguities';
import { normalizeEdges } from './edge-normalization';
import { createNodeRef } from './node-edge-identity';
import { normalizeNodes } from './node-normalization';
import { semanticFields } from './semantic-fields';
import { digest, freeze, projectAmbiguities, projectWorkflow } from './workflow-digest';
import { validateSourceDocument } from './validate-source-document';
import type {
  NormalizationComplexityCause,
  NormalizationAmbiguityV2,
  EdgeRefV2,
  NodeRefV2,
  SecurityWorkflowResult,
  SecurityWorkflowV2,
} from './security-workflow';

const TOO_COMPLEX_MESSAGES: Record<NormalizationComplexityCause, string> = {
  NODE_LIMIT: 'Workflow exceeds the configured node normalization limit.',
  RAW_EDGE_LIMIT: 'Workflow exceeds the configured raw edge normalization limit.',
  EDGE_LIMIT: 'Workflow exceeds the configured edge normalization limit.',
  CONNECTION_DEPTH_LIMIT: 'Workflow exceeds the configured connection depth limit.',
  PARAMETER_DEPTH_LIMIT: 'Workflow exceeds the configured parameter depth limit.',
  PARAMETER_LEAF_LIMIT: 'Workflow exceeds the configured parameter leaf limit.',
};

export function normalizeSecurityWorkflow(source: unknown, partialLimits?: Partial<ScannerLimitsV2>): SecurityWorkflowResult {
  try {
    const limits = resolveLimits(partialLimits);
    if (!limits || !validateSourceDocument(source, limits)) return malformed();
    return normalizeSecurityWorkflowUnsafe(source as ReadonlySourceDocumentV2, limits);
  } catch {
    return malformed();
  }
}

function normalizeSecurityWorkflowUnsafe(source: ReadonlySourceDocumentV2, limits: ScannerLimitsV2): SecurityWorkflowResult {
  if (source.root.kind !== 'OBJECT') return malformed();
  const nodeMembers = membersNamed(source.root, 'nodes');
  const connectionMembers = membersNamed(source.root, 'connections');
  const nodesValue = nodeMembers[nodeMembers.length - 1]?.value;
  const connectionsValue = connectionMembers[connectionMembers.length - 1]?.value;
  if (!nodesValue || nodesValue.kind !== 'ARRAY' || !connectionsValue || connectionsValue.kind !== 'OBJECT') return malformed();
  const totalNodeOccurrences = nodeMembers.reduce((total, member) => total + (member.value.kind === 'ARRAY' ? member.value.items.length : 0), 0);
  if (totalNodeOccurrences > limits.maxNodes) return tooComplex('NODE_LIMIT');
  const allNodes = [] as ReturnType<typeof normalizeNodes>['nodes'];
  const allRefs = [] as NodeRefV2[];
  const nodeAmbiguities = [] as NormalizationAmbiguityV2[];
  let parameterDepth = 0;
  let parameterLeaves = 0;
  for (const member of nodeMembers) {
    if (member.value.kind !== 'ARRAY') continue;
    const nodeResult = normalizeNodes(member.value, limits, allRefs.length);
    if (nodeResult.error) return nodeResult.error === 'MALFORMED_WORKFLOW' ? malformed() : tooComplex(nodeResult.error);
    allNodes.push(...nodeResult.nodes);
    allRefs.push(...nodeResult.refs);
    nodeAmbiguities.push(...nodeResult.ambiguities);
    parameterDepth = Math.max(parameterDepth, nodeResult.parameterDepth);
    parameterLeaves += nodeResult.parameterLeaves;
  }
  const labels = labelsByValue(allRefs);
  const allEdges = [] as EdgeRefV2[];
  const edgeAmbiguities = [] as NormalizationAmbiguityV2[];
  let rawEdgesExamined = 0;
  let connectionDepth = 0;
  const relatedRefsBudget = { used: 0 };
  for (const member of connectionMembers) {
    if (member.value.kind !== 'OBJECT') continue;
    const edgeResult = normalizeEdges(member.value, allRefs, labels, limits, allEdges.length, rawEdgesExamined, relatedRefsBudget);
    if (edgeResult.error) return tooComplex(edgeResult.error);
    allEdges.push(...edgeResult.edges);
    edgeAmbiguities.push(...edgeResult.ambiguities);
    rawEdgesExamined = edgeResult.rawEdgesExamined;
    connectionDepth = Math.max(connectionDepth, edgeResult.connectionDepth);
  }
  const ambiguities = collectDuplicateAmbiguities(source);
  ambiguities.push(...duplicateLabelAmbiguities(nodeMembers, 'id'));
  ambiguities.push(...duplicateLabelAmbiguities(nodeMembers, 'name'));
  ambiguities.push(...nodeAmbiguities, ...edgeAmbiguities);
  const orderedAmbiguities = uniqueAmbiguities(ambiguities);
  const workflow: SecurityWorkflowV2 = Object.freeze({
    workflowFields: Object.freeze(semanticFields(source.root, 'ROOT')),
    nodes: Object.freeze(allNodes),
    edges: Object.freeze(allEdges),
    ambiguities: Object.freeze(orderedAmbiguities),
  });
  const ambiguitySha256 = digest(projectAmbiguities(orderedAmbiguities));
  const semanticSha256 = digest(projectWorkflow(workflow));
  return freeze({
    ok: true,
    workflow,
    semanticSha256,
    ambiguitySha256,
    ambiguityCount: orderedAmbiguities.length,
    counters: {
      nodesExamined: allRefs.length,
      rawEdgesExamined,
      edgesRetained: allEdges.length,
      connectionDepth,
      parameterDepth,
      parameterLeaves,
    },
  });
}

function malformed(): SecurityWorkflowResult {
  return Object.freeze({ ok: false, code: 'MALFORMED_WORKFLOW', message: 'Workflow shape is not valid for security normalization.' });
}

function tooComplex(cause: NormalizationComplexityCause): SecurityWorkflowResult {
  return Object.freeze({ ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause, message: TOO_COMPLEX_MESSAGES[cause] });
}

function resolveLimits(partialLimits: Partial<ScannerLimitsV2> | undefined): ScannerLimitsV2 | undefined {
  return resolveScannerLimits(partialLimits);
}

function effectiveMember(value: Extract<ReadonlySourceDocumentV2['root'], { kind: 'OBJECT' }>, name: string): SourceObjectMemberV2 | undefined {
  for (let index = value.members.length - 1; index >= 0; index -= 1) if (value.members[index].name === name) return value.members[index];
  return undefined;
}

function membersNamed(value: Extract<ReadonlySourceDocumentV2['root'], { kind: 'OBJECT' }>, name: string): SourceObjectMemberV2[] {
  return value.members.filter((member) => member.name === name);
}

function labelsByValue(nodes: readonly NodeRefV2[]): Map<string, readonly NodeRefV2[]> {
  const labels = new Map<string, NodeRefV2[]>();
  for (const node of nodes) {
    if (node.name === undefined) continue;
    const existing = labels.get(node.name) ?? [];
    if (!existing.some((item) => item.ordinal === node.ordinal)) existing.push(node);
    labels.set(node.name, existing);
  }
  return labels;
}

function duplicateLabelAmbiguities(nodeMembers: readonly SourceObjectMemberV2[], key: 'id' | 'name'): NormalizationAmbiguityV2[] {
  const grouped = new Map<string, SourceMemberRefV2[]>();
  for (const nodesValue of nodeMembers) {
    if (nodesValue.value.kind !== 'ARRAY') continue;
    for (const node of nodesValue.value.items) {
      if (node.kind !== 'OBJECT') continue;
      const member = effectiveMember(node, key);
      if (!member || member.value.kind !== 'STRING') continue;
      const refs = grouped.get(member.value.value) ?? [];
      refs.push(member.ref);
      grouped.set(member.value.value, refs);
    }
  }
  return [...grouped.values()].filter((refs) => refs.length > 1).map((refs) => createAmbiguity({
    kind: 'AMBIGUOUS_NODE', subject: refs[0], related: refs.slice(1), securityImpact: 'GRAPH_IDENTITY', resolution: 'RETAINED_ALL',
  }));
}

function uniqueAmbiguities(items: readonly NormalizationAmbiguityV2[]): NormalizationAmbiguityV2[] {
  const unique = new Map<string, NormalizationAmbiguityV2>();
  for (const item of items) unique.set(item.ambiguityId, item);
  return sortAmbiguities([...unique.values()]);
}
