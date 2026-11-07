#!/usr/bin/env node
/** Compare a measured snapshot with the machine-readable performance ratchets. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const defaultBudgets = resolve(root, 'docs/perf/budgets.json');
const defaultSnapshot = resolve(root, 'pipeline/.work/performance-budget-snapshot.json');

function check(failures, label, actual, limit) {
  if (!Number.isFinite(actual)) {
    failures.push(`${label}: missing or non-numeric measurement`);
    return;
  }
  const status = actual <= limit ? 'ok' : 'OVER';
  process.stdout.write(`  ${label.padEnd(36)} ${String(actual).padStart(10)} / ${limit} ${status}\n`);
  if (actual > limit) failures.push(`${label}: measured ${actual}, budget ${limit}`);
}

export function compareBudgets(budgets, snapshot) {
  const failures = [];
  for (const [route, budget] of Object.entries(budgets.routes ?? {})) {
    check(failures, `${route} initialGzipBytes`, snapshot.routes?.[route]?.initialGzipBytes, budget.initialGzipBytes);
  }
  check(failures, 'firstInteraction gzipBytes', snapshot.firstInteraction?.gzipBytes, budgets.firstInteraction?.gzipBytes);
  for (const [metric, limit] of Object.entries(budgets.export ?? {})) {
    // Route budgets keep their justification beside their number; the export
    // block iterates its keys as metrics, so a `note` there was reported as a
    // missing measurement. Skipping prose keeps the reasoning for a cap next to
    // the cap instead of exiling it to the top of the file.
    if (typeof limit === 'string') continue;
    check(failures, `export ${metric}`, snapshot.export?.[metric], limit);
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const snapshotPath = process.argv[2] ? resolve(process.argv[2]) : defaultSnapshot;
  const budgetsPath = process.argv[3] ? resolve(process.argv[3]) : defaultBudgets;
  const [budgets, snapshot] = await Promise.all([
    readFile(budgetsPath, 'utf8').then(JSON.parse),
    readFile(snapshotPath, 'utf8').then(JSON.parse),
  ]);
  process.stdout.write(`Comparing ${snapshotPath} against ${budgetsPath}\n`);
  const failures = compareBudgets(budgets, snapshot);
  if (failures.length) {
    process.stderr.write(`\nPerformance budget regressions:\n${failures.map((failure) => `  - ${failure}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('Performance budgets passed.\n');
}
