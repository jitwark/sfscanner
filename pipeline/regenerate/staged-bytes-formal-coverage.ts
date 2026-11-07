/**
 * Cross-field invariants for q02-formal-coverage-v1.
 *
 * The structural schema proves field types and closed tokens. This module proves the numbers,
 * status/scope pair, rates and resource-refusal cause/stage/code combinations are the ones
 * `formal-node-coverage.ts` can actually emit. A report that is internally impossible is a
 * fabricated claim even when every individual field is well formed.
 */
import type { SourceComplexityCauseV2 } from '../../packages/scanner-core/src/source/source-types.js';
import type { NormalizationComplexityCause } from '../../packages/scanner-core/src/workflow-v2/security-workflow.js';

type RecordValue = Record<string, unknown>;
const SOURCE_COMPLEXITY_CAUSES = [
  'SYNTAX_NODE_LIMIT', 'DOCUMENT_DEPTH_LIMIT', 'MEMBER_ELEMENT_LIMIT',
  'DUPLICATE_KEY_LIMIT', 'SOURCE_WORK_LIMIT',
] as const satisfies readonly SourceComplexityCauseV2[];
const NORMALIZATION_COMPLEXITY_CAUSES = [
  'NODE_LIMIT', 'RAW_EDGE_LIMIT', 'EDGE_LIMIT', 'CONNECTION_DEPTH_LIMIT',
  'PARAMETER_DEPTH_LIMIT', 'PARAMETER_LEAF_LIMIT',
] as const satisfies readonly NormalizationComplexityCause[];
const EXCLUSION_REASONS = [
  'MALFORMED', 'MISSING', 'SOURCE_UNAVAILABLE', 'COMMUNITY_PACKAGE',
  'INVALID_NODE_IDENTITY', 'NO_EXECUTABLE_NODE', 'REJECTED_INPUT',
] as const;

const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function isProducerRefusal(value: unknown): boolean {
  if (!record(value)) return false;
  const { stage, code, cause } = value;
  if (stage === 'SOURCE' && code === 'WORKFLOW_TOO_LARGE') return cause === undefined;
  if (stage === 'SOURCE' && code === 'WORKFLOW_TOO_COMPLEX') return typeof cause === 'string' && (SOURCE_COMPLEXITY_CAUSES as readonly string[]).includes(cause);
  if (stage === 'NORMALIZATION' && code === 'WORKFLOW_TOO_COMPLEX') return typeof cause === 'string' && (NORMALIZATION_COMPLEXITY_CAUSES as readonly string[]).includes(cause);
  return false;
}

function isProducerExclusion(value: unknown): boolean {
  if (!record(value) || !(EXCLUSION_REASONS as readonly string[]).includes(value.reason as string)) return false;
  if (value.reason === 'REJECTED_INPUT') return value.reasonCode === undefined || value.reasonCode === null || typeof value.reasonCode === 'string';
  return value.reasonCode === undefined;
}

function exclusionReasonCounts(exclusions: readonly unknown[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, 0]));
  for (const item of exclusions) {
    if (record(item) && typeof item.reason === 'string' && item.reason in counts) counts[item.reason] += 1;
  }
  return counts;
}

function consistentRate(value: unknown, numerator: number, denominator: number, targetKey: string, target: number, complete: boolean): boolean {
  if (!record(value)) return false;
  if (!complete) return value.numerator === null && value.denominator === null && value.ratio === null && value[targetKey] === false;
  if (value.numerator !== numerator || value.denominator !== denominator) return false;
  if (value.ratio !== (denominator === 0 ? null : numerator / denominator)) return false;
  return value[targetKey] === (denominator > 0 && BigInt(numerator) * 100n >= BigInt(denominator) * BigInt(target));
}

