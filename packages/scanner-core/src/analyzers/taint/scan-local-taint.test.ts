import { describe, expect, it, vi } from 'vitest';
import type { AnalyzerContextV2 } from '../../capabilities/scheduler';
import type { AnalysisDiagnostic, ScanFinding } from '../../policy/policy';
import { createScanLocalTaint, type TaintOutcomeV1 } from './scan-local-taint';

const context = {} as AnalyzerContextV2;
const finding = { policyId: 'TAINTED_COMMAND' } as ScanFinding;
const diagnostic = { code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' } as AnalysisDiagnostic;
const outcome = (overrides: Partial<TaintOutcomeV1> = {}): TaintOutcomeV1 => ({
  status: 'COMPLETE', findings: [finding], diagnostics: [diagnostic], ...overrides,
});

describe('scan-local taint accessor', () => {
  it('computes once for two consumers and returns the same frozen result', () => {
    const compute = vi.fn(() => outcome());
    const getTaint = createScanLocalTaint(context, compute);
    const first = getTaint();
    const second = getTaint();

    expect(compute).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.findings)).toBe(true);
    expect(Object.isFrozen(first.diagnostics)).toBe(true);
  });

  it('creates a separate producer per scan', () => {
    const first = createScanLocalTaint(context, () => outcome());
    const second = createScanLocalTaint(context, () => outcome({ status: 'LIMITED' }));
    expect(first().status).toBe('COMPLETE');
    expect(second().status).toBe('LIMITED');
  });

  it('memoizes typed failure and rejects reentrant access', () => {
    const failing = createScanLocalTaint(context, () => { throw new Error('boom'); });
    expect(failing()).toMatchObject({ status: 'FAILED', findings: [], diagnostics: [] });
    expect(failing()).toEqual(failing());

    let getTaint: (() => TaintOutcomeV1) | undefined;
    getTaint = createScanLocalTaint(context, () => {
      expect(getTaint?.().status).toBe('FAILED');
      // A nested failure must win even when the outer compute would otherwise return COMPLETE.
      return { ...outcome(), status: 'COMPLETE' };
    });
    expect(getTaint().status).toBe('FAILED');
    expect(getTaint().status).toBe('FAILED');
    expect(getTaint().findings).toEqual([]);
  });

  it('does not expose a mutable cached object to consumers', () => {
    const getTaint = createScanLocalTaint(context, () => outcome());
    const first = getTaint();
    expect(() => { (first.findings as ScanFinding[]).push(finding); }).toThrow(TypeError);
    expect(getTaint().findings).toHaveLength(1);
  });
});
