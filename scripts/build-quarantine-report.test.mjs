import { describe, expect, test } from 'vitest';
import { buildQuarantineReport } from './build-quarantine-report.mjs';

/**
 * REL-01 — the catalogue publishes workflow graphs that cannot render.
 *
 * These are not a bug in the chart derivation: commit 020ade17 already fixed
 * the resolver that used to launder a reference-to-nothing into an edge, and
 * `repair-connection-counts.ts --dry-run` reports 0 entries changed against the
 * real corpus. The affected workflows are broken upstream, and raw JSON is
 * retained for only the 288 redistributable entries, so 12,933 of them cannot
 * be re-derived from source either. Withholding them is the only honest
 * remedy available.
 *
 * The report must quarantine EXACTLY what `classifyChart` rejects. If the two
 * ever disagree, the freshness gate fails forever with no way to satisfy it —
 * so this builder delegates the verdict rather than reimplementing it.
 */
const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
const charts = new Map([
  // Renders: two functional nodes joined by an edge that resolves at both ends.
  ['a', { nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [{ from: 'n1', to: 'n2' }] }],
  // No edges at all.
  ['b', { nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [] }],
  // An edge whose source node is not in the workflow.
  ['c', { nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [{ from: 'ghost', to: 'n2' }] }],
  // A single functional node cannot be disconnected from anything.
  ['d', { nodes: [{ id: 'n1' }], edges: [] }],
  // 'e' has no chart at all.
]);

describe('buildQuarantineReport', () => {
  test('quarantines every entry whose graph cannot render, and only those', () => {
    const report = buildQuarantineReport(entries, charts);
    expect(report.entries.map((entry) => entry.id).sort()).toEqual(['b', 'c', 'e']);
  });

  test('every quarantined entry carries at least one reason', () => {
    for (const entry of buildQuarantineReport(entries, charts).entries) {
      expect(entry.reasons.length).toBeGreaterThan(0);
      for (const reason of entry.reasons) expect(typeof reason).toBe('string');
    }
  });

  test('says plainly when the workflow has no connections at all', () => {
    const report = buildQuarantineReport(entries, charts);
    const b = report.entries.find((entry) => entry.id === 'b');
    expect(b.reasons.join(' ')).toMatch(/no connections at all/);
  });

  test('names the phantom connections when a chart has them', () => {
    const report = buildQuarantineReport(entries, charts);
    const c = report.entries.find((entry) => entry.id === 'c');
    expect(c.reasons.join(' ')).toMatch(/1 of 1 connections? references? a node absent/);
  });

  test('says so plainly when a chart artifact is missing entirely', () => {
    const report = buildQuarantineReport(entries, charts);
    const e = report.entries.find((entry) => entry.id === 'e');
    expect(e.reasons.join(' ')).toMatch(/no chart artifact/);
  });

  test('report counts reconcile the way the freshness gate requires', () => {
    // The gate asserts totalInput === publishedEntries.length + quarantinedIds.length
    // and published === publishedEntries.length. Both are checked against the
    // catalogue AFTER removal, so the report describes the transition, not the
    // input.
    const report = buildQuarantineReport(entries, charts);
    expect(report.quarantined).toBe(report.entries.length);
    expect(report.published).toBe(entries.length - report.entries.length);
    expect(report.totalInput).toBe(report.published + report.quarantined);
  });

  test('quarantined ids are unique and non-empty', () => {
    const ids = buildQuarantineReport(entries, charts).entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(typeof id === 'string' && id.length > 0).toBe(true);
  });

  test('orders entries deterministically so the committed report is diffable', () => {
    const forward = buildQuarantineReport(entries, charts).entries.map((entry) => entry.id);
    const reversed = buildQuarantineReport([...entries].reverse(), charts).entries.map((e) => e.id);
    expect(reversed).toEqual(forward);
  });
});