function consistentWholeCorpus(whole: RecordValue, cohort: number, unknownCount: number, exclusions: readonly unknown[]): boolean {
  const numericKeys = [
    'inventoryRows', 'availableBodies', 'missing', 'sourceUnavailable', 'malformed', 'rejected',
    'measurementUnknown', 'communityPackage', 'invalidNodeIdentity', 'noExecutableNode',
    'formalCohort', 'disabledNodes', 'reviewedInertNodes',
  ] as const;
  if (!numericKeys.every((key) => integer(whole[key]))) return false;
  const statuses = whole.inventoryStatuses;
  const statusKeys = ['AVAILABLE', 'MISSING', 'SOURCE_UNAVAILABLE', 'UNPARSEABLE', 'REJECTED'] as const;
  if (!record(statuses) || !statusKeys.every((key) => integer(statuses[key]))) return false;
  const statusCount = (key: typeof statusKeys[number]): number => statuses[key] as number;
  const value = (key: typeof numericKeys[number]): number => whole[key] as number;
  if (statusKeys.reduce((sum, key) => sum + statusCount(key), 0) !== value('inventoryRows')) return false;
  if (value('availableBodies') !== statusCount('AVAILABLE') || value('missing') !== statusCount('MISSING')
    || value('sourceUnavailable') !== statusCount('SOURCE_UNAVAILABLE') || value('rejected') !== statusCount('REJECTED')) return false;
  if (value('formalCohort') !== cohort || value('measurementUnknown') !== unknownCount) return false;
  if (value('malformed') < statusCount('UNPARSEABLE') || value('malformed') > statusCount('UNPARSEABLE') + statusCount('AVAILABLE')) return false;
  const reasons = exclusionReasonCounts(exclusions);
  if (value('missing') !== reasons.MISSING || value('sourceUnavailable') !== reasons.SOURCE_UNAVAILABLE
    || value('rejected') !== reasons.REJECTED_INPUT || value('malformed') !== reasons.MALFORMED
    || value('communityPackage') !== reasons.COMMUNITY_PACKAGE || value('invalidNodeIdentity') !== reasons.INVALID_NODE_IDENTITY
    || value('noExecutableNode') !== reasons.NO_EXECUTABLE_NODE) return false;
  if (cohort + exclusions.length + unknownCount !== value('inventoryRows')) return false;
  const availableMalformed = value('malformed') - statusCount('UNPARSEABLE');
  return value('availableBodies') === cohort + unknownCount + availableMalformed
    + value('communityPackage') + value('invalidNodeIdentity') + value('noExecutableNode');
}

export function isConsistentFormalCoverageV1(value: unknown): boolean {
  if (!record(value)) return false;
  const complete = value.status === 'COMPLETE' && value.countsScope === 'FULL_COHORT';
  const incomplete = value.status === 'INCOMPLETE' && value.countsScope === 'EXAMINED_COHORT_ONLY';
  if (!complete && !incomplete) return false;
  const counts = value.counts; const rates = value.rates; const exclusions = value.exclusions;
  const unknown = value.unknownMeasurements; const whole = value.wholeCorpus;
  if (!record(counts) || !record(rates) || !record(whole) || !Array.isArray(exclusions) || !Array.isArray(unknown)) return false;
  const namespaces = record(value.cohort) ? value.cohort.namespaces : undefined;
  if (!Array.isArray(namespaces) || namespaces.length !== 2
    || namespaces[0] !== 'n8n-nodes-base' || namespaces[1] !== '@n8n/n8n-nodes-langchain') return false;
  const cohort = counts.cohortWorkflows; const withExecutable = counts.workflowsWithExecutableNodes;
  const executable = counts.executableInstances; const reviewed = counts.reviewedExecutableInstances;
  const fully = counts.fullyModelledWorkflows; const inert = counts.reviewedInertNodes;
  if (![cohort, withExecutable, executable, reviewed, fully, inert].every(integer)) return false;
  const [cohortCount, withExecutableCount, executableCount, reviewedCount, fullyCount] = [cohort, withExecutable, executable, reviewed, fully] as number[];
  if (cohortCount !== withExecutableCount || cohortCount > executableCount || reviewedCount > executableCount || fullyCount > withExecutableCount || fullyCount > reviewedCount) return false;
  if ((cohortCount === 0) !== (executableCount === 0)) return false;
  if ((fullyCount === cohortCount) !== (reviewedCount === executableCount)) return false;
  if (!integer(whole.reviewedInertNodes) || (inert as number) > whole.reviewedInertNodes) return false;
  if (!consistentRate(rates.reviewedExecutableInstances, reviewedCount, executableCount, 'meets95Percent', 95, complete)) return false;
  if (!consistentRate(rates.fullyModelledWorkflows, fullyCount, withExecutableCount, 'meets90Percent', 90, complete)) return false;
  if (complete === (unknown.length > 0)) return false;
  if (!exclusions.every(isProducerExclusion) || !unknown.every(isProducerRefusal)) return false;
  const rowIds = new Set<string>();
  for (const row of [...exclusions, ...unknown]) {
    if (!record(row) || typeof row.entryId !== 'string' || rowIds.has(row.entryId)) return false;
    rowIds.add(row.entryId);
  }
  return consistentWholeCorpus(whole, cohortCount, unknown.length, exclusions);
}
