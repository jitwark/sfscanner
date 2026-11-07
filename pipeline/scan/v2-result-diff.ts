import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import type { V2RescanRecord } from './v2-corpus-adapter.js';

export type V2ResultDiff = Readonly<{
  entryId: string;
  status: 'UNCHANGED' | 'CHANGED' | 'ADDED' | 'REMOVED';
  findingAdded: readonly string[];
  findingRemoved: readonly string[];
  gradeChanged?: readonly [string, string];
  analysisStatusChanged?: readonly [string, string];
  authorityChanged: readonly string[];
}>;

type RecordDetails = V2RescanRecord & {
  findingIds?: unknown;
  findings?: unknown;
  grade?: unknown;
};

const AUTHORITY_FIELDS = [
  'scannerVersion', 'engineBuildDigest', 'profileId', 'profileVersion',
  'rulesetDigest', 'semanticsDigest', 'limitsDigest',
] as const;
const RECORD_FIELDS = [
  'entryId', 'sourceDigest', 'inputSha256', ...AUTHORITY_FIELDS,
  'analysisStatus', 'resultDigest', 'rightsClass', 'ok',
] as const;

type StringMap = Record<string, unknown>;

function details(record: V2RescanRecord): RecordDetails {
  return record as RecordDetails;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCanonicalStrings);
}

function findingIds(record: V2RescanRecord | undefined): readonly string[] {
  if (!record) return [];
  const value = details(record).findingIds;
  if (Array.isArray(value)) return sortedUnique(value.filter((item): item is string => typeof item === 'string'));
  const findings = details(record).findings;
  if (!Array.isArray(findings)) return [];
  const ids = findings.map((finding) => {
    if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) return undefined;
    const item = finding as StringMap;
    return typeof item.findingId === 'string' ? item.findingId : typeof item.id === 'string' ? item.id : undefined;
  }).filter((item): item is string => item !== undefined);
  return sortedUnique(ids);
}

function changedValues(left: readonly string[], right: readonly string[]): { added: string[]; removed: string[] } {
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  return {
    added: sortedUnique(left.filter((item) => !rightSet.has(item))),
    removed: sortedUnique(right.filter((item) => !leftSet.has(item))),
  };
}

function authorityChanges(previous: V2RescanRecord, current: V2RescanRecord): string[] {
  return AUTHORITY_FIELDS.filter((field) => previous[field] !== current[field]).sort(compareCanonicalStrings);
}

function baseChanged(previous: V2RescanRecord, current: V2RescanRecord): boolean {
  return RECORD_FIELDS.some((field) => previous[field] !== current[field]);
}

export function diffV2ResultRecords(
  previous: V2RescanRecord | undefined,
  current: V2RescanRecord | undefined,
): V2ResultDiff {
  const entryId = current?.entryId ?? previous?.entryId ?? '';
  if (!previous && !current) return { entryId, status: 'UNCHANGED', findingAdded: [], findingRemoved: [], authorityChanged: [] };
  if (!previous) {
    return {
      entryId,
      status: 'ADDED',
      findingAdded: findingIds(current),
      findingRemoved: [],
      authorityChanged: [],
    };
  }
  if (!current) {
    return {
      entryId,
      status: 'REMOVED',
      findingAdded: [],
      findingRemoved: findingIds(previous),
      authorityChanged: [],
    };
  }

  const findings = changedValues(findingIds(current), findingIds(previous));
  const authorityChanged = authorityChanges(previous, current);
  const gradeBefore = details(previous).grade;
  const gradeAfter = details(current).grade;
  const gradeChanged = typeof gradeBefore === 'string' && typeof gradeAfter === 'string' && gradeBefore !== gradeAfter
    ? [gradeBefore, gradeAfter] as const : undefined;
  const analysisStatusChanged = previous.analysisStatus !== current.analysisStatus
    ? [previous.analysisStatus, current.analysisStatus] as const : undefined;
  const changed = baseChanged(previous, current) || findings.added.length > 0 || findings.removed.length > 0 || gradeChanged !== undefined;
  return {
    entryId,
    status: changed ? 'CHANGED' : 'UNCHANGED',
    findingAdded: findings.added,
    findingRemoved: findings.removed,
    ...(gradeChanged ? { gradeChanged } : {}),
    ...(analysisStatusChanged ? { analysisStatusChanged } : {}),
    authorityChanged,
  };
}
