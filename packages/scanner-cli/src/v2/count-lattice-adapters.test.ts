import { describe, expect, it } from 'vitest';
import { validateScannerResultV2, type ScannerResultV2 } from '@hub/contracts/scanner-v2-result';
import { scanWorkflowV2 } from '@hub/scanner-core/v2';
import { reduceExitV2, type ExitReductionV2 } from './exit-reducer';
import type { BatchItemV2, BatchResultV2 } from './batch-runner';

/**
 * The count lattice is produced once and read by three surfaces: the boundary validator every adapter
 * gates on, the CLI exit reduction that turns a published completeness claim into an exit code, and the
 * Worker host, which resolves only results the same boundary accepted. This suite drives one counter
 * domain through the producer, the receiver, and the CLI adapter to prove they publish one answer.
 * `failOn: 'CRITICAL'` keeps the finding threshold out of the mapping under test: the counter fixtures
 * carry no findings at all.
 */
const encoder = new TextEncoder();
const PROFILE = Object.freeze({ id: 'beta-default', version: '2.0.0' });
const digest = (letter: string): string => letter.repeat(64);

type AnalysisStatus = ScannerResultV2['analysis']['status'];
type Point = Readonly<{
  label: string;
  required: boolean;
  counts: Readonly<{ seen: number; analyzed: number; skipped: number; omitted: number }>;
  aggregate: AnalysisStatus;
}>;

const POINTS: readonly Point[] = Object.freeze([
  Object.freeze({ label: 'performed all its work', required: true, counts: { seen: 3, analyzed: 3, skipped: 0, omitted: 0 }, aggregate: 'COMPLETE' }),
  Object.freeze({ label: 'recorded skipped units', required: false, counts: { seen: 3, analyzed: 1, skipped: 2, omitted: 0 }, aggregate: 'DEGRADED' }),
  Object.freeze({ label: 'recorded a finer-unit omission', required: false, counts: { seen: 1, analyzed: 1, skipped: 0, omitted: 1 }, aggregate: 'DEGRADED' }),
  Object.freeze({ label: 'a required row omitted units', required: true, counts: { seen: 3, analyzed: 1, skipped: 0, omitted: 2 }, aggregate: 'INDETERMINATE' }),
]);

/** A result the producer would never compose, but the boundary is the surface that has to distrust it. */
function handBuilt(point: Point, diagnostics: readonly Record<string, unknown>[] = []): ScannerResultV2 {
  const baseline = producerResult('{"nodes":[],"connections":{}}');
  const row = { id: 'source-normalization', version: '2.0.0', required: point.required, status: point.counts.skipped > 0 || point.counts.omitted > 0 ? 'DEGRADED' as const : 'COMPLETED' as const, ...point.counts, diagnosticIds: diagnostics.map(({ id }) => id as string) };
  return {
    ...baseline,
    analysis: { status: point.aggregate, capabilities: [row], diagnostics: diagnostics as unknown as ScannerResultV2['analysis']['diagnostics'] },
    assessment: point.aggregate === 'INDETERMINATE' ? null : baseline.assessment,
  };
}

function producerResult(json: string, limits?: Readonly<Record<string, number>>): ScannerResultV2 {
  const scanned = scanWorkflowV2({ bytes: encoder.encode(json), profile: PROFILE, ...(limits === undefined ? {} : { limits }) });
  if (!scanned.ok) throw new Error(`scan failed: ${scanned.code}`);
  return scanned.result;
}

function batchOf(result: ScannerResultV2): BatchResultV2 {
  const item: BatchItemV2 = Object.freeze({ label: 'workflow.json', status: 'COMPLETED', result: Object.freeze({ ok: true as const, result }) });
  return Object.freeze({ ok: true as const, items: Object.freeze([item]), cancelled: false, completed: 1, failed: 0, concurrency: 1 });
}

const EXIT_FOR: Readonly<Record<AnalysisStatus, ExitReductionV2>> = Object.freeze({
  COMPLETE: Object.freeze({ reason: 'UNDER_THRESHOLD', code: 0 }),
  DEGRADED: Object.freeze({ reason: 'REQUIRE_COMPLETE', code: 1 }),
  INDETERMINATE: Object.freeze({ reason: 'ITEM_FAILURE', code: 3 }),
});

