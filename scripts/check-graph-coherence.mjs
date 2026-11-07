#!/usr/bin/env node
/**
 * G-1 — a catalogued workflow's connections must resolve to its own nodes.
 *
 * Twelve gates passed while 85.5% of the redistributable corpus carried
 * connection graphs that do not resolve. Every one of them was honest: they
 * assert that artifacts are *well-formed* — the shard hashes, the package is
 * complete, the bytes match — and none asserts that the workflow inside is
 * coherent. `check:corpus` proves a shard is intact; nothing proved the
 * workflow in it would run.
 *
 * What this catches, from the 2026-08-25 audit:
 *
 *   - 22,056 of 198,155 chart edges name a target that is not in `nodes[]`,
 *     almost all of the synthetic shape `error-handler-<uuid>-<hash>`.
 *   - 1,105 charts lose every edge that way; another 650 carry none at all.
 *   - `structure.connectionCount` counts the phantom ones, so the catalogue
 *     advertised 144 connections for a workflow that has zero resolvable ones.
 *
 * Reports per source, because a bad source is a fact about the source and not
 * about the scattered entries it produced — that visibility is what would have
 * made this obvious at ingest rather than in an audit.
 *
 * Usage: node scripts/check-graph-coherence.mjs [dataDir] [--max-broken N]
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dataDir = args.find((arg) => !arg.startsWith('--')) ?? 'data';
const maxBrokenIndex = args.indexOf('--max-broken');
/** Tolerance, so the gate can be landed before the corpus is repaired. 0 once it is. */
const maxBroken = maxBrokenIndex === -1 ? 0 : Number(args[maxBrokenIndex + 1] ?? 0);

const isAnnotation = (node) =>
  node?.isAnnotation === true || String(node?.type ?? '').toLowerCase().includes('stickynote');

function sourceOf(entry) {
  const url = entry?.source?.url || entry?.source?.permalink || '';
  const match = url.match(/github\.com\/([^/]+\/[^/]+)/);
  if (match) return match[1];
  return entry?.source?.kind === 'n8n_official' ? 'n8n.io (official)' : 'other';
}

const bySource = new Map();
const bump = (source, field) => {
  const row = bySource.get(source) ?? { entries: 0, noResolvableEdges: 0, danglingEdges: 0, countMismatch: 0, redistributableBroken: 0 };
  row[field] += 1;
  bySource.set(source, row);
};

let entriesChecked = 0;
let danglingTotal = 0;
let declaredTotal = 0;
const failures = [];

for (let shard = 0; ; shard += 1) {
  const cataloguePath = path.join(dataDir, `catalogue-${shard}.json`);
  const chartPath = path.join(dataDir, 'charts', `chart-${shard}.jsonl`);
  if (!fs.existsSync(cataloguePath)) break;
  if (!fs.existsSync(chartPath)) {
    failures.push(`shard ${shard}: catalogue exists but ${chartPath} does not`);
    continue;
  }

  const entries = JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
  const charts = fs.readFileSync(chartPath, 'utf8').split('\n').filter((line) => line.trim());
  if (entries.length !== charts.length) {
    failures.push(`shard ${shard}: ${entries.length} entries but ${charts.length} charts — index alignment is assumed by this gate`);
  }

  for (let index = 0; index < Math.min(entries.length, charts.length); index += 1) {
    const entry = entries[index];
    let chart;
    try { chart = JSON.parse(charts[index]); } catch { failures.push(`shard ${shard} line ${index}: unparseable chart`); continue; }

    entriesChecked += 1;
    const source = sourceOf(entry);
    bump(source, 'entries');

    const nodes = Array.isArray(chart.nodes) ? chart.nodes : [];
    const edges = Array.isArray(chart.edges) ? chart.edges : [];
    const references = new Set(nodes.flatMap((node) => [node?.id, node?.name]).filter(Boolean));
    const functional = nodes.filter((node) => !isAnnotation(node));
    const functionalRefs = new Set(functional.flatMap((node) => [node?.id, node?.name]).filter(Boolean));

    declaredTotal += edges.length;
    const dangling = edges.filter((edge) => !references.has(edge?.from) || !references.has(edge?.to));
    danglingTotal += dangling.length;
    if (dangling.length > 0) bump(source, 'danglingEdges');

    const resolvable = edges.filter((edge) => functionalRefs.has(edge?.from) && functionalRefs.has(edge?.to));

    // A workflow with two or more nodes that do work, and no way for data to
    // pass between them, is not a workflow.
    if (functional.length >= 2 && resolvable.length === 0) {
      bump(source, 'noResolvableEdges');
      if (entry?.rights?.status === 'redistributable') bump(source, 'redistributableBroken');
    }

    const declaredCount = entry?.structure?.connectionCount;
    if (typeof declaredCount === 'number' && declaredCount !== resolvable.length) {
      bump(source, 'countMismatch');
    }
  }
}

if (entriesChecked === 0) {
  console.error(`Graph coherence gate found no catalogue shards in ${dataDir}/`);
  process.exit(1);
}

const rows = [...bySource].sort((a, b) => b[1].noResolvableEdges - a[1].noResolvableEdges);
const totals = rows.reduce((acc, [, row]) => ({
  noResolvableEdges: acc.noResolvableEdges + row.noResolvableEdges,
  redistributableBroken: acc.redistributableBroken + row.redistributableBroken,
  countMismatch: acc.countMismatch + row.countMismatch,
}), { noResolvableEdges: 0, redistributableBroken: 0, countMismatch: 0 });

console.log('source'.padEnd(42), 'entries'.padStart(8), 'no edges'.padStart(9), 'redist'.padStart(7), 'count≠'.padStart(7));
for (const [source, row] of rows) {
  if (row.noResolvableEdges === 0 && row.countMismatch === 0) continue;
  console.log(
    source.slice(0, 41).padEnd(42),
    String(row.entries).padStart(8),
    String(row.noResolvableEdges).padStart(9),
    String(row.redistributableBroken).padStart(7),
    String(row.countMismatch).padStart(7),
  );
}
console.log('');
console.log(`entries checked                       ${entriesChecked}`);
console.log(`declared connection targets           ${declaredTotal}`);
console.log(`targets naming a node that is absent  ${danglingTotal}`);
console.log(`entries with no resolvable connection ${totals.noResolvableEdges}`);
console.log(`  ...offered for download             ${totals.redistributableBroken}`);
console.log(`structure.connectionCount mismatches  ${totals.countMismatch}`);

if (failures.length) {
  console.error(`\nGraph coherence gate failed:\n${failures.join('\n')}`);
  process.exit(1);
}

// A broken workflow nobody can download is a data-quality problem. A broken
// workflow we hand people as a file is a promise we are not keeping, so that is
// the number the gate blocks on.
if (totals.redistributableBroken > maxBroken) {
  console.error(
    `\nGraph coherence gate failed: ${totals.redistributableBroken} redistributable entries have ` +
    `no resolvable connections (tolerance ${maxBroken}). These are offered as downloads and will ` +
    `not import correctly. See docs/audit/2026-08-25/01-CORPUS-INTEGRITY.md.`,
  );
  process.exit(1);
}

console.log(`\nGraph coherence gate passed (${totals.redistributableBroken} broken downloadable entries, tolerance ${maxBroken}).`);
