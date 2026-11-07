import fs from 'node:fs';
import path from 'node:path';
import { classifyChart } from './lib/catalogue-claim-freshness.mjs';

/**
 * Explain why an entry's published graph cannot render.
 *
 * This is a DIAGNOSTIC, not the artifact producer. `data/quarantine-report.json`
 * is written by the packager (`pipeline/package/quarantine.ts` via
 * `prepareCatalogueClaims`), which is the only thing that can keep the report
 * and the catalogue consistent. Two writers of one artifact would drift.
 *
 * What this adds is the *reason*, at a level of detail the packaged report does
 * not carry. Running it is how the id-collision defect in `classifyChart` was
 * found: 18 charts whose node ids had all been redacted to one token resolved
 * every edge to the same node and looked like self-loops.
 *
 * `classifyChart` is the authority on what counts as unrenderable. This module
 * calls it rather than restating its rule, because the freshness gate compares
 * the report against the same predicate: any divergence produces a gate that
 * can never be satisfied. The only thing added here is *why* — the gate needs a
 * non-empty reason per entry, and a reader deserves better than "quarantined".
 *
 *   node scripts/build-quarantine-report.mjs [dataDir] > data/quarantine-report.json
 */

function isFunctional(node) {
  // Mirrors `classifyChart`'s own notion of a functional node. Sticky notes are
  // annotations: a workflow of two sticky notes and nothing else is not a
  // disconnected graph, it is a graph with no nodes worth connecting.
  return node?.isAnnotation !== true && !String(node?.type ?? '').toLowerCase().includes('stickynote');
}

function reasonsFor(chart) {
  if (!chart) return ['no chart artifact was packaged for this entry'];

  const nodes = Array.isArray(chart.nodes) ? chart.nodes : [];
  const edges = Array.isArray(chart.edges) ? chart.edges : [];
  const functional = nodes.filter(isFunctional);

  const refs = new Set();
  for (const node of functional) {
    for (const ref of [node?.id, node?.name]) {
      if (typeof ref === 'string' && ref.length > 0) refs.add(ref);
    }
  }

  if (edges.length === 0) {
    return [
      `the packaged workflow declares ${functional.length} functional nodes and no connections at all`,
    ];
  }

  const phantom = edges.filter((edge) => !refs.has(edge?.from) || !refs.has(edge?.to)).length;
  const reasons = [
    `graph has ${functional.length} functional nodes and no edge resolving between two of them`,
  ];
  if (phantom > 0) {
    reasons.push(
      `${phantom} of ${edges.length} connection${edges.length === 1 ? '' : 's'} ` +
      `reference${phantom === 1 ? 's' : ''} a node absent from the workflow`,
    );
  }
  return reasons;
}

/**
 * @param {Array<{id: string}>} entries every entry considered for publication
 * @param {Map<string, unknown>} chartsById the packaged chart per entry id
 */
export function buildQuarantineReport(entries, chartsById) {
  const quarantined = [];
  for (const entry of entries) {
    if (classifyChart(chartsById.get(entry.id)) !== 'quarantine') continue;
    quarantined.push({ id: entry.id, reasons: reasonsFor(chartsById.get(entry.id)) });
  }
  // Sorted by id: the report is committed, so its diff must reflect a change in
  // the corpus and not a change in shard iteration order.
  quarantined.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    schemaVersion: 'quarantine-report-v1',
    totalInput: entries.length,
    published: entries.length - quarantined.length,
    quarantined: quarantined.length,
    entries: quarantined,
  };
}

/** Read the packaged catalogue shards and their positionally-aligned charts. */
export function readCatalogue(dataDir) {
  const entries = [];
  const chartsById = new Map();
  for (let shard = 0; ; shard += 1) {
    const cataloguePath = path.join(dataDir, `catalogue-${shard}.json`);
    if (!fs.existsSync(cataloguePath)) break;
    const shardEntries = JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
    entries.push(...shardEntries);

    const chartPath = path.join(dataDir, 'charts', `chart-${shard}.jsonl`);
    const lines = fs.existsSync(chartPath)
      ? fs.readFileSync(chartPath, 'utf8').split('\n').filter(Boolean)
      : [];
    for (let index = 0; index < Math.min(shardEntries.length, lines.length); index += 1) {
      try {
        chartsById.set(shardEntries[index].id, JSON.parse(lines[index]));
      } catch {
        // A malformed chart line leaves the id unmapped, which classifies as
        // quarantine — the same verdict the gate reaches for it.
      }
    }
  }
  return { entries, chartsById };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const dataDir = path.resolve(process.argv[2] ?? 'data');
  const { entries, chartsById } = readCatalogue(dataDir);
  process.stdout.write(`${JSON.stringify(buildQuarantineReport(entries, chartsById), null, 2)}\n`);
}
