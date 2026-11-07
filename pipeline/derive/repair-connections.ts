import type { ChartEdge, Entry, WorkflowChart } from '@hub/contracts';
import { isFunctionalNode } from '@hub/contracts/functional-nodes';
import { complexityBand } from './structure.js';

/**
 * Repairing a packaged corpus, rather than rebuilding it.
 *
 * `deriveStructure` and `buildChart` were both corrected to stop treating a
 * connection that names no node as a connection, but neither correction reaches
 * an already-packaged entry: raw workflow JSON is retained only for the 288
 * redistributable ones, so 12,933 entries cannot be re-derived from source.
 *
 * The chart can stand in for the source. It carries the nodes and the edges,
 * which is exactly what resolvability is a question about — the same substitution
 * `scripts/check-graph-coherence.mjs` already makes.
 *
 * One limit, recorded rather than hidden: `buildChart` caps a chart at 400 nodes
 * and drops the edges outside that set, so a workflow above the cap has its
 * connections undercounted here.
 */

/**
 * Edges whose endpoints both name a functional node the chart contains.
 *
 * Functional, not merely present: an edge to a sticky note is not data flow,
 * and `structure.nodeCount` already excludes annotations, so counting one would
 * put the two halves of a single claim out of step. This is the definition
 * `scripts/check-graph-coherence.mjs` checks against.
 *
 * Ids *and* names: `buildChart` normalises endpoints to ids, but before it was
 * fixed it fell back to the raw connection name. Where that name belongs to a
 * real node the edge is genuine and must survive the repair.
 *
 * The node's own `isAnnotation` flag is a hint, not the authority: packaged
 * charts predate the field and omit it entirely, so a sticky note reaches this
 * function looking like work. `isFunctionalNode` reads the type, which is
 * always there.
 */
export function resolvableEdges(chart: WorkflowChart): ChartEdge[] {
  const refs = new Set<string>();
  for (const node of chart.nodes ?? []) {
    if (node.isAnnotation === true || !isFunctionalNode(node.type ?? '')) continue;
    if (node.id) refs.add(node.id);
    if (node.name) refs.add(node.name);
  }
  return (chart.edges ?? []).filter((edge) => refs.has(edge.from) && refs.has(edge.to));
}

export type RepairResult = { entry: Entry; chart: WorkflowChart; changed: boolean };

/** Re-derive an entry's connection count and complexity band from its chart. */
export function repairEntry(entry: Entry, chart: WorkflowChart): RepairResult {
  const kept = resolvableEdges(chart);
  const declared = (chart.edges ?? []).length;
  const dropped = declared - kept.length;

  const nodeCount = entry.structure?.nodeCount ?? 0;
  const complexity = complexityBand(nodeCount, kept.length);
  const changed = entry.structure?.connectionCount !== kept.length
    || entry.structure?.complexity !== complexity;

  const repairedChart: WorkflowChart = dropped > 0
    ? { ...chart, edges: kept, unresolvedEdgeCount: dropped }
    : { ...chart, edges: kept };

  return {
    entry: { ...entry, structure: { ...entry.structure, connectionCount: kept.length, complexity } },
    chart: repairedChart,
    changed,
  };
}
