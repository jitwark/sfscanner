import { describe, expect, it } from 'vitest';
import {
  corroboratedCapabilityStatus,
  countInconsistency,
  countLatticeEffect,
  omissionInconsistency,
  recordsUnperformedWork,
  strongestAnalysisStatus,
} from './count-lattice';

const counts = (seen: number, analyzed: number, skipped: number, omitted: number) => ({ seen, analyzed, skipped, omitted });

describe('countInconsistency', () => {
  it('admits every counter shape the shipped analyzers and the scheduler produce', () => {
    // A fully analyzed unit, a workflow-level stage with one unit, a unit analyzed in a finer
    // unit system than it was seen, an unanalysed workflow scope, and a dependency-skipped stage.
    expect(countInconsistency(counts(1, 1, 0, 0), 1)).toBeNull();
    expect(countInconsistency(counts(1, 1, 0, 1), 1)).toBeNull();
    expect(countInconsistency(counts(3, 1, 1, 1), 3)).toBeNull();
    expect(countInconsistency(counts(0, 0, 0, 0), 0)).toBeNull();
    expect(countInconsistency(counts(0, 0, 1, 1), 0)).toBeNull();
  });

  it('refuses counts that claim analysis of units the capability never accounted for', () => {
    expect(countInconsistency(counts(1, 4, 0, 0), 1)).toBe('UNSEEN_ANALYSIS');
    expect(countInconsistency(counts(2, 3, 0, 0), 2)).toBe('UNSEEN_ANALYSIS');
  });

  it('refuses counts that leave seen units unaccounted for', () => {
    expect(countInconsistency(counts(3, 1, 0, 1), 0)).toBe('UNACCOUNTED_SEEN');
    expect(countInconsistency(counts(1, 0, 0, 0), 0)).toBe('UNACCOUNTED_SEEN');
  });

  it('refuses zero observed work where the parser contract says work was eligible', () => {
    expect(countInconsistency(counts(0, 0, 0, 0), 1)).toBe('ZERO_ELIGIBLE_WORK');
  });

  it('refuses an eligibility unit count that is not a non-negative safe integer', () => {
    expect(countInconsistency(counts(1, 1, 0, 0), -1)).toBe('ELIGIBLE_UNITS_UNKNOWN');
    expect(countInconsistency(counts(1, 1, 0, 0), 1.5)).toBe('ELIGIBLE_UNITS_UNKNOWN');
    expect(countInconsistency(counts(1, 1, 0, 0), Number.MAX_SAFE_INTEGER + 2)).toBe('ELIGIBLE_UNITS_UNKNOWN');
  });

  it('does not round the account of counters near the safe-integer ceiling', () => {
    const ceiling = Number.MAX_SAFE_INTEGER;
    expect(countInconsistency(counts(ceiling, ceiling, 0, 0), 0)).toBeNull();
    expect(countInconsistency(counts(ceiling, 0, 0, 0), 0)).toBe('UNACCOUNTED_SEEN');
    expect(countInconsistency(counts(1, ceiling, 0, 0), 0)).toBe('UNSEEN_ANALYSIS');
  });
});

describe('omissionInconsistency', () => {
  it('refuses a truncating diagnostic while the counters claim nothing was omitted', () => {
    expect(omissionInconsistency(counts(1, 1, 0, 0), [{ omitted: 1 }])).toBe('UNRECORDED_OMISSION');
    expect(omissionInconsistency(counts(1, 1, 0, 1), [{ omitted: 1 }])).toBeNull();
    expect(omissionInconsistency(counts(1, 1, 0, 0), [])).toBeNull();
    expect(omissionInconsistency(counts(1, 1, 0, 0), [{}])).toBeNull();
  });
});

describe('countLatticeEffect', () => {
  it('imposes nothing on a count set with no skipped or omitted work', () => {
    expect(recordsUnperformedWork(counts(2, 2, 0, 0))).toBe(false);
    expect(countLatticeEffect(counts(2, 2, 0, 0), true)).toBe('NONE');
    expect(countLatticeEffect(counts(2, 2, 0, 0), false)).toBe('NONE');
  });

  it('degrades recorded skip and optional omission, and makes a required omission indeterminate', () => {
    expect(countLatticeEffect(counts(3, 1, 2, 0), true)).toBe('DEGRADED');
    expect(countLatticeEffect(counts(3, 1, 2, 0), false)).toBe('DEGRADED');
    expect(countLatticeEffect(counts(2, 2, 0, 1), false)).toBe('DEGRADED');
    expect(countLatticeEffect(counts(2, 2, 0, 1), true)).toBe('INDETERMINATE');
  });
});

describe('corroboratedCapabilityStatus', () => {
  it('degrades a completed claim that its own counts contradict', () => {
    expect(corroboratedCapabilityStatus('COMPLETED', counts(3, 1, 2, 0))).toBe('DEGRADED');
    expect(corroboratedCapabilityStatus('COMPLETED', counts(2, 2, 0, 1))).toBe('DEGRADED');
    expect(corroboratedCapabilityStatus('COMPLETED', counts(2, 2, 0, 0))).toBe('COMPLETED');
  });

  it('never raises a weaker outcome, because counts record loss rather than proof of work', () => {
    expect(corroboratedCapabilityStatus('FAILED', counts(2, 2, 0, 0))).toBe('FAILED');
    expect(corroboratedCapabilityStatus('SKIPPED', counts(0, 0, 1, 1))).toBe('SKIPPED');
    expect(corroboratedCapabilityStatus('DEGRADED', counts(2, 2, 0, 0))).toBe('DEGRADED');
  });
});

describe('strongestAnalysisStatus', () => {
  it('publishes the status the evidence derives when the claim is weaker or unknown', () => {
    expect(strongestAnalysisStatus('COMPLETE', 'DEGRADED')).toBe('DEGRADED');
    expect(strongestAnalysisStatus(undefined, 'INDETERMINATE')).toBe('INDETERMINATE');
    expect(strongestAnalysisStatus('BROKEN', 'COMPLETE')).toBe('COMPLETE');
  });

  it('keeps a stronger claim, which the result contract then has to accept or reject', () => {
    expect(strongestAnalysisStatus('INDETERMINATE', 'COMPLETE')).toBe('INDETERMINATE');
    expect(strongestAnalysisStatus('DEGRADED', 'COMPLETE')).toBe('DEGRADED');
    expect(strongestAnalysisStatus('COMPLETE', 'COMPLETE')).toBe('COMPLETE');
  });
});
