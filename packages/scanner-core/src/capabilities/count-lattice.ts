import type { DiagnosticAggregateEffectV2 } from '../diagnostics/registry';

/**
 * The per-capability work record and the lattice that has to survive it.
 *
 * Every capability declared by a manifest reports `seen / analyzed / skipped / omitted`. Those
 * counters are the capability's own record of the work it did, so they are also the evidence a
 * completeness claim must be consistent with: a capability that records skipped or omitted units
 * has not done the work that a `COMPLETED` row would claim. This module is the single authority for
 * which count sets can describe a run and for what a count set permits a published outcome to say.
 */
export type CapabilityCountsV2 = Readonly<{ seen: number; analyzed: number; skipped: number; omitted: number }>;

/** The capability outcome vocabulary a count set has to corroborate. */
export type CapabilityOutcomeStatusV2 = 'COMPLETED' | 'SKIPPED' | 'DEGRADED' | 'FAILED';

/** The analysis status order `COMPLETE < DEGRADED < INDETERMINATE`. */
export type AnalysisStatusV2 = 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE';

/** Count sets no real run can produce, in the order the boundary reports them. */
export type CountInconsistencyV2 =
  | 'ELIGIBLE_UNITS_UNKNOWN'
  | 'UNSEEN_ANALYSIS'
  | 'UNACCOUNTED_SEEN'
  | 'UNRECORDED_OMISSION'
  | 'ZERO_ELIGIBLE_WORK';

/**
 * Exact `total > sum(parts)` for non-negative safe integers. Subtracting one part at a time keeps
 * every intermediate an exact difference of safe integers, where summing first can round past 2^53.
 */
function exceeds(total: number, parts: readonly [number, number, number]): boolean {
  let remaining = total;
  for (const part of parts) { if (remaining <= part) return false; remaining -= part; }
  return true;
}

/**
 * `analyzed` units were claimed as analyzed and `seen` units as observed. A capability cannot
 * analyze units it never accounted for, and it cannot leave observed units unaccounted for: the
 * unrecorded loss is exactly what would let a derived status read as complete.
 *
 * The counters are deliberately not required to partition `seen`. Analyzers count in their own
 * units — `javascript-security` reports one seen node as one analyzed source plus its recorded
 * omission — so only the two directions that cannot describe any run are refused.
 */
export function countInconsistency(counts: CapabilityCountsV2, eligibleUnits: number): CountInconsistencyV2 | null {
  if (!Number.isSafeInteger(eligibleUnits) || eligibleUnits < 0) return 'ELIGIBLE_UNITS_UNKNOWN';
  if (exceeds(counts.analyzed, [counts.seen, counts.skipped, counts.omitted])) return 'UNSEEN_ANALYSIS';
  if (exceeds(counts.seen, [counts.analyzed, counts.skipped, counts.omitted])) return 'UNACCOUNTED_SEEN';
  if (eligibleUnits > 0 && counts.seen === 0) return 'ZERO_ELIGIBLE_WORK';
  return null;
}

/**
 * A diagnostic that records its own truncation while the counters claim nothing was omitted is the
 * reachable form of silent truncation: the snapshot cannot be both truncated and complete.
 */
export function omissionInconsistency(counts: CapabilityCountsV2, diagnostics: readonly Readonly<{ omitted?: number }>[]): CountInconsistencyV2 | null {
  if (counts.omitted > 0) return null;
  for (const diagnostic of diagnostics) if ((diagnostic.omitted ?? 0) > 0) return 'UNRECORDED_OMISSION';
  return null;
}

/** `skipped` and `omitted` are the units a capability recorded but did not do. */
export function recordsUnperformedWork(counts: CapabilityCountsV2): boolean {
  return counts.skipped > 0 || counts.omitted > 0;
}

/**
 * `COMPLETED` is the one outcome a count set can be inconsistent with: a capability that recorded
 * unperformed work publishes the degraded outcome its counts corroborate. A weaker outcome is never
 * raised by counts, because counts record worked loss, not proof of work.
 */
export function corroboratedCapabilityStatus(status: CapabilityOutcomeStatusV2, counts: CapabilityCountsV2): CapabilityOutcomeStatusV2 {
  return status === 'COMPLETED' && recordsUnperformedWork(counts) ? 'DEGRADED' : status;
}

/**
 * The completeness effect a count set alone imposes. Skipped or omitted units are a bounded,
 * recorded gap in the work the capability was asked to do, so they degrade; an omission from a
 * required capability is unsafe truncation and is indeterminate.
 */
export function countLatticeEffect(counts: CapabilityCountsV2, required: boolean): DiagnosticAggregateEffectV2 {
  if (!recordsUnperformedWork(counts)) return 'NONE';
  return required && counts.omitted > 0 ? 'INDETERMINATE' : 'DEGRADED';
}

/**
 * The lattice order over analysis status. Nothing weaker than the evidence may be published, so a
 * claimed status can only ever be raised to the status the evidence derives; an unknown claim is
 * discarded in favour of the derived status rather than published.
 */
export function strongestAnalysisStatus(claimed: unknown, derived: AnalysisStatusV2): AnalysisStatusV2 {
  if (derived === 'INDETERMINATE' || claimed === 'INDETERMINATE') return 'INDETERMINATE';
  if (derived === 'DEGRADED' || claimed === 'DEGRADED') return 'DEGRADED';
  return 'COMPLETE';
}
