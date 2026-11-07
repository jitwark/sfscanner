import type { ScannerLimitsV2 } from '@hub/contracts';
import type { SourceMemberRefV2, SourceValueV2 } from '../source/source-types';
import { createAmbiguity } from './ambiguity';
import type { EdgeRefV2, NodeRefV2, NormalizationAmbiguityV2 } from './security-workflow';

type EdgeCollection = {
  edges: EdgeRefV2[];
  ambiguities: NormalizationAmbiguityV2[];
  rawEdgesExamined: number;
  connectionDepth: number;
  error?: 'RAW_EDGE_LIMIT' | 'EDGE_LIMIT' | 'CONNECTION_DEPTH_LIMIT';
};

type ParsedCandidate = {
  target: string;
  targetPort: number;
  duplicateNode?: SourceMemberRefV2[];
  duplicateIndex?: SourceMemberRefV2[];
};

export function normalizeEdges(
  connections: SourceValueV2,
  nodes: readonly NodeRefV2[],
  labels: ReadonlyMap<string, readonly NodeRefV2[]>,
  limits: ScannerLimitsV2,
  edgeOrdinalOffset = 0,
  rawEdgeOffset = 0,
  relatedRefsBudget: { used: number } = { used: 0 },
): EdgeCollection {
  const result: EdgeCollection = { edges: [], ambiguities: [], rawEdgesExamined: rawEdgeOffset, connectionDepth: 0 };
  if (connections.kind !== 'OBJECT') return result;
  result.connectionDepth = connectionContainerDepth(connections);
  if (result.connectionDepth > limits.maxConnectionDepth) return depthLimit(result);

  for (const sourceMember of connections.members) {
    result.connectionDepth = Math.max(result.connectionDepth, 1);
    if (result.connectionDepth > limits.maxConnectionDepth) return depthLimit(result);
    if (sourceMember.value.kind !== 'OBJECT') continue;
    for (const typeMember of sourceMember.value.members) {
      result.connectionDepth = Math.max(result.connectionDepth, 2);
      if (result.connectionDepth > limits.maxConnectionDepth) return depthLimit(result);
      if (typeMember.value.kind !== 'ARRAY') continue;
      for (const [sourcePort, targets] of typeMember.value.items.entries()) {
        result.connectionDepth = Math.max(result.connectionDepth, 3);
        if (result.connectionDepth > limits.maxConnectionDepth) return depthLimit(result);
        if (targets.kind !== 'ARRAY') continue;
        for (const candidate of targets.items) {
          result.connectionDepth = Math.max(result.connectionDepth, 4);
          if (result.connectionDepth > limits.maxConnectionDepth) return depthLimit(result);
          result.rawEdgesExamined += 1;
          if (result.rawEdgesExamined > limits.maxRawEdges) {
            result.error = 'RAW_EDGE_LIMIT';
            return result;
          }
          const parsed = parseCandidate(candidate);
          if (!parsed) continue;
          const sourceMatches = labels.get(sourceMember.name) ?? [];
          const targetMatches = labels.get(parsed.target) ?? [];
          const duplicateSecurity = parsed.duplicateNode !== undefined || parsed.duplicateIndex !== undefined;
          const sourceNode = sourceMatches.length === 1 ? sourceMatches[0] : undefined;
          const targetNode = duplicateSecurity || targetMatches.length !== 1 ? undefined : targetMatches[0];
          const resolution: EdgeRefV2['resolution'] = duplicateSecurity || sourceMatches.length === 0 || targetMatches.length === 0
            ? 'UNRESOLVED' : sourceMatches.length > 1 || targetMatches.length > 1 ? 'AMBIGUOUS' : 'RESOLVED';
          if (edgeOrdinalOffset + result.edges.length >= limits.maxEdges) {
            result.error = 'EDGE_LIMIT';
            return result;
          }
          const edge: EdgeRefV2 = Object.freeze({
            ordinal: edgeOrdinalOffset + result.edges.length,
            ...(sourceNode ? { sourceNode } : {}),
            sourceLabel: sourceMember.name,
            ...(targetNode ? { targetNode } : {}),
            targetLabel: parsed.target,
            connectionType: typeMember.name,
            sourcePort,
            targetPort: parsed.targetPort,
            source: candidate.ref,
            resolution,
          });
          result.edges.push(edge);
          if (duplicateSecurity) {
            for (const refs of [parsed.duplicateNode, parsed.duplicateIndex]) if (refs) result.ambiguities.push(createAmbiguity({
              kind: 'MALFORMED_SECURITY_VALUE', subject: refs[0], related: refs.slice(1), securityImpact: 'GRAPH_IDENTITY', resolution: 'EXCLUDED_FROM_SCORING',
            }));
          }
          if (resolution === 'AMBIGUOUS') result.ambiguities.push(createAmbiguity({
            kind: 'AMBIGUOUS_EDGE',
            subject: candidate.ref,
            related: takeRelatedNodes(undefined, sourceMatches, targetMatches, relatedRefsBudget, limits.maxDiagnostics),
            securityImpact: 'GRAPH_IDENTITY',
            resolution: 'RETAINED_ALL',
          }));
          if (resolution === 'UNRESOLVED') result.ambiguities.push(createAmbiguity({
            kind: 'UNRESOLVED_EDGE',
            subject: candidate.ref,
            related: takeRelatedNodes(sourceNode ? undefined : sourceMember.ref, sourceNode ? [sourceNode] : [], [], relatedRefsBudget, limits.maxDiagnostics),
            securityImpact: 'GRAPH_IDENTITY',
            resolution: 'UNRESOLVED',
          }));
        }
      }
    }
  }
  return result;
}

