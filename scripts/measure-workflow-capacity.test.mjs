import { describe, expect, it } from 'vitest';
import { violation } from './measure-workflow-capacity.mjs';

/**
 * The evidence script's classification gate, exercised without spawning a fixture. The records are
 * shaped like a child's JSON line; this proves an inconsistent row cannot be printed as PASS.
 */
const SPAN_ROW = { id: 'maxStoredSourceSpans', maximum: 25_000 };

const admitted = (count, status, examined, omitted) => ({
  schemaVersion: 'scanner-capacity-audit-v1',
  count,
  exit: 0,
  timedOut: false,
  ok: true,
  status,
  examinedNodes: count,
  diagnostics: omitted > 0 ? ['OPTIONAL_LIMIT_EXCEEDED'] : [],
  spanUsage: { ...SPAN_ROW, examined, omitted, exhausted: omitted > 0 },
});

const rejected = (overrides = {}) => ({
  schemaVersion: 'scanner-capacity-audit-v1',
  count: 5001,
  exit: 0,
  timedOut: false,
  ok: false,
  status: null,
  examinedNodes: null,
  diagnostics: [],
  spanUsage: null,
  code: 'WORKFLOW_TOO_COMPLEX',
  cause: 'NODE_LIMIT',
  ...overrides,
});

describe('capacity evidence classification', () => {
  it('accepts exactly the four measured classifications', () => {
    expect(violation(admitted(2083, 'COMPLETE', 24_992, 0))).toBeNull();
    expect(violation(admitted(2084, 'DEGRADED', 25_004, 4))).toBeNull();
    expect(violation(admitted(5000, 'DEGRADED', 59_996, 34_996))).toBeNull();
    expect(violation(rejected())).toBeNull();
  });

  it('rejects a 5,000 row that does not carry the recorded degradation', () => {
    expect(violation(admitted(5000, 'COMPLETE', 59_996, 34_996))).toContain('must be DEGRADED');
    expect(violation(admitted(5000, 'DEGRADED', 59_996, 0))).toContain('stored-span omitted');
    expect(violation(admitted(5000, 'DEGRADED', 59_997, 34_996))).toContain('stored-span examined');
  });

  it('rejects drifted span counts, maximums, and optional-diagnostic mismatches', () => {
    expect(violation(admitted(2083, 'COMPLETE', 24_991, 0))).toContain('stored-span examined');
    expect(violation(admitted(2084, 'DEGRADED', 25_004, 5))).toContain('stored-span omitted');
    const wrongBudget = admitted(2083, 'COMPLETE', 24_992, 0);
    wrongBudget.spanUsage.maximum = 30_000;
    expect(violation(wrongBudget)).toContain('stored-span maximum');
    const missingOptional = admitted(2084, 'DEGRADED', 25_004, 4);
    missingOptional.diagnostics = [];
    expect(violation(missingOptional)).toContain('OPTIONAL_LIMIT_EXCEEDED');
  });

  it('rejects a 5,001 record with the wrong cause, a failed child, or a missing child row', () => {
    expect(violation(rejected({ cause: 'EDGE_LIMIT' }))).toContain('NODE_LIMIT');
    expect(violation({ ...rejected(), exit: 1 })).toContain('child exited 1');
    expect(violation({ ...rejected(), timedOut: true })).toContain('deadline');
    const missingRow = { ...admitted(2083, 'COMPLETE', 24_992, 0), spanUsage: null };
    expect(violation(missingRow)).toContain('no stored-span usage row');
  });
});
