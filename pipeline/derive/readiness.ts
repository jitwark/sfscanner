import type { EntryReadiness } from '@hub/contracts';
import { isFunctionalNode, isSubWorkflow } from '@hub/contracts/functional-nodes';
import type { ReadinessNode } from './readiness-types.js';
import { deriveReplaceableValues, walkLeaves, type Leaf } from './readiness-values.js';
import {
  deriveCredentials,
  deriveWriteActions,
  deriveAiModel,
  deriveExtraPackages,
  deriveVersionNotes,
} from './readiness-signals.js';

// Same shape of defensive parsing as `structure.ts`: `workflow` is untrusted
// JSON from a public repository, so every step tolerates non-objects, missing
// keys, and wrong types instead of throwing.
function nodesOf(workflow: unknown): Record<string, unknown>[] {
  if (!workflow || typeof workflow !== 'object' || !('nodes' in workflow)) return [];
  const value = (workflow as Record<string, unknown>).nodes;
  if (!Array.isArray(value)) return [];
  return value.filter((node): node is Record<string, unknown> => Boolean(node && typeof node === 'object'));
}

function nodeType(node: Record<string, unknown>): string {
  const type = typeof node.type === 'string' ? node.type : '';
  const name = typeof node.name === 'string' ? node.name : '';
  return type || name || 'Unknown';
}

function nodeName(node: Record<string, unknown>): string {
  return typeof node.name === 'string' && node.name ? node.name : nodeType(node);
}

function toReadinessNode(node: Record<string, unknown>): ReadinessNode {
  return {
    type: nodeType(node),
    name: nodeName(node),
    parameters: node.parameters,
    credentials: node.credentials,
    typeVersion: node.typeVersion,
  };
}

function pinDataOf(workflow: unknown): Record<string, unknown> {
  if (!workflow || typeof workflow !== 'object' || !('pinData' in workflow)) return {};
  const value = (workflow as Record<string, unknown>).pinData;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// Bounded scan for the legacy `$node["X"]` expression form, reusing the same
// capped walker as `deriveReplaceableValues` so this cannot be the unbounded
// path on a hostile, deeply nested `parameters` tree.
function hasLegacyNodeExpression(nodes: ReadinessNode[]): boolean {
  for (const node of nodes) {
    if (!node.parameters || typeof node.parameters !== 'object') continue;
    const leaves: Leaf[] = [];
    walkLeaves(node.parameters, '', 0, leaves);
    if (leaves.some(leaf => leaf.value.includes('$node['))) return true;
  }
  return false;
}

/**
 * Phase 6.1 readiness report for one workflow: what a reader needs before
 * importing it, computed purely from the JSON. See `phase-6-content-depth.md`
 * §2a. Every count here excludes sticky notes and no-op placeholders via
 * `isFunctionalNode`, matching `deriveStructure`.
 */
export function deriveReadiness(workflow: unknown): EntryReadiness {
  const allNodes = nodesOf(workflow);
  const functionalNodes = allNodes.filter(node => isFunctionalNode(nodeType(node)));
  const readinessNodes = functionalNodes.map(toReadinessNode);

  const pinnedKeys = Object.keys(pinDataOf(workflow));

  return {
    analysis: 'derived',
    credentials: deriveCredentials(readinessNodes),
    replaceableValues: deriveReplaceableValues(readinessNodes),
    writeActions: deriveWriteActions(readinessNodes),
    aiModel: deriveAiModel(readinessNodes),
    extraPackages: deriveExtraPackages(readinessNodes),
    versionNotes: deriveVersionNotes(readinessNodes, hasLegacyNodeExpression(readinessNodes)),
    pinnedData: { present: pinnedKeys.length > 0, nodeCount: pinnedKeys.length },
    isSubWorkflow: isSubWorkflow(allNodes.map(node => ({ type: nodeType(node) }))),
  };
}
