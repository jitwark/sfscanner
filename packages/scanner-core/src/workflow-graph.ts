import { deriveGraphViews } from './workflow-graph-views';
import { toJsonPointer } from './json-pointer';

export type WorkflowGraphDiagnostic =
  | {
      code:
        | 'UNKNOWN_CONNECTION_SOURCE'
        | 'AMBIGUOUS_CONNECTION_SOURCE'
        | 'UNKNOWN_CONNECTION_TARGET'
        | 'AMBIGUOUS_CONNECTION_TARGET'
        | 'MALFORMED_CONNECTION_ENTRY';
    }
  // The target `index` was present but not a finite non-negative integer (e.g. -1, 1.5,
  // NaN, a numeric string, or an object). Rejected rather than coerced: a coerced index
  // would silently change which taint edges hardened analysis can see. `pointer` locates
  // the offending `index` value in the source connections object.
  | { code: 'MALFORMED_CONNECTION_INDEX'; pointer: string };

export type RawWorkflowEdge = {
  ordinal: number;
  connectionType: string;
  fromNodeIndex: number;
  fromOutputIndex: number;
  toNodeIndex: number;
  toInputIndex: number;
};

export type WorkflowGraphViews = {
  execution: RawWorkflowEdge[];
  capability: RawWorkflowEdge[];
  context: RawWorkflowEdge[];
  unknown: RawWorkflowEdge[];
};

export type EdgeResolution =
  | { state: 'EXACT'; from: string; to: string; channel: string; inputOrdinal: number }
  | { state: 'UNKNOWN'; reason: 'MISSING_LABEL' | 'AMBIGUOUS_LABEL' | 'INVALID_PORT'; label: string; inputOrdinal: number };

export type WorkflowGraph = {
  edges: RawWorkflowEdge[];
  analysisEdges: RawWorkflowEdge[];
  resolutions: EdgeResolution[];
  views: WorkflowGraphViews;
  diagnostics: WorkflowGraphDiagnostic[];
  limitExceeded: boolean;
};

export function buildWorkflowGraph(
  nodes: ReadonlyArray<{ name: string; id?: string }>,
  connections: Record<string, unknown>,
  options: { maxEdges?: number } = {},
): WorkflowGraph {
  const maxEdges = options.maxEdges ?? Infinity;
  const nodeIndexesByName = indexesByName(nodes);
  const identities = identityList(nodes);
  const edges: RawWorkflowEdge[] = [];
  const resolutions: EdgeResolution[] = [];
  const diagnostics: WorkflowGraphDiagnostic[] = [];

  for (const [sourceName, byType] of Object.entries(connections)) {
    const fromNodeIndex = resolveIndex(nodeIndexesByName, sourceName, diagnostics, 'SOURCE');
    if (fromNodeIndex === undefined) continue;
    if (fromNodeIndex.reason !== undefined) continue;
    if (!isRecord(byType)) {
      diagnostics.push({ code: 'MALFORMED_CONNECTION_ENTRY' });
      continue;
    }

    for (const [connectionType, outputs] of Object.entries(byType)) {
      if (!Array.isArray(outputs)) {
        diagnostics.push({ code: 'MALFORMED_CONNECTION_ENTRY' });
        continue;
      }
      for (const [fromOutputIndex, targets] of outputs.entries()) {
        if (targets === null || targets === undefined) continue;
        if (!Array.isArray(targets)) {
          diagnostics.push({ code: 'MALFORMED_CONNECTION_ENTRY' });
          continue;
        }

        for (const [targetIndex, target] of targets.entries()) {
          if (edges.length >= maxEdges) {
            return finish(edges, resolutions, diagnostics, true, identities);
          }
          if (!isRecord(target) || typeof target.node !== 'string') {
            diagnostics.push({ code: 'MALFORMED_CONNECTION_ENTRY' });
            continue;
          }

          const targetResolution = resolveIndex(nodeIndexesByName, target.node, diagnostics, 'TARGET');
          if (targetResolution === undefined) {
            resolutions.push({ state: 'UNKNOWN', reason: 'MISSING_LABEL', label: target.node, inputOrdinal: targetIndex });
            continue;
          }
          if (targetResolution.reason !== undefined) {
            resolutions.push({ state: 'UNKNOWN', reason: targetResolution.reason, label: target.node, inputOrdinal: targetIndex });
            continue;
          }

          const toInputIndex = resolveTargetInputIndex(target.index);
          if (toInputIndex === undefined) {
            diagnostics.push({
              code: 'MALFORMED_CONNECTION_INDEX',
              pointer: toJsonPointer(['connections', sourceName, connectionType, fromOutputIndex, targetIndex, 'index']),
            });
            resolutions.push({ state: 'UNKNOWN', reason: 'INVALID_PORT', label: target.node, inputOrdinal: targetIndex });
            continue;
          }

          edges.push({
            ordinal: edges.length,
            connectionType,
            fromNodeIndex: fromNodeIndex.index,
            fromOutputIndex,
            toNodeIndex: targetResolution.index,
            toInputIndex,
          });
          resolutions.push({
            state: 'EXACT',
            from: identities[fromNodeIndex.index]!,
            to: identities[targetResolution.index]!,
            channel: connectionType,
            inputOrdinal: targetIndex,
          });
        }
      }
    }
  }

  return finish(edges, resolutions, diagnostics, false, identities);
}