describe('capability counts across the producer, the result boundary, and the CLI adapter', () => {
  it('exits on the completeness status the producer publishes and the boundary accepts', () => {
    const complete = producerResult('{"nodes":[],"connections":{}}');
    const indeterminate = producerResult(JSON.stringify({ nodes: [{ id: 'custom', name: 'Custom', type: 'n8n-nodes-base.set', parameters: 'not-an-object' }], connections: {} }));
    expect(complete.analysis.status).toBe('COMPLETE');
    expect(indeterminate.analysis.status).toBe('INDETERMINATE');
    // The receiver is the gate the CLI and the Worker host both apply before any adapter sees a result.
    expect(validateScannerResultV2(complete).ok).toBe(true);
    expect(validateScannerResultV2(indeterminate).ok).toBe(true);
    expect(reduceExitV2({ batch: batchOf(complete), failOn: 'CRITICAL', requireComplete: true })).toEqual(EXIT_FOR.COMPLETE);
    expect(reduceExitV2({ batch: batchOf(indeterminate), failOn: 'CRITICAL', requireComplete: true })).toEqual(EXIT_FOR.INDETERMINATE);
  });

  it('reduces every accepted counter set to the exit the lattice status implies', () => {
    for (const point of POINTS) {
      const result = handBuilt(point);
      const checked = validateScannerResultV2(result);
      expect(checked.ok, `${point.label} boundary`).toBe(true);
      expect(reduceExitV2({ batch: batchOf(result), failOn: 'CRITICAL', requireComplete: true }), `${point.label} exit`).toEqual(EXIT_FOR[point.aggregate]);
      expect(reduceExitV2({ batch: batchOf(result), failOn: 'CRITICAL' }), `${point.label} exit without requireComplete`).toEqual(point.aggregate === 'INDETERMINATE' ? EXIT_FOR.INDETERMINATE : EXIT_FOR.COMPLETE);
    }
  });

  it('refuses the counter sets no run can produce before any adapter can publish them', () => {
    const truncation = { id: digest('c'), code: 'OPTIONAL_LIMIT_EXCEEDED', category: 'LIMIT', capabilityId: 'source-normalization', aggregateEffect: 'DEGRADED', assessmentEligible: true, observed: 1, maximum: 0, omitted: 1 };
    const cases: readonly Readonly<{ label: string; point: Point; diagnostics: readonly Record<string, unknown>[]; code: string }>[] = [
      Object.freeze({ label: 'analyzed beyond accounted work', point: Object.freeze({ label: '', required: true, counts: Object.freeze({ seen: 3, analyzed: 5, skipped: 0, omitted: 0 }), aggregate: 'DEGRADED' }), diagnostics: [], code: 'UNSEEN_ANALYSIS' }),
      Object.freeze({ label: 'seen units nothing accounts for', point: Object.freeze({ label: '', required: false, counts: Object.freeze({ seen: 3, analyzed: 1, skipped: 0, omitted: 0 }), aggregate: 'DEGRADED' }), diagnostics: [], code: 'UNACCOUNTED_SEEN' }),
      Object.freeze({ label: 'a diagnostic recording an omission its owner denies', point: Object.freeze({ label: '', required: false, counts: Object.freeze({ seen: 1, analyzed: 1, skipped: 0, omitted: 0 }), aggregate: 'DEGRADED' }), diagnostics: Object.freeze([truncation]), code: 'UNRECORDED_OMISSION' }),
    ];
    for (const { label, point, diagnostics, code } of cases) {
      const checked = validateScannerResultV2(handBuilt(point, diagnostics));
      expect(checked.ok, `${label} boundary`).toBe(false);
      if (!checked.ok) expect(checked.errors.some((error) => error.includes(code)), `${label} names ${code}`).toBe(true);
    }
    // The same counters and diagnostic validate once the row records the omission it names.
    const corroborated = handBuilt(Object.freeze({ label: '', required: false, counts: Object.freeze({ seen: 1, analyzed: 1, skipped: 0, omitted: 1 }), aggregate: 'DEGRADED' }), [truncation]);
    expect(validateScannerResultV2(corroborated).ok).toBe(true);
  });
});
