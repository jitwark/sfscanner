import { describe, expect, it } from 'vitest';
import { validateTargetContextV3 } from '../semantics/target-context';
import { buildAdvisoryFactsV1 } from '../advisories/advisory-evaluation';
import { rekeyFacts } from './rekey-evidence';
import { corroboratedCapabilityStatus, countInconsistency, countLatticeEffect, omissionInconsistency, recordsUnperformedWork, type AnalysisStatusV2, type CapabilityCountsV2 } from '../capabilities/count-lattice';
import { validateScannerResultV2 } from '../../../../contracts/scanner-v2-result';
import { composeScannerResultV2, type ComposeScannerResultV2Input } from './compose-result';

/**
 * `contracts/` cannot import `@hub/scanner-core`, so its boundary validator restates two parts of the
 * completeness lattice: the count arithmetic that decides whether a row's counters describe any run at
 * all, and the effect that decides a published status. This is the pin that keeps the three from
 * drifting: over every count set a capability row can carry, the producer must compose the status the
 * lattice derives, a hand-built result - the input the boundary actually has to distrust - must be
 * accepted for exactly that status and refused for the weaker one, which no producer output reaches,
 * and the boundary must refuse exactly the count sets `countInconsistency` refuses, under its names.
 */

const digest = (letter: string): string => letter.repeat(64);
const ASSESSMENT = {
  score: 0, grade: 'LOW' as const, scoringPolicyVersion: 'secureflow-risk-v2@2.0.0',
  basisFindingIds: [], excludedReportOnlyFindingIds: [], excludedUncertainFindingIds: [], excludedNotApplicableFindingIds: [], unknownEvidenceCount: 0,
};
const ROW_ERROR = 'analysis.capabilities[0] claims COMPLETED while recording skipped or omitted units';
const STATUS_ERROR = 'analysis.status disagrees with capability/diagnostic effects';

type Header = Pick<ComposeScannerResultV2Input, 'engine' | 'input' | 'profile' | 'ruleset' | 'semantics' | 'target' | 'limits' | 'workflow'>;
function header(): Header {
  return {
    engine: { id: 'secureflow-scanner', version: '2.0.0', buildDigest: digest('a') },
    input: { rawSha256: digest('b'), semanticSha256: digest('c'), ambiguitySha256: digest('d'), ambiguityCount: 0, utf8Bytes: 1 },
    profile: { id: 'beta-default', version: '2.0.0' },
    ruleset: { id: 'rules', version: '2.0.0', digest: digest('e'), signatureStatus: 'VERIFIED' },
    semantics: { id: 'semantics', version: '2.0.0', digest: digest('f') },
    target: validateTargetContextV3({ schemaVersion: 'scanner-target-v3' }),
    limits: { schemaVersion: 'scanner-limits-v2', digest: digest('1'), usage: [] },
    workflow: { name: null, nodeCount: 0, rawNodeCount: 0, annotationNodeCount: 0, triggerCount: 0, actionCount: 0, integrationCount: 0, edgeCount: 0, resolvedEdgeCount: 0, payloadBytes: 0, complexity: 'LOW', isSubWorkflow: false },
  };
}

function base(): ComposeScannerResultV2Input {
  return { ...header(), analysis: { capabilities: [], diagnostics: [] }, facts: [], traces: [], findings: [], assessment: ASSESSMENT };
}

type RowStatus = 'COMPLETED' | 'SKIPPED' | 'DEGRADED' | 'FAILED';
type DomainPoint = Readonly<{ required: boolean; status: RowStatus; counts: CapabilityCountsV2 }>;
const ROW_STATUSES: readonly RowStatus[] = ['COMPLETED', 'SKIPPED', 'DEGRADED', 'FAILED'];
const STATUS_ORDER: readonly AnalysisStatusV2[] = ['COMPLETE', 'DEGRADED', 'INDETERMINATE'];
/** Every combination of recorded unperformed work; performed work is what `seen` leaves over. */
const PENDING_COUNTS: readonly Readonly<{ skipped: number; omitted: number }>[] = [
  { skipped: 0, omitted: 0 }, { skipped: 2, omitted: 0 }, { skipped: 0, omitted: 1 }, { skipped: 2, omitted: 1 },
];
const DOMAIN: readonly DomainPoint[] = [true, false].flatMap((required) => PENDING_COUNTS.flatMap((pending) => ROW_STATUSES.map((status) => ({
  required, status, counts: { seen: 3, analyzed: 3 - pending.skipped - pending.omitted, skipped: pending.skipped, omitted: pending.omitted } as CapabilityCountsV2,
}))));
const rowText = (point: DomainPoint) => `status=${point.status} required=${point.required} skipped=${point.counts.skipped} omitted=${point.counts.omitted}`;

