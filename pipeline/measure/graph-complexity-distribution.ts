/**
 * Measures graph-complexity distributions across the shipped corpus, to
 * replace the draft 50/200-node preview-tier boundary (never validated
 * against real data — see `docs/audit/2026-08-26/checkpoints/orchestrator-
 * state.md` line 125 and `openspec/changes/workflow-detail-and-canvas/
 * proposal.md`) with thresholds read off actual percentiles.
 *
 * Reads every entry's `WorkflowChart` (the exact node/edge set a static
 * preview or interactive canvas would render — already capped at 400 nodes
 * and connection-repaired by `pipeline/enrich/chart.ts`) via its `chartRef`
 * byte range into `data/charts/chart-*.jsonl`, and reports, per dimension:
 * count, min, p50, p75, p90, p95, p99, p99.9, max.
 *
 * Dimensions: raw node count, functional (non-annotation) node count, edge
 * count (resolved, functional-to-functional only — the same filter
 * `pipeline/derive/structure.ts` applies), connected-component count, cycle
 * presence, BFS depth, per-entry max node-label length, annotation count,
 * and an estimated rendered-DOM-element count (see `pipeline/derive/
 * graph-tiers.ts` for the calibration this reuses, so the two cannot drift).
 *
 * Usage: npx tsx pipeline/measure/graph-complexity-distribution.ts [--json]
 */
import * as fs from 'node:fs';
import type { ChartRef, WorkflowChart } from '@hub/contracts';
import {
  buildFunctionalGraph,
  computeGraphMetrics,
  estimateDomElements,
} from '../derive/graph-metrics.js';

const DATA_DIR = 'data';

type Entry = {
  id: string;
  chartRef?: ChartRef;
  structure?: { nodeCount?: number; connectionCount?: number };
};

function readEntries(): Entry[] {
  const entries: Entry[] = [];
  for (const file of fs.readdirSync(DATA_DIR)) {
    if (!/^catalogue-\d+\.json$/.test(file)) continue;
    const arr = JSON.parse(fs.readFileSync(`${DATA_DIR}/${file}`, 'utf8')) as Entry[];
    entries.push(...arr);
  }
  return entries;
}

/** One shard file read once, then sliced per entry by byte offset. */
function loadShards(entries: Entry[]): Map<number, Buffer> {
  const shards = new Set(entries.map((e) => e.chartRef?.shard).filter((s): s is number => s !== undefined));
  const buffers = new Map<number, Buffer>();
  for (const shard of shards) {
    buffers.set(shard, fs.readFileSync(`${DATA_DIR}/charts/chart-${shard}.jsonl`));
  }
  return buffers;
}

function readChart(entry: Entry, shards: Map<number, Buffer>): WorkflowChart | null {
  const ref = entry.chartRef;
  if (!ref) return null;
  const buf = shards.get(ref.shard);
  if (!buf) return null;
  const raw = buf.subarray(ref.offset, ref.offset + ref.length).toString('utf8').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw.split('\n')[0]) as WorkflowChart;
  } catch {
    return null;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(values: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    p999: percentile(sorted, 99.9),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length ? Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2)) : 0,
  };
}

const entries = readEntries();
const shards = loadShards(entries);

const rawNodeCounts: number[] = [];
const functionalNodeCounts: number[] = [];
const edgeCounts: number[] = [];
const componentCounts: number[] = [];
const depths: number[] = [];
const maxLabelLengths: number[] = [];
const allLabelLengths: number[] = [];
const annotationCounts: number[] = [];
const estimatedDomCounts: number[] = [];
let cyclicEntries = 0;
let invalidEntries = 0;
let disconnectedEntries = 0; // more than one component among >=2 functional nodes

// `classifyGraphTier`'s doc comment says a caller may pass `entry.structure`
// counts directly instead of fetching the chart. That is only safe if the two
// sources actually agree — `repair-connections.ts` exists precisely because
// they have not always agreed on this corpus (1,745 workflows once reported a
// connection count with no matching chart edge). Measured, not assumed.
let nodeCountAgrees = 0;
let connectionCountAgrees = 0;
let structureComparable = 0;

for (const entry of entries) {
  const chart = readChart(entry, shards);
  if (!chart || !Array.isArray(chart.nodes) || chart.nodes.length === 0) {
    invalidEntries += 1;
    continue;
  }

  const rawNodeCount = chart.nodes.length;
  const graph = buildFunctionalGraph(chart);
  const metrics = computeGraphMetrics(graph);

  rawNodeCounts.push(rawNodeCount);
  functionalNodeCounts.push(graph.nodeIds.length);
  edgeCounts.push(graph.edgeCount);
  componentCounts.push(metrics.componentCount);
  depths.push(metrics.maxDepth);
  annotationCounts.push(rawNodeCount - graph.nodeIds.length);
  if (metrics.hasCycle) cyclicEntries += 1;
  if (graph.nodeIds.length >= 2 && metrics.componentCount > 1) disconnectedEntries += 1;

  let maxLabel = 0;
  for (const node of chart.nodes) {
    const len = typeof node.name === 'string' ? node.name.length : 0;
    allLabelLengths.push(len);
    if (len > maxLabel) maxLabel = len;
  }
  maxLabelLengths.push(maxLabel);

  // Functional counts, matching the calibration basis exactly: the audited
  // "206 nodes/183 edges" workflow (slug `...advanced-multi-agent-ai-personal-
  // assistant...-1cf24317`) has `entry.structure.nodeCount` 206 and
  // `connectionCount` 183 — its *functional* counts — while its chart's raw
  // node count is 213 (7 annotations). Feeding rawNodeCount here instead would
  // score every annotation-heavy entry on a basis the calibration anchor
  // never used.
  estimatedDomCounts.push(estimateDomElements(graph.nodeIds.length, graph.edgeCount));

  if (entry.structure && typeof entry.structure.nodeCount === 'number') {
    structureComparable += 1;
    if (entry.structure.nodeCount === graph.nodeIds.length) nodeCountAgrees += 1;
    if (entry.structure.connectionCount === graph.edgeCount) connectionCountAgrees += 1;
  }
}

const report = {
  source: `${entries.length} entries across ${new Set(entries.map((e) => e.chartRef?.shard)).size} chart shards`,
  totalEntries: entries.length,
  invalidEntries,
  invalidEntriesPct: `${((invalidEntries / entries.length) * 100).toFixed(2)}%`,
  cyclicEntries,
  cyclicEntriesPct: `${((cyclicEntries / (entries.length - invalidEntries)) * 100).toFixed(2)}%`,
  disconnectedEntries,
  disconnectedEntriesPct: `${((disconnectedEntries / (entries.length - invalidEntries)) * 100).toFixed(2)}%`,
  rawNodeCount: summarize(rawNodeCounts),
  functionalNodeCount: summarize(functionalNodeCounts),
  edgeCount: summarize(edgeCounts),
  componentCount: summarize(componentCounts),
  depth: summarize(depths),
  annotationCount: summarize(annotationCounts),
  maxLabelLengthPerEntry: summarize(maxLabelLengths),
  labelLengthPooled: summarize(allLabelLengths),
  estimatedDomElements: summarize(estimatedDomCounts),
  structureVsChartAgreement: {
    comparable: structureComparable,
    nodeCountAgreesPct: `${((nodeCountAgrees / structureComparable) * 100).toFixed(2)}%`,
    connectionCountAgreesPct: `${((connectionCountAgrees / structureComparable) * 100).toFixed(2)}%`,
  },
};

console.log(JSON.stringify(report, null, 2));
