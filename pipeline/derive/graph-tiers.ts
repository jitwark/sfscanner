import type { WorkflowChart } from '@hub/contracts';
import { buildFunctionalGraph } from './graph-metrics.js';

/**
 * Tiers a workflow-detail preview picks between (P5.6/P5.7 consume this, not
 * defined here): `A` full static node/edge preview, `B` grouped/collapsed
 * static overview, `C` high-level map plus an accessible node/connection
 * list, `invalid` an explicit finite fallback for a graph that failed to load
 * or resolve to any node at all.
 */
export type GraphTier = 'A' | 'B' | 'C' | 'invalid';

export const GRAPH_TIER_THRESHOLDS_SCHEMA_VERSION = 'graph-tier-thresholds-v1' as const;

export type GraphTierThresholdsV1 = {
  schemaVersion: typeof GRAPH_TIER_THRESHOLDS_SCHEMA_VERSION;
  /** Highest functional node count still Tier A. */
  tierAMaxNodes: number;
  /** Highest resolved edge count still Tier A. */
  tierAMaxEdges: number;
  /** Highest functional node count still Tier B (above this is Tier C). */
  tierBMaxNodes: number;
  /** Highest resolved edge count still Tier B (above this is Tier C). */
  tierBMaxEdges: number;
  /** ISO date the corpus measurement behind these numbers was taken. */
  measuredAt: string;
  /** Entry count the percentiles below were computed over. */
  corpusSize: number;
};

/**
 * `pipeline/measure/graph-complexity-distribution.ts`, run against the full
 * 13,221-entry corpus on 2026-08-27, replacing the never-validated draft
 * 50/200-node placeholder (`docs/audit/2026-08-26/checkpoints/orchestrator-
 * state.md` line 125; `openspec/changes/workflow-detail-and-canvas/
 * proposal.md`). Measured functional-node-count percentiles: p50=11, p75=17,
 * p90=26, p95=34, p99=62, p99.9=148, max=209. Measured resolved-edge-count
 * percentiles: p50=10, p75=17, p90=27, p95=35, p99=66, p99.9=160, max=265.
 *
 * A/B sits at p90 and B/C sits at p99 on both axes, not p50/p90, because the
 * *shipped* problem (the audit's flagged 206-node/183-edge page, ~5,051 DOM
 * elements, 320px overflow) sits at the extreme tail — between this corpus's
 * p99.9 and max on the node axis — not the middle. A p50 cut would push the
 * *median* workflow into a degraded preview for no measured reason; p90/p99
 * instead keeps the ordinary 90% of the corpus on the full static preview and
 * reserves grouping for the top decile, with only the top 1% (which is where
 * the one confirmed problem case lives) forced to the map+list fallback.
 *
 * Cycle/disconnection were measured (19.78% cyclic, 29.91% multi-component)
 * but deliberately do not gate a tier: at those rates they describe a fifth
 * to a third of entirely ordinary small workflows, so tiering on them would
 * misclassify routine graphs as extreme. P5.1 already carries cyclic/
 * disconnected as their own fixture categories, independent of size tier —
 * that is the correct place for that concern, not this size-based gate.
 */
export const DEFAULT_GRAPH_TIER_THRESHOLDS: GraphTierThresholdsV1 = Object.freeze({
  schemaVersion: GRAPH_TIER_THRESHOLDS_SCHEMA_VERSION,
  tierAMaxNodes: 26,
  tierAMaxEdges: 27,
  tierBMaxNodes: 62,
  tierBMaxEdges: 66,
  measuredAt: '2026-08-27',
  corpusSize: 13221,
});

export type GraphComplexityInput = { nodeCount: number; edgeCount: number };

function tierForCount(count: number, tierAMax: number, tierBMax: number): 'A' | 'B' | 'C' {
  if (count <= tierAMax) return 'A';
  if (count <= tierBMax) return 'B';
  return 'C';
}

const SEVERITY: Record<'A' | 'B' | 'C', number> = { A: 0, B: 1, C: 2 };

/**
 * Classifies from plain counts, so a caller already holding
 * `{ nodeCount, edgeCount }` (e.g. `EntryStructure`'s `nodeCount`/
 * `connectionCount`) never has to construct a chart just to ask which tier it
 * falls in. That substitution is verified, not assumed: the measurement run
 * these thresholds came from also compared `entry.structure` against the
 * chart-derived counts across all 13,221 entries and found 100% agreement on
 * both fields — `repair-connections.ts` is what makes that true (it once
 * wasn't; see its own doc comment), so re-check this if that repair is ever
 * reverted or a new ingestion path bypasses it. `graphComplexityInputFromChart`
 * below is the equivalent for a caller holding a `WorkflowChart` instead.
 */
export function classifyGraphTier(
  input: GraphComplexityInput | null | undefined,
  thresholds: GraphTierThresholdsV1 = DEFAULT_GRAPH_TIER_THRESHOLDS,
): GraphTier {
  if (!input || !Number.isFinite(input.nodeCount) || !Number.isFinite(input.edgeCount) || input.nodeCount <= 0) {
    return 'invalid';
  }
  const nodeTier = tierForCount(input.nodeCount, thresholds.tierAMaxNodes, thresholds.tierBMaxNodes);
  const edgeTier = tierForCount(Math.max(0, input.edgeCount), thresholds.tierAMaxEdges, thresholds.tierBMaxEdges);
  return SEVERITY[nodeTier] >= SEVERITY[edgeTier] ? nodeTier : edgeTier;
}

/** Resolves a real chart down to the two counts `classifyGraphTier` needs. */
export function graphComplexityInputFromChart(
  chart: Pick<WorkflowChart, 'nodes' | 'edges'> | null | undefined,
): GraphComplexityInput {
  if (!chart || !Array.isArray(chart.nodes) || chart.nodes.length === 0) {
    return { nodeCount: 0, edgeCount: 0 };
  }
  const graph = buildFunctionalGraph(chart);
  return { nodeCount: graph.nodeIds.length, edgeCount: graph.edgeCount };
}
