import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalizeJson } from '../canonical-json';
import type { SourceMemberRefV2 } from '../source/source-types';
import type { NormalizationAmbiguityV2, SecurityWorkflowV2, NodeRefV2 } from './security-workflow';

export function projectAmbiguities(items: readonly NormalizationAmbiguityV2[]) {
  return items.map((item) => ({
    ambiguityId: item.ambiguityId, kind: item.kind, subject: refWithoutSpan(item.subject),
    related: item.related.map(refWithoutSpan), securityImpact: item.securityImpact, resolution: item.resolution,
  }));
}

export function projectWorkflow(workflow: SecurityWorkflowV2) {
  return {
    workflowFields: workflow.workflowFields.map(projectField),
    nodes: workflow.nodes.map((node) => ({
      ref: projectNode(node.ref), type: node.type, ...(node.typeVersion !== undefined ? { typeVersion: node.typeVersion } : {}), disabled: node.disabled,
      scoringEligibility: node.scoringEligibility, parameters: node.parameters.map(projectField), credentials: node.credentials.map(projectField), settings: node.settings.map(projectField),
    })),
    edges: workflow.edges.map((edge) => ({
      ordinal: edge.ordinal, ...(edge.sourceNode ? { sourceNode: projectNode(edge.sourceNode) } : {}), sourceLabel: edge.sourceLabel,
      ...(edge.targetNode ? { targetNode: projectNode(edge.targetNode) } : {}), ...(edge.targetLabel !== undefined ? { targetLabel: edge.targetLabel } : {}),
      connectionType: edge.connectionType, sourcePort: edge.sourcePort, targetPort: edge.targetPort, source: refWithoutSpan(edge.source), resolution: edge.resolution,
    })),
    ambiguities: projectAmbiguities(workflow.ambiguities),
  };
}

export function digest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalizeJson(value))));
}

export function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}

function projectField(field: SecurityWorkflowV2['workflowFields'][number]): unknown {
  return { pointer: field.pointer, occurrences: field.occurrences.map(refWithoutSpan), value: Array.isArray(field.value) ? field.value.map(projectField) : field.value, classification: field.classification };
}

function projectNode(node: NodeRefV2) {
  return { ordinal: node.ordinal, source: refWithoutSpan(node.source), ...(node.explicitId !== undefined ? { explicitId: node.explicitId } : {}), ...(node.name !== undefined ? { name: node.name } : {}), identityDigest: node.identityDigest };
}

function refWithoutSpan(ref: SourceMemberRefV2) {
  return { pointer: ref.pointer, occurrencePath: [...ref.occurrencePath], astNodeId: ref.astNodeId, span: null };
}