function finish(edges: RawWorkflowEdge[], resolutions: EdgeResolution[], diagnostics: WorkflowGraphDiagnostic[], limitExceeded: boolean, identities: readonly string[]): WorkflowGraph {
  const analysisEdges = [...edges].sort((left, right) => identities[left.fromNodeIndex]!.localeCompare(identities[right.fromNodeIndex]!, 'en')
    || identities[left.toNodeIndex]!.localeCompare(identities[right.toNodeIndex]!, 'en')
    || left.connectionType.localeCompare(right.connectionType, 'en')
    || left.toInputIndex - right.toInputIndex || left.ordinal - right.ordinal);
  return { edges, analysisEdges, resolutions, views: deriveGraphViews(edges), diagnostics, limitExceeded };
}

function identityList(nodes: ReadonlyArray<{ name: string; id?: string }>): string[] {
  const counts = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const node of nodes) {
    const key = node.id ?? node.name;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const pair = `${key}\u0000${node.name}`;
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  // Tag every identity so a duplicate's encoded form cannot collide with a user-supplied id/name.
  return nodes.map((node, index) => {
    const key = node.id ?? node.name;
    if ((counts.get(key) ?? 0) <= 1) return `u:${key.length}:${key}`;
    const stableName = node.id !== undefined && (pairs.get(`${key}\u0000${node.name}`) ?? 0) === 1;
    const discriminator = stableName ? `n:${node.name.length}:${node.name}` : `i:${index}`;
    return `d:${key.length}:${key}#${discriminator}`;
  });
}

function resolveIndex(
  nodeIndexesByName: Map<string, number[]>,
  name: string,
  diagnostics: WorkflowGraphDiagnostic[],
  end: 'SOURCE' | 'TARGET',
): { index: number; reason?: undefined } | { index?: undefined; reason: 'MISSING_LABEL' | 'AMBIGUOUS_LABEL' } | undefined {
  const indexes = nodeIndexesByName.get(name);
  if (!indexes) {
    diagnostics.push({ code: end === 'SOURCE' ? 'UNKNOWN_CONNECTION_SOURCE' : 'UNKNOWN_CONNECTION_TARGET' });
    return end === 'TARGET' ? { reason: 'MISSING_LABEL' } : undefined;
  }
  if (indexes.length !== 1) {
    diagnostics.push({ code: end === 'SOURCE' ? 'AMBIGUOUS_CONNECTION_SOURCE' : 'AMBIGUOUS_CONNECTION_TARGET' });
    return end === 'TARGET' ? { reason: 'AMBIGUOUS_LABEL' } : undefined;
  }
  return { index: indexes[0]! };
}

function indexesByName(nodes: ReadonlyArray<{ name: string }>): Map<string, number[]> {
  const result = new Map<string, number[]>();
  nodes.forEach((node, index) => result.set(node.name, [...(result.get(node.name) ?? []), index]));
  return result;
}

// A missing `index` (the key is absent from the JSON) defaults to 0, matching real n8n
// exports that omit it for a node's sole input. Any other value must be a strict,
// finite, non-negative integer — including a numeric string like "0", which is
// rejected rather than coerced.
function resolveTargetInputIndex(rawIndex: unknown): number | undefined {
  if (rawIndex === undefined) return 0;
  return typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
