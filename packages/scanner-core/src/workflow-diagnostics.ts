import type { DuplicateJsonKeyLocation } from './workflow-source-locations';

export type MalformedNodeParametersLocation = { nodeIndex: number; pointer: string };

export type WorkflowParseDiagnostic =
  | { code: 'DUPLICATE_NODE_NAME'; nodeIndexes: number[] }
  | { code: 'DUPLICATE_NODE_ID'; nodeIndexes: number[] }
  | { code: 'DUPLICATE_JSON_KEY'; pointer: string; key: string }
  | { code: 'MALFORMED_NODE_PARAMETERS'; nodeIndex: number; pointer: string };

type IdentifiedNode = { id: string; name: string };

export function collectParseDiagnostics(
  nodes: ReadonlyArray<IdentifiedNode>,
  duplicateKeys: ReadonlyArray<DuplicateJsonKeyLocation>,
  malformedParameters: ReadonlyArray<MalformedNodeParametersLocation> = [],
): WorkflowParseDiagnostic[] {
  return [
    ...duplicateGroups(nodes, (node) => node.name)
      .map((nodeIndexes) => ({ code: 'DUPLICATE_NODE_NAME' as const, nodeIndexes })),
    ...duplicateGroups(nodes, (node) => node.id)
      .map((nodeIndexes) => ({ code: 'DUPLICATE_NODE_ID' as const, nodeIndexes })),
    ...duplicateKeys.map((location) => ({ code: 'DUPLICATE_JSON_KEY' as const, ...location })),
    ...malformedParameters.map((location) => ({ code: 'MALFORMED_NODE_PARAMETERS' as const, ...location })),
  ];
}

function duplicateGroups(
  nodes: ReadonlyArray<IdentifiedNode>,
  key: (node: IdentifiedNode) => string,
): number[][] {
  const byKey = new Map<string, number[]>();
  nodes.forEach((node, index) => byKey.set(key(node), [...(byKey.get(key(node)) ?? []), index]));
  return [...byKey.values()].filter((nodeIndexes) => nodeIndexes.length > 1);
}