/** The rule `derivedStatus` in `compose-result.ts` applies, specialised to the single row under test. */
function latticeAggregateStatus(point: DomainPoint): AnalysisStatusV2 {
  const corroborated = corroboratedCapabilityStatus(point.status, point.counts);
  const effect = countLatticeEffect(point.counts, point.required);
  if (point.required && (corroborated === 'FAILED' || corroborated === 'SKIPPED')) return 'INDETERMINATE';
  if (effect === 'INDETERMINATE') return 'INDETERMINATE';
  if (corroborated === 'COMPLETED' && effect === 'NONE') return 'COMPLETE';
  return 'DEGRADED';
}

/** A result that reached the boundary without the producer, carrying the row claim it states verbatim. */
function handBuilt(point: DomainPoint, aggregate: AnalysisStatusV2, diagnostics: readonly Readonly<{ id: string }>[] = []) {
  const input = header();
  return {
    schemaVersion: 'scanner-result-v2', ...input,
    analysis: { status: aggregate, capabilities: [{ id: 'source-normalization', version: '2.0.0', required: point.required, status: point.status, ...point.counts, diagnosticIds: diagnostics.map(({ id }) => id) }], diagnostics },
    facts: rekeyFacts(buildAdvisoryFactsV1({ target: input.target }), input.input.semanticSha256), traces: [], findings: [],
    assessment: aggregate === 'INDETERMINATE' ? null : ASSESSMENT,
    stats: { rejectedCandidates: 0, collapsedCandidates: 0, omittedFindings: 0, serializedBytes: 0 },
  };
}

describe('the contracts boundary agrees with the count lattice', () => {
  it('accepts every result the producer composes from the lattice', () => {
    for (const point of DOMAIN) {
      const composed = composeScannerResultV2({ ...base(), analysis: { capabilities: [{ id: 'source-normalization', version: '2.0.0', required: point.required, status: point.status, ...point.counts, diagnosticIds: [] }], diagnostics: [] } });
      expect(composed.ok, rowText(point)).toBe(true);
      if (!composed.ok) continue;
      expect(composed.result.analysis.capabilities[0].status, rowText(point)).toBe(corroboratedCapabilityStatus(point.status, point.counts));
      expect(composed.result.analysis.status, rowText(point)).toBe(latticeAggregateStatus(point));
      expect(validateScannerResultV2(composed.result).ok, rowText(point)).toBe(true);
    }
  });

  it('decides a hand-built result exactly as the lattice does', () => {
    for (const point of DOMAIN) {
      const derived = latticeAggregateStatus(point);
      const contradicts = point.status === 'COMPLETED' && (point.counts.skipped > 0 || point.counts.omitted > 0);
      for (const aggregate of STATUS_ORDER) {
        const label = `${rowText(point)} aggregate=${aggregate}`;
        const expectedErrors = [...(contradicts ? [ROW_ERROR] : []), ...(aggregate === derived ? [] : [STATUS_ERROR])];
        const checked = validateScannerResultV2(handBuilt(point, aggregate));
        expect(checked.ok, label).toBe(expectedErrors.length === 0);
        if (!checked.ok) expect([...checked.errors].sort(), label).toEqual([...expectedErrors].sort());
      }
    }
  });
});

/**
 * Count sets spanning what the shipped analyzers and the scheduler emit and what no run can produce:
 * a partition of `seen`, the non-partitions the analyzers count in their own units, rows that saw
 * nothing at all, and the two directions in which the counters contradict each other. The extremes are
 * safe-integer boundaries, where summing the parts before comparing can round.
 */
