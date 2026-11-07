/**
 * Measures what counting sticky notes and no-ops does to published numbers.
 *
 * Every percentage this prints is quoted in `STATUS.md` and
 * `phase-6-hardening.md`, which is the point: process rule 5 says a number in a
 * plan names the sample size and the script that produced it. Re-run this after
 * any change to the exclusion set or the complexity bands.
 *
 *   npx tsx pipeline/measure/node-count-impact.ts [entriesJsonPath] [--json]
 *
 * It scores both ways with the **shipped** functions — `classifyComplexity`,
 * `complexityWeight`, `summarizeIntegrations` — rather than a local copy, so the
 * output cannot drift from what the site actually does. That is also why
 * `summarizeIntegrations` filters nothing itself: the caller chooses the node
 * set, so the same function can score the corpus before and after.
 *
 * Input is the acquisition run's `entries.json`: a JSON array of
 * `{ entry, chart }`, streamed because it is ~250 MB.
 */

import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import {
  classifyComplexity,
  complexityWeight,
  summarizeIntegrations,
  type WorkflowComplexity,
} from '@hub/scanner-core/workflow-insights';
import {
  countFunctionalNodes,
  functionalNodes,
  isSubWorkflow,
  isSubWorkflowTrigger,
} from '@hub/contracts/functional-nodes';
import type { NormalizedWorkflowNode } from '@hub/scanner-core/workflow';

const DEFAULT_ENTRIES = 'pipeline/.work/prod-gh3/entries.json';

type ChartNode = { id?: string; name?: string; type?: string };
type Element = {
  entry?: {
    id?: string;
    security?: { score?: number; grade?: string };
    dedup?: { canonical?: boolean };
  };
  chart?: { nodes?: ChartNode[]; edges?: unknown[] };
};

/** Chart nodes carry only what a diagram needs; the scanner types want a full node. */
function asWorkflowNode(node: ChartNode, index: number): NormalizedWorkflowNode {
  return {
    id: node.id ?? `node-${index}`,
    name: node.name ?? '',
    type: typeof node.type === 'string' ? node.type : '',
    parameters: {},
    sourcePath: '',
  };
}

function gradeOf(score: number): string {
  return score >= 80 ? 'CRITICAL' : score >= 55 ? 'HIGH' : score >= 25 ? 'MEDIUM' : 'LOW';
}

/**
 * Yields each top-level element of a JSON array without holding the file in
 * memory. Depth counting is string- and escape-aware, so a brace inside a
 * workflow title does not desynchronize it.
 */
function* streamArrayElements(path: string): Generator<string> {
  const fd = fs.openSync(path, 'r');
  const chunk = Buffer.alloc(1 << 20);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;

  try {
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      // A 1 MB read can split a multi-byte character; the decoder holds the tail.
      const text = decoder.write(chunk.subarray(0, read));

      // Each chunk is scanned exactly once. An earlier version re-scanned the
      // carried prefix on the next read, counting its braces twice, which
      // desynchronized `depth` and silently dropped 98% of the corpus.
      let segStart = -1;

      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (!started) { if (ch === '[') started = true; continue; }
        if (ch === '{') { if (depth === 0) segStart = i; depth += 1; continue; }
        if (ch === '}') {
          depth -= 1;
          if (depth !== 0) continue;
          yield segStart >= 0 ? text.slice(segStart, i + 1) : pending + text.slice(0, i + 1);
          pending = '';
          segStart = -1;
        }
      }

      // Whatever of the open element this chunk holds is kept for the next read.
      if (depth > 0) pending += segStart >= 0 ? text.slice(segStart) : text;
    }
  } finally {
    fs.closeSync(fd);
  }
}

type Totals = {
  workflows: number;
  rawNodes: number;
  annotationNodes: number;
  bandShifted: number;
  shifts: Map<string, number>;
  scoreDrops: number[];
  subWorkflows: number;
  containsSubWorkflowTrigger: number;
  gradeChanged: number;
  countOverstatedOverQuarter: number;
  integrationShrunk: number;
  losesNodeThreshold: number;
  losesIntegrationThreshold: number;
};

