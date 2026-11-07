import type { EdgeRefV2, SecurityNodeV2, SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';

export type StructuralSummaryV1 = Readonly<{
  total: number;
  executable: number;
  disabled: number;
  inert: number;
  unresolved: number;
  vertices: number;
  edges: number;
  unresolvedEdges: number;
  excludedEdges: number;
  selfLoopEdges: number;
  parallelEdgeCount: number;
  weakComponents: number;
  structuralCycleRank: number;
}>;

export type StructuralInputV1 = Readonly<{
  nodes: readonly SecurityNodeV2[];
  edges: readonly EdgeRefV2[];
  inertOrdinals?: ReadonlySet<number>;
}>;

export const REVIEWED_INERT_NODE_TYPES_V1: ReadonlySet<string> = Object.freeze(new Set([
  'n8n-nodes-base.stickyNote',
]));

/** Sticky notes declare no ports/effects/endpoints; `noOp` remains an executable passthrough. */
export function reviewedInertOrdinals(workflow: SecurityWorkflowV2): ReadonlySet<number> {
  const inert = new Set<number>();
  for (let index = 0; index < workflow.nodes.length; index += 1) {
    const node = workflow.nodes[index]!;
    if (REVIEWED_INERT_NODE_TYPES_V1.has(node.type)) inert.add(node.ref.ordinal);
  }
  return inert;
}

/** The admitted `workflow.structure.v1` property allowlist; self-loop count stays internal. */
export function structureFactProperties(summary: StructuralSummaryV1): Omit<StructuralSummaryV1, 'selfLoopEdges' | 'excludedEdges'> {
  return Object.freeze({
    total: summary.total, executable: summary.executable, disabled: summary.disabled,
    inert: summary.inert, unresolved: summary.unresolved, vertices: summary.vertices,
    edges: summary.edges, unresolvedEdges: summary.unresolvedEdges,
    parallelEdgeCount: summary.parallelEdgeCount, weakComponents: summary.weakComponents,
    structuralCycleRank: summary.structuralCycleRank,
  });
}

/**
 * Structural metrics only, over executable vertices. `structuralCycleRank` is E - V + C for the
 * undirected multigraph; it is not runtime McCabe complexity and does not model control flow.
 */
export function summarizeStructure(input: StructuralInputV1): StructuralSummaryV1 {
  const inertOrdinals = input.inertOrdinals ?? new Set<number>();
  const allOrdinals = new Set<number>();
  const executableOrdinals = new Set<number>();
  for (let index = 0; index < input.nodes.length; index += 1) {
    const node = input.nodes[index]!;
    allOrdinals.add(node.ref.ordinal);
    if (!node.disabled && !inertOrdinals.has(node.ref.ordinal) && node.scoringEligibility !== 'INDETERMINATE') {
      executableOrdinals.add(node.ref.ordinal);
    }
  }
  const parent = new Map<number, number>();
  for (const ordinal of executableOrdinals) parent.set(ordinal, ordinal);
  const find = (value: number): number => {
    let root = value;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(value) !== root) { const next = parent.get(value)!; parent.set(value, root); value = next; }
    return root;
  };
  const union = (left: number, right: number): void => {
    const a = find(left); const b = find(right);
    if (a !== b) parent.set(a, b);
  };

  let edges = 0;
  let unresolvedEdges = 0;
  let excludedEdges = 0;
  let selfLoopEdges = 0;
  let parallelEdgeCount = 0;
  const pairs = new Map<string, number>();
  for (let edgeIndex = 0; edgeIndex < input.edges.length; edgeIndex += 1) {
    const edge = input.edges[edgeIndex]!;
    const source = edge.sourceNode?.ordinal;
    const target = edge.targetNode?.ordinal;
    if (edge.resolution !== 'RESOLVED' || source === undefined || target === undefined
      || !allOrdinals.has(source) || !allOrdinals.has(target)
      || !validPort(edge.sourcePort) || !validPort(edge.targetPort)) {
      unresolvedEdges += 1;
      continue;
    }
    if (!executableOrdinals.has(source) || !executableOrdinals.has(target)) { excludedEdges += 1; continue; }
    edges += 1;
    if (source === target) selfLoopEdges += 1;
    union(source, target);
    const key = `${source}:${target}`;
    const count = (pairs.get(key) ?? 0) + 1;
    pairs.set(key, count);
    if (count > 1) parallelEdgeCount += 1;
  }

  const roots = new Set<number>();
  for (const ordinal of executableOrdinals) roots.add(find(ordinal));
  const vertices = executableOrdinals.size;
  const weakComponents = roots.size;
  const structuralCycleRank = vertices === 0 ? 0 : edges - vertices + weakComponents;

  let disabled = 0;
  let inert = 0;
  let unresolved = 0;
  let executable = 0;
  for (let index = 0; index < input.nodes.length; index += 1) {
    const node = input.nodes[index]!;
    if (node.disabled) { disabled += 1; continue; }
    if (inertOrdinals.has(node.ref.ordinal)) { inert += 1; continue; }
    if (node.scoringEligibility === 'INDETERMINATE') { unresolved += 1; continue; }
    executable += 1;
  }

  return Object.freeze({
    total: input.nodes.length, executable, disabled, inert, unresolved,
    vertices, edges, unresolvedEdges, excludedEdges, selfLoopEdges, parallelEdgeCount, weakComponents, structuralCycleRank,
  });
}

function validPort(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
