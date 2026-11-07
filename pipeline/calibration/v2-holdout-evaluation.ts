/**
 * B6 — the holdout evaluation's classifier and distribution.
 *
 * Pure: one observation per evaluated workflow in, counts out. No clock, no filesystem, no scanner
 * call — the driver that scans and measures lives outside this module, so a recorded run can be
 * re-summarised and the distribution asserted without re-scanning anything.
 *
 * The two absences stay apart, because they are not the same fact:
 *  - `REFUSED` — the engine published no result at all. `refusalCode` names why, from the engine's
 *    own closed `ScanWorkflowV2FailureCode` set: a node set the semantic view cannot build refuses
 *    with `SEMANTIC_CATALOGUE_INVALID`, a malformed document with `MALFORMED_WORKFLOW` or
 *    `INVALID_JSON`, a tool-side composition defect with `TOOL_INVARIANT_FAILED`.
 *  - `INDETERMINATE` — a result that carries no assessment: the engine declined to claim a verdict.
 * Neither is `GRADED`, and a `GRADED` row is not a *correct* verdict: that needs labels, and this
 * corpus carries none (see `docs/audit/2026-10-17-remediation/B6-report.md` §5).
 */
import { DIAGNOSTIC_REGISTRY } from '@hub/scanner-core/diagnostics/registry';
import type { ScanWorkflowV2FailureCode } from '@hub/scanner-core/v2';

export type HoldoutVerdict = 'GRADED' | 'INDETERMINATE' | 'REFUSED';
export type HoldoutGrade = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type HoldoutAnalysisStatus = 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE';

/** One evaluated workflow. `grade` is the engine's own assessment, never a caller's opinion. */
export type HoldoutObservation = Readonly<{
  /** Stable case identity: the body file's name, digests are held separately. */
  caseId: string;
  /** SHA-256 of the exact bytes scanned, so the observation is reproducible from the file. */
  bodySha256: string;
  ok: boolean;
  /** Present exactly when `ok` is false. */
  refusalCode?: ScanWorkflowV2FailureCode;
  analysisStatus: HoldoutAnalysisStatus;
  /** Present exactly when the engine published an assessment. */
  grade?: HoldoutGrade;
  diagnosticCodes: readonly string[];
  findingCount: number;
  /** Observation only, not part of any deterministic assertion. */
  latencyMs: number;
  rssBytes: number;
}>;

/** `UNREGISTERED` keeps a code the registry does not define visible instead of silently grouped. */
export const UNREGISTERED_CATEGORY = 'UNREGISTERED' as const;

const CATEGORY_BY_CODE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(DIAGNOSTIC_REGISTRY.map((entry) => [entry.code, entry.category])),
);

/** The engine's own `DiagnosticCategoryV2` for a registered code, or `UNREGISTERED`. */
export function diagnosticCategoryOf(code: string): string {
  return CATEGORY_BY_CODE[code] ?? UNREGISTERED_CATEGORY;
}

/**
 * A refused scan is `REFUSED`; a result the engine published without an assessment is
 * `INDETERMINATE`; only a published assessment is `GRADED`. Never infers a grade.
 */
export function classifyHoldoutVerdict(observation: HoldoutObservation): HoldoutVerdict {
  if (!observation.ok) return 'REFUSED';
  return observation.grade === undefined ? 'INDETERMINATE' : 'GRADED';
}

export type HoldoutDistribution = Readonly<{
  caseCount: number;
  /** The distribution itself: how many graded, how many indeterminate, how many refused. */
  verdicts: Readonly<Record<HoldoutVerdict, number>>;
  analysisStatuses: Readonly<Record<string, number>>;
  /** The grade spread over every case; `NO_ASSESSMENT` is a bucket, not a zero grade. */
  grades: Readonly<Record<string, number>>;
  /** Per refusal code, each one its own count: an unmodelled node set is not a malformed document. */
  refusalCodes: Readonly<Record<string, number>>;
  /** Per diagnostic category over graded cases, including `UNREGISTERED`. */
  diagnosticCategories: Readonly<Record<string, number>>;
  /** Graded cases whose diagnostics include a `CATALOGUE` coverage gap. */
  gradedWithCatalogueGap: number;
  findingCount: number;
  /** Raw latency samples, reported as measured; never a gate. */
  latency: Readonly<{ totalMs: number; minMs: number; medianMs: number; maxMs: number }> | null;
  /** Peak resident set observed after a scan; a level, not a per-case delta. */
  rss: Readonly<{ peakBytes: number }>;
}>;

type Counts = Map<string, number>;

function counted(counts: Counts, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Insertion in canonical key order, so two runs of the same input compare equal. */
function frozenCounts(counts: Counts): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries([...counts.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))));
}

/** The usual midpoint: the middle sample for an odd count, the mean of the two middles otherwise. */
function median(sorted: readonly number[]): number {
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function summarizeHoldout(observations: readonly HoldoutObservation[]): HoldoutDistribution {
  const verdicts = new Map<string, number>([['GRADED', 0], ['INDETERMINATE', 0], ['REFUSED', 0]]);
  const analysisStatuses: Counts = new Map();
  const grades: Counts = new Map();
  const refusalCodes: Counts = new Map();
  const diagnosticCategories: Counts = new Map();
  const latencies: number[] = [];
  let gradedWithCatalogueGap = 0;
  let findingCount = 0;
  let peakRss = 0;

  for (const observation of observations) {
    const verdict = classifyHoldoutVerdict(observation);
    counted(verdicts, verdict);
    counted(analysisStatuses, observation.analysisStatus);
    counted(grades, observation.grade ?? 'NO_ASSESSMENT');
    if (observation.refusalCode !== undefined) counted(refusalCodes, observation.refusalCode);

    const categories = new Set<string>();
    for (const code of observation.diagnosticCodes) categories.add(diagnosticCategoryOf(code));
    for (const category of categories) counted(diagnosticCategories, category);
    if (verdict === 'GRADED' && categories.has('CATALOGUE')) gradedWithCatalogueGap += 1;

    findingCount += observation.findingCount;
    if (observation.ok) {
      latencies.push(observation.latencyMs);
      peakRss = Math.max(peakRss, observation.rssBytes);
    }
  }

  const sortedLatencies = [...latencies].sort((left, right) => left - right);
  return Object.freeze({
    caseCount: observations.length,
    verdicts: frozenCounts(verdicts) as Readonly<Record<HoldoutVerdict, number>>,
    analysisStatuses: frozenCounts(analysisStatuses),
    grades: frozenCounts(grades),
    refusalCodes: frozenCounts(refusalCodes),
    diagnosticCategories: frozenCounts(diagnosticCategories),
    gradedWithCatalogueGap,
    findingCount,
    latency: sortedLatencies.length === 0 ? null : Object.freeze({
      totalMs: sortedLatencies.reduce((sum, value) => sum + value, 0),
      minMs: sortedLatencies[0]!,
      medianMs: median(sortedLatencies),
      maxMs: sortedLatencies[sortedLatencies.length - 1]!,
    }),
    rss: Object.freeze({ peakBytes: peakRss }),
  });
}