const COUNT_SET_DOMAIN: readonly CapabilityCountsV2[] = [
  { seen: 0, analyzed: 0, skipped: 0, omitted: 0 },
  { seen: 1, analyzed: 1, skipped: 0, omitted: 0 },
  { seen: 3, analyzed: 3, skipped: 0, omitted: 0 },
  { seen: 3, analyzed: 1, skipped: 2, omitted: 0 },
  // `javascript-security` analyzes one seen node in a finer unit and records its omission.
  { seen: 1, analyzed: 1, skipped: 0, omitted: 1 },
  { seen: 3, analyzed: 1, skipped: 1, omitted: 1 },
  // A dependency-skipped stage and a failed run record their loss with nothing seen.
  { seen: 0, analyzed: 0, skipped: 1, omitted: 0 },
  { seen: 0, analyzed: 0, skipped: 0, omitted: 1 },
  { seen: Number.MAX_SAFE_INTEGER, analyzed: Number.MAX_SAFE_INTEGER, skipped: 1, omitted: 0 },
  // More analysis than accounted work, and observed units that nothing accounts for.
  { seen: 3, analyzed: 5, skipped: 0, omitted: 0 },
  { seen: 0, analyzed: 1, skipped: 0, omitted: 0 },
  { seen: 3, analyzed: 1, skipped: 0, omitted: 0 },
  { seen: Number.MAX_SAFE_INTEGER, analyzed: Number.MAX_SAFE_INTEGER - 1, skipped: 0, omitted: 0 },
];
const countText = (counts: CapabilityCountsV2) => `seen=${counts.seen} analyzed=${counts.analyzed} skipped=${counts.skipped} omitted=${counts.omitted}`;

/** A row that claims the status its own counters corroborate, so only the arithmetic can be wrong. */
function countPoint(counts: CapabilityCountsV2): DomainPoint {
  return { required: false, status: corroboratedCapabilityStatus('COMPLETED', counts), counts };
}

describe('the contracts boundary agrees with the count lattice arithmetic', () => {
  it('refuses exactly the count sets the lattice refuses, under the lattice names', () => {
    for (const counts of COUNT_SET_DOMAIN) {
      // `0` eligible units keeps `ZERO_ELIGIBLE_WORK` and `ELIGIBLE_UNITS_UNKNOWN` out of the producer
      // verdict: the boundary has no eligibility input, so the pin covers the arithmetic alone.
      const code = countInconsistency(counts, 0);
      const point = countPoint(counts);
      const checked = validateScannerResultV2(handBuilt(point, latticeAggregateStatus(point)));
      const label = `${countText(counts)} code=${code}`;
      expect(checked.ok, label).toBe(code === null);
      if (checked.ok || code === null) continue;
      // The row is coherent apart from its arithmetic, so the named inconsistency is the only error.
      expect(checked.errors, label).toHaveLength(1);
      expect(checked.errors[0], label).toContain(`analysis.capabilities[0] counters record ${code}`);
    }
  });

  it('refuses to compose a row whose counters the lattice refuses', () => {
    const point = countPoint({ seen: 3, analyzed: 5, skipped: 0, omitted: 0 });
    const composed = composeScannerResultV2({ ...base(), analysis: { capabilities: [{ id: 'source-normalization', version: '2.0.0', required: point.required, status: point.status, ...point.counts, diagnosticIds: [] }], diagnostics: [] } });
    expect(composed.ok).toBe(false);
    if (composed.ok) return;
    expect(composed.code).toBe('RESULT_COMPOSITION_FAILED');
    expect(composed.errors.some((error) => error.includes('UNSEEN_ANALYSIS'))).toBe(true);
  });

  it('agrees that a diagnostic recording an omission needs a row recording one', () => {
    const truncation = { id: digest('2'), code: 'OPTIONAL_LIMIT_EXCEEDED' as const, category: 'LIMIT' as const, capabilityId: 'source-normalization', aggregateEffect: 'DEGRADED' as const, assessmentEligible: true, observed: 1, maximum: 0, omitted: 1 };
    const denied = { required: false, status: 'DEGRADED' as const, counts: { seen: 1, analyzed: 1, skipped: 0, omitted: 0 } as CapabilityCountsV2 };
    expect(omissionInconsistency(denied.counts, [truncation])).toBe('UNRECORDED_OMISSION');
    const refused = validateScannerResultV2(handBuilt(denied, 'DEGRADED', [truncation]));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors).toEqual(['analysis.diagnostics[0] counters record UNRECORDED_OMISSION: omitted exceeds the owning capability omitted count']);
    // The same diagnostic and counters validate once the row that owns the diagnostic records the loss.
    const corroborated = { required: false, status: 'DEGRADED' as const, counts: { seen: 1, analyzed: 1, skipped: 0, omitted: 1 } as CapabilityCountsV2 };
    expect(omissionInconsistency(corroborated.counts, [truncation])).toBeNull();
    expect(validateScannerResultV2(handBuilt(corroborated, 'DEGRADED', [truncation])).ok).toBe(true);
  });
});
