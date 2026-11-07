import type { WorkflowChart } from '@hub/contracts';
import { isFunctionalNode } from '@hub/contracts/functional-nodes';

/**
 * The subgraph a tier decision reasons about: functional nodes only, with
 * edges resolved to functional-to-functional pairs — the same definition
 * `pipeline/derive/repair-connections.ts`'s `resolvableEdges` checks against,
 * so a "12-node, 9-edge" entry means the same 12 and 9 everywhere in the
 * pipeline. Reused rather than re-derived: most packaged charts predate the
 * `isAnnotation` field (it is absent, not `false`) and edges name nodes by
 * their original n8n *name*, not the chart's generated `id` — `isFunctionalNode`
 * on `type` is the only reliable annotation test, and both id and name have to
 * resolve to the same node identity for a topology walk (component/cycle/depth)
 * to see the edge at all.
 */
export type FunctionalGraph = {
  nodeIds: string[];
  edgeCount: number;
  adjacency: Map<string, string[]>;
};

export function buildFunctionalGraph(chart: Pick<WorkflowChart, 'nodes' | 'edges'>): FunctionalGraph {
  const functional = (chart.nodes ?? []).filter(
    (node) => node.isAnnotation !== true && isFunctionalNode(node.type ?? ''),
  );
  const nodeIds = functional.map((node) => node.id);
  // Both spellings an edge might use for this node resolve to its one id, so a
  // path that starts by name and later by id still traverses as one graph.
  const aliasToId = new Map<string, string>();
  for (const node of functional) {
    aliasToId.set(node.id, node.id);
    if (node.name) aliasToId.set(node.name, node.id);
  }
  const adjacency = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  let edgeCount = 0;
  for (const edge of chart.edges ?? []) {
    const from = aliasToId.get(edge.from);
    const to = aliasToId.get(edge.to);
    if (from === undefined || to === undefined) continue;
    adjacency.get(from)?.push(to);
    edgeCount += 1;
  }
  return { nodeIds, edgeCount, adjacency };
}

export type GraphMetrics = {
  componentCount: number;
  hasCycle: boolean;
  maxDepth: number;
};

export function computeGraphMetrics(graph: FunctionalGraph): GraphMetrics {
  return {
    componentCount: countComponents(graph),
    hasCycle: detectCycle(graph),
    maxDepth: computeMaxDepth(graph),
  };
}

function countComponents(graph: FunctionalGraph): number {
  if (graph.nodeIds.length === 0) return 0;
  const undirected = new Map<string, string[]>(graph.nodeIds.map((id) => [id, []]));
  for (const [from, tos] of graph.adjacency) {
    for (const to of tos) {
      undirected.get(from)?.push(to);
      undirected.get(to)?.push(from);
    }
  }
  const visited = new Set<string>();
  let components = 0;
  for (const start of graph.nodeIds) {
    if (visited.has(start)) continue;
    components += 1;
    const queue = [start];
    while (queue.length > 0) {
      const id = queue.pop();
      if (id === undefined || visited.has(id)) continue;
      visited.add(id);
      for (const next of undirected.get(id) ?? []) if (!visited.has(next)) queue.push(next);
    }
  }
  return components;
}

/**
 * Explicit-stack DFS coloring (white/gray/black): a back edge to a gray node,
 * self-loop included, is a cycle. Iterative so corpus outliers (up to the
 * 400-node chart cap) never risk a call-stack limit.
 */
function detectCycle(graph: FunctionalGraph): boolean {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(graph.nodeIds.map((id) => [id, WHITE]));

  const hasCycleFrom = (start: string): boolean => {
    const stack: Array<{ id: string; iter: number }> = [{ id: start, iter: 0 }];
    color.set(start, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = graph.adjacency.get(frame.id) ?? [];
      if (frame.iter < neighbors.length) {
        const next = neighbors[frame.iter];
        frame.iter += 1;
        const state = color.get(next);
        if (state === GRAY) return true;
        if (state === WHITE) {
          color.set(next, GRAY);
          stack.push({ id: next, iter: 0 });
        }
      } else {
        color.set(frame.id, BLACK);
        stack.pop();
      }
    }
    return false;
  };

  for (const id of graph.nodeIds) {
    if (color.get(id) === WHITE && hasCycleFrom(id)) return true;
  }
  return false;
}

/**
 * Longest BFS layer reached from the graph's roots (indegree-0 nodes). A
 * workflow with no indegree-0 node (every node sits in a cycle) still needs a
 * start, so the first node stands in for one; any component still unreached
 * afterward (a second disconnected cyclic island) gets its own BFS rather
 * than silently reading as depth 0.
 */
function computeMaxDepth(graph: FunctionalGraph): number {
  if (graph.nodeIds.length === 0) return 0;
  const indegree = new Map<string, number>(graph.nodeIds.map((id) => [id, 0]));
  for (const tos of graph.adjacency.values()) {
    for (const to of tos) indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }

  const visited = new Set<string>();
  const roots = graph.nodeIds.filter((id) => indegree.get(id) === 0);
  let maxDepth = bfsLayers(roots.length > 0 ? roots : [graph.nodeIds[0]], graph.adjacency, visited);

  for (const id of graph.nodeIds) {
    if (visited.has(id)) continue;
    maxDepth = Math.max(maxDepth, bfsLayers([id], graph.adjacency, visited));
  }
  return maxDepth;
}

function bfsLayers(starts: string[], adjacency: Map<string, string[]>, visited: Set<string>): number {
  let frontier = starts.filter((id) => !visited.has(id));
  let depth = 0;
  let deepest = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (visited.has(id)) continue;
      visited.add(id);
      deepest = depth;
      for (const to of adjacency.get(id) ?? []) if (!visited.has(to)) next.push(to);
    }
    frontier = next;
    depth += 1;
  }
  return deepest;
}

/**
 * Approximates rendered DOM-element count for a chart this size, calibrated
 * against the one confirmed live measurement on record: a 206-node/183-edge
 * workflow detail page rendered ~5,051 DOM elements (`docs/audit/2026-08-26/
 * checkpoints/orchestrator-state.md` and `.../baseline/perf-a11y-baseline.
 * json`, `documentHeight`-adjacent DOM count). One real sample can't separate
 * a node cost and an edge cost independently, so this assumes — documented,
 * not measured — that an edge costs about 1/4 of a node (a path plus
 * arrowhead vs. a node's box, icon, label, status badge, and action button),
 * then solves 206x + 183(x/4) = 5051 for x ≈ 20.06, rounded to 20 and 5.
 * That reproduces the baseline as 206*20 + 183*5 = 5,035 (0.3% off) — close
 * enough to rank charts against each other, not a pixel-accurate predictor.
 */
export const DOM_ELEMENTS_PER_NODE = 20;
export const DOM_ELEMENTS_PER_EDGE = 5;

export function estimateDomElements(nodeCount: number, edgeCount: number): number {
  return nodeCount * DOM_ELEMENTS_PER_NODE + edgeCount * DOM_ELEMENTS_PER_EDGE;
}
