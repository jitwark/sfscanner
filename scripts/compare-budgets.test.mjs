import { describe, expect, it } from 'vitest';
import { compareBudgets } from './compare-budgets.mjs';

const budgets = {
  routes: { '/': { initialGzipBytes: 100 }, '/library/': { initialGzipBytes: 200 } },
  firstInteraction: { gzipBytes: 300 },
  export: { files: 10, rawBytes: 1000, htmlBytes: 900 },
};

const snapshot = {
  routes: { '/': { initialGzipBytes: 99 }, '/library/': { initialGzipBytes: 200 } },
  firstInteraction: { gzipBytes: 300 },
  export: { files: 10, rawBytes: 1000, htmlBytes: 900 },
};

describe('compareBudgets', () => {
  it('accepts values at or below every ratchet', () => expect(compareBudgets(budgets, snapshot)).toEqual([]));

  it('reads a note beside the export metrics as prose, not as a ratchet', () => {
    // Every route budget carries its justification next to its number. The
    // export block could not, because its keys are iterated as metrics — a
    // `note` there was reported as "missing or non-numeric measurement", which
    // pushed the reasoning for the cap away from the cap.
    const withNote = { ...budgets, export: { ...budgets.export, note: 'raised on 2026-09-04' } };
    expect(compareBudgets(withNote, snapshot)).toEqual([]);
  });

  it('names every exceeded metric', () => {
    const failures = compareBudgets(budgets, {
      ...snapshot,
      routes: { '/': { initialGzipBytes: 101 }, '/library/': { initialGzipBytes: 201 } },
      export: { files: 11, rawBytes: 1001, htmlBytes: 901 },
    });
    expect(failures).toEqual([
      '/ initialGzipBytes: measured 101, budget 100',
      '/library/ initialGzipBytes: measured 201, budget 200',
      'export files: measured 11, budget 10',
      'export rawBytes: measured 1001, budget 1000',
      'export htmlBytes: measured 901, budget 900',
    ]);
  });
});