function measure(path: string, canonicalOnly: boolean): Totals {
  const totals: Totals = {
    workflows: 0, rawNodes: 0, annotationNodes: 0, bandShifted: 0,
    shifts: new Map(), scoreDrops: [], subWorkflows: 0, containsSubWorkflowTrigger: 0,
    gradeChanged: 0, countOverstatedOverQuarter: 0, integrationShrunk: 0,
    losesNodeThreshold: 0, losesIntegrationThreshold: 0,
  };

  for (const raw of streamArrayElements(path)) {
    let element: Element;
    try { element = JSON.parse(raw) as Element; } catch { continue; }
    if (canonicalOnly && element.entry?.dedup?.canonical !== true) continue;
    const chartNodes = element.chart?.nodes;
    if (!Array.isArray(chartNodes)) continue;

    const all = chartNodes.map(asWorkflowNode);
    const kept = functionalNodes(all);
    const connectionCount = Array.isArray(element.chart?.edges) ? element.chart.edges.length : 0;

    const oldIntegrations = summarizeIntegrations(all).length;
    const newIntegrations = summarizeIntegrations(kept).length;
    const oldBand: WorkflowComplexity = classifyComplexity(all.length, connectionCount, oldIntegrations);
    const newBand: WorkflowComplexity = classifyComplexity(kept.length, connectionCount, newIntegrations);

    totals.workflows += 1;
    totals.rawNodes += all.length;
    totals.annotationNodes += all.length - kept.length;
    if (newIntegrations < oldIntegrations) totals.integrationShrunk += 1;

    // `isIndexable` gates on `nodeCount >= 3` and at least one integration, and
    // both now read functional values. An entry that was indexable on its
    // sticky notes becomes noindex. That is a search-visibility change caused by
    // a logic change, so it is counted here rather than discovered later as an
    // unexplained drop in a sitemap diff.
    if (all.length >= 3 && kept.length < 3) totals.losesNodeThreshold += 1;
    if (oldIntegrations > 0 && newIntegrations === 0) totals.losesIntegrationThreshold += 1;
    if (isSubWorkflow(all)) totals.subWorkflows += 1;
    // Two definitions, reported separately because they differ by an order of
    // magnitude. The strict one is what earns a warning: a workflow holding both
    // a parent-call trigger and a webhook still runs on its own.
    if (all.some((node) => isSubWorkflowTrigger(node.type))) totals.containsSubWorkflowTrigger += 1;
    if (all.length > 0 && (all.length - kept.length) / all.length > 0.25) {
      totals.countOverstatedOverQuarter += 1;
    }

    if (oldBand !== newBand) {
      totals.bandShifted += 1;
      const key = `${oldBand}->${newBand}`;
      totals.shifts.set(key, (totals.shifts.get(key) ?? 0) + 1);

      const drop = complexityWeight(oldBand) - complexityWeight(newBand);
      totals.scoreDrops.push(drop);

      // A published score is capped at 100, so the observable grade change uses
      // the recorded score rather than the raw weight difference.
      const recorded = element.entry?.security?.score;
      if (typeof recorded === 'number') {
        if (gradeOf(recorded) !== gradeOf(Math.max(0, recorded - drop))) totals.gradeChanged += 1;
      }
    }
  }

  return totals;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '0.0%' : `${((part / whole) * 100).toFixed(1)}%`;
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const canonicalOnly = args.includes('--canonical-only');
const entriesPath = args.find((arg) => !arg.startsWith('--')) ?? DEFAULT_ENTRIES;

if (!fs.existsSync(entriesPath)) {
  console.error(`No entries file at ${entriesPath}. Pass the path to an acquisition run's entries.json.`);
  process.exit(1);
}

const totals = measure(entriesPath, canonicalOnly);
const meanDrop = totals.scoreDrops.length
  ? totals.scoreDrops.reduce((a, b) => a + b, 0) / totals.scoreDrops.length
  : 0;

const report = {
  source: entriesPath,
  scope: canonicalOnly ? 'canonical only' : 'all candidates',
  workflows: totals.workflows,
  rawNodes: totals.rawNodes,
  annotationNodes: totals.annotationNodes,
  annotationShareOfNodes: pct(totals.annotationNodes, totals.rawNodes),
  complexityBandShifted: totals.bandShifted,
  complexityBandShiftedPct: pct(totals.bandShifted, totals.workflows),
  shifts: Object.fromEntries([...totals.shifts].sort()),
  meanRiskScoreOverstatementOnShifted: Number(meanDrop.toFixed(1)),
  securityGradeChanged: totals.gradeChanged,
  securityGradeChangedPct: pct(totals.gradeChanged, totals.workflows),
  integrationCountShrunk: totals.integrationShrunk,
  integrationCountShrunkPct: pct(totals.integrationShrunk, totals.workflows),
  nodeCountOverstatedOverAQuarter: pct(totals.countOverstatedOverQuarter, totals.workflows),
  losesNodeCountIndexThreshold: totals.losesNodeThreshold,
  losesNodeCountIndexThresholdPct: pct(totals.losesNodeThreshold, totals.workflows),
  losesIntegrationIndexThreshold: totals.losesIntegrationThreshold,
  subWorkflowsStrict: totals.subWorkflows,
  subWorkflowsStrictPct: pct(totals.subWorkflows, totals.workflows),
  containsSubWorkflowTrigger: totals.containsSubWorkflowTrigger,
  containsSubWorkflowTriggerPct: pct(totals.containsSubWorkflowTrigger, totals.workflows),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const [key, value] of Object.entries(report)) {
    console.log(`${key.padEnd(36)} ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
}

export { measure, countFunctionalNodes };
