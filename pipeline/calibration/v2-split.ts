import {
  groupCalibrationLineage,
  type CalibrationLineageGroup,
  type CalibrationLineageGrouping,
  type CalibrationLineageRecord,
} from './v2-lineage';

export type CalibrationSplitOptions = { holdoutCount?: number; holdoutRatio?: number };
export type CalibrationSplitFailure = 'LINEAGE_SPLIT_CONFLICT' | 'IMPOSSIBLE_SPLIT' | 'INSUFFICIENT_EVIDENCE';
export type CalibrationSplitReport = {
  status: 'READY' | 'REJECTED';
  code?: CalibrationSplitFailure;
  message: string;
  groupCount: number;
  requestedHoldoutGroups: number;
  developmentGroups: number;
  holdoutGroups: number;
  holdoutEvidenceRecords: number;
};
export type CalibrationSplitResult = {
  ok: boolean;
  development: readonly CalibrationLineageRecord[];
  holdout: readonly CalibrationLineageRecord[];
  groups: readonly CalibrationLineageGroup[];
  report: CalibrationSplitReport;
};

const compare = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;
const rejected = (grouping: CalibrationLineageGrouping, code: CalibrationSplitFailure, message: string, requested: number, holdoutEvidenceRecords = 0): CalibrationSplitResult => Object.freeze({
  ok: false,
  development: Object.freeze(grouping.records.map((record) => Object.freeze({ ...record, split: 'development' as const }))),
  holdout: Object.freeze([]),
  groups: grouping.groups,
  report: Object.freeze({ status: 'REJECTED', code, message, groupCount: grouping.groups.length, requestedHoldoutGroups: requested, developmentGroups: grouping.groups.length, holdoutGroups: 0, holdoutEvidenceRecords }),
});

function requestedGroups(groupCount: number, options: CalibrationSplitOptions): number {
  if (options.holdoutCount !== undefined) return Number.isSafeInteger(options.holdoutCount) && options.holdoutCount >= 0 ? options.holdoutCount : NaN;
  if (options.holdoutRatio !== undefined) return Number.isFinite(options.holdoutRatio) && options.holdoutRatio >= 0 && options.holdoutRatio <= 1 ? Math.floor(groupCount * options.holdoutRatio) : NaN;
  return Math.max(1, Math.floor(groupCount / 5));
}
function hasEvidence(record: CalibrationLineageRecord): boolean {
  return record.label !== undefined && record.labelSource !== undefined && record.reviewer !== undefined && record.dispute !== undefined && record.dispute !== 'HUMAN_REQUIRED' && record.dispute !== 'OPEN';
}
function isCalibrationLineageGrouping(input: readonly unknown[] | CalibrationLineageGrouping): input is CalibrationLineageGrouping {
  return !Array.isArray(input) && typeof input === 'object' && input !== null && 'records' in input && 'groups' in input;
}
function groupingOf(input: readonly unknown[] | CalibrationLineageGrouping): CalibrationLineageGrouping {
  return isCalibrationLineageGrouping(input) ? groupCalibrationLineage(input.records) : groupCalibrationLineage(input);
}
function authoredSplit(group: CalibrationLineageGroup, records: readonly CalibrationLineageRecord[]): 'development' | 'holdout' | 'conflict' | undefined {
  const values = new Set(records.filter((record) => group.caseIds.includes(record.id)).map((record) => record.split).filter((value): value is 'development' | 'holdout' => value !== undefined));
  if (values.size > 1) return 'conflict';
  return values.values().next().value;
}

export function splitCalibrationCorpus(input: readonly unknown[] | CalibrationLineageGrouping, options: CalibrationSplitOptions = {}): CalibrationSplitResult {
  const grouping = groupingOf(input);
  const requested = requestedGroups(grouping.groups.length, options);
  const authored = new Map(grouping.groups.map((group) => [group.groupId, authoredSplit(group, grouping.records)]));
  if ([...authored.values()].some((value) => value === 'conflict')) return rejected(grouping, 'LINEAGE_SPLIT_CONFLICT', 'A lineage group contains authored development and holdout records.', Number.isFinite(requested) ? requested : 0);
  if (!Number.isSafeInteger(requested) || requested < 0 || requested >= grouping.groups.length) return rejected(grouping, 'IMPOSSIBLE_SPLIT', 'Requested holdout groups must leave at least one development group.', typeof requested === 'number' && Number.isFinite(requested) ? requested : 0);
  if (requested === 0) return rejected(grouping, 'INSUFFICIENT_EVIDENCE', 'A holdout split requires at least one requested lineage group.', requested);
  const forcedHoldout = grouping.groups.filter((group) => authored.get(group.groupId) === 'holdout');
  const forcedDevelopment = grouping.groups.filter((group) => authored.get(group.groupId) === 'development');
  if (forcedHoldout.length > requested || grouping.groups.length - forcedDevelopment.length < requested) return rejected(grouping, 'IMPOSSIBLE_SPLIT', 'Authored split assignments cannot satisfy the requested grouped holdout size.', requested);
  const free = grouping.groups.filter((group) => authored.get(group.groupId) === undefined).sort((left, right) => compare(left.groupId, right.groupId));
  const needed = requested - forcedHoldout.length;
  const selected = new Set([...forcedHoldout.map((group) => group.groupId), ...(needed === 0 ? [] : free.slice(-needed).map((group) => group.groupId))]);
  const holdoutEvidenceRecords = grouping.records.filter((record) => selected.has(record.lineageGroup ?? '') && hasEvidence(record)).length;
  const holdoutRecords = grouping.records.filter((record) => selected.has(record.lineageGroup ?? ''));
  if (holdoutEvidenceRecords !== holdoutRecords.length) return rejected(grouping, 'INSUFFICIENT_EVIDENCE', 'Every holdout record needs an explicit reviewed label; unlabelled corpus evidence remains HUMAN_REQUIRED.', requested, holdoutEvidenceRecords);
  const development = grouping.records.filter((record) => !selected.has(record.lineageGroup ?? '')).map((record) => Object.freeze({ ...record, split: 'development' as const }));
  const holdout = holdoutRecords.map((record) => Object.freeze({ ...record, split: 'holdout' as const }));
  return Object.freeze({ ok: true, development: Object.freeze(development), holdout: Object.freeze(holdout), groups: grouping.groups, report: Object.freeze({ status: 'READY', message: 'Grouped development and holdout partitions are provenance-safe.', groupCount: grouping.groups.length, requestedHoldoutGroups: requested, developmentGroups: grouping.groups.length - selected.size, holdoutGroups: selected.size, holdoutEvidenceRecords }) });
}