function takeRelatedNodes(primary: SourceMemberRefV2 | undefined, sourceNodes: readonly NodeRefV2[], targetNodes: readonly NodeRefV2[], budget: { used: number }, maximum: number): SourceMemberRefV2[] {
  const remaining = Math.max(0, maximum - budget.used);
  const retained: SourceMemberRefV2[] = [];
  if (primary && retained.length < remaining) retained.push(primary);
  for (const node of sourceNodes) {
    if (retained.length >= remaining) break;
    retained.push(node.source);
  }
  for (const node of targetNodes) {
    if (retained.length >= remaining) break;
    retained.push(node.source);
  }
  budget.used += retained.length;
  return retained;
}

function connectionContainerDepth(value: SourceValueV2): number {
  const pending: Array<{ value: SourceValueV2; depth: number }> = [{ value, depth: 0 }];
  let maximum = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.value.kind !== 'OBJECT' && current.value.kind !== 'ARRAY') continue;
    maximum = Math.max(maximum, current.depth);
    if (current.value.kind === 'OBJECT') {
      for (const member of current.value.members) pending.push({ value: member.value, depth: current.depth + 1 });
    } else {
      for (const item of current.value.items) pending.push({ value: item, depth: current.depth + 1 });
    }
  }
  return maximum;
}

function parseCandidate(value: SourceValueV2): ParsedCandidate | undefined {
  if (value.kind !== 'OBJECT') return undefined;
  const nodeMembers = value.members.filter((member) => member.name === 'node');
  const indexMembers = value.members.filter((member) => member.name === 'index');
  const validTargets = nodeMembers.filter((member) => member.value.kind === 'STRING');
  if (validTargets.length === 0) return undefined;
  const validIndexes = indexMembers.filter((member) => member.value.kind === 'NUMBER' && Number.isSafeInteger(member.value.value) && member.value.value >= 0);
  if (indexMembers.length === 1 && validIndexes.length === 0) return undefined;
  return {
    target: (validTargets[0].value.kind === 'STRING' ? validTargets[0].value.value : ''),
    targetPort: validIndexes.length > 0 && validIndexes[0].value.kind === 'NUMBER' ? validIndexes[0].value.value : 0,
    ...(nodeMembers.length > 1 ? { duplicateNode: nodeMembers.map((member) => member.ref) } : {}),
    ...(indexMembers.length > 1 ? { duplicateIndex: indexMembers.map((member) => member.ref) } : {}),
  };
}

function depthLimit(result: EdgeCollection): EdgeCollection {
  result.error = 'CONNECTION_DEPTH_LIMIT';
  return result;
}
