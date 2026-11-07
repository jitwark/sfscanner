import type { V2CalibrationCase, V2ExpectedLabel, V2CalibrationSplit } from './v2-case-schema';

const DIGEST = /^[0-9a-f]{64}$/;
const MAX_RECORDS = 10_000;
const MAX_TEXT = 4_096;

export type CalibrationDispute = 'NONE' | 'OPEN' | 'RESOLVED' | 'HUMAN_REQUIRED';
type Provenance = V2CalibrationCase['provenance'];
type Review = { labelSource?: string; reviewer?: string; reviewedAt?: string; dispute?: CalibrationDispute };
export type CalibrationLineageRecord = {
  id: string;
  provenance: Provenance;
  repository?: string;
  templateId?: string | number;
  nearDuplicateGroup?: string;
  label?: V2ExpectedLabel;
  labelSource?: string;
  reviewer?: string;
  dispute?: CalibrationDispute;
  review?: Review;
  split?: V2CalibrationSplit;
  expected?: { label?: V2ExpectedLabel };
  lineageGroup?: string;
};

type NormalizedRecord = CalibrationLineageRecord & { readonly lineageKeys: readonly string[] };
export type CalibrationLineageGroup = {
  groupId: string;
  caseIds: readonly string[];
  repositoryKeys: readonly string[];
  templateIds: readonly string[];
  nearDuplicateGroups: readonly string[];
};
export type CalibrationLineageGrouping = {
  records: readonly CalibrationLineageRecord[];
  groups: readonly CalibrationLineageGroup[];
};
export type CalibrationLineageErrorCode = 'INVALID_RECORD' | 'MISSING_PROVENANCE' | 'DUPLICATE_ID' | 'DUPLICATE_DIGEST' | 'TOO_MANY_RECORDS';
export class CalibrationLineageError extends Error {
  constructor(public readonly code: CalibrationLineageErrorCode, message: string) { super(message); this.name = 'CalibrationLineageError'; }
}

function fail(code: CalibrationLineageErrorCode, message: string): never { throw new CalibrationLineageError(code, message); }
function text(value: unknown, label: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT || /[\u0000-\u001f\u007f]/.test(value) || /[\ud800-\udfff]/.test(value) && !/^[\u0000-\ud7ff\ue000-\uffff]*(?:[\ud800-\udbff][\udc00-\udfff][\u0000-\ud7ff\ue000-\uffff]*)*$/.test(value)) return fail('INVALID_RECORD', `${label} must be safe non-empty text.`);
  return value;
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.getOwnPropertySymbols(value).length === 0;
}
function plain(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) return fail('INVALID_RECORD', `${label} must be a plain object.`);
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail('INVALID_RECORD', `${label}.${name} must be enumerable data.`);
  }
  return value;
}
function isCalibrationDispute(value: unknown): value is CalibrationDispute {
  return value === 'NONE' || value === 'OPEN' || value === 'RESOLVED' || value === 'HUMAN_REQUIRED';
}
function parseDispute(value: unknown, label: string): CalibrationDispute {
  if (!isCalibrationDispute(value)) return fail('INVALID_RECORD', `${label} is invalid.`);
  return value;
}
function isExpectedLabel(value: unknown): value is V2ExpectedLabel {
  return value === 'POSITIVE' || value === 'NEGATIVE' || value === 'NEAR_MISS' || value === 'UNSUPPORTED';
}
function parseExpectedLabel(value: unknown, label: string): V2ExpectedLabel | undefined {
  if (value === undefined) return undefined;
  if (!isExpectedLabel(value)) return fail('INVALID_RECORD', `${label} is invalid.`);
  return value;
}
function isExpectedRecord(value: unknown): value is { label?: V2ExpectedLabel } {
  if (!isPlainRecord(value)) return false;
  const label = value.label;
  return label === undefined || isExpectedLabel(label);
}
function metadata(value: unknown, label: string): Provenance {
  const raw = plain(value, label);
  const source = text(raw.source, `${label}.source`);
  const commit = text(raw.commit, `${label}.commit`);
  const path = text(raw.path, `${label}.path`);
  const licence = text(raw.licence, `${label}.licence`);
  const permission = text(raw.permission, `${label}.permission`);
  const digest = raw.digest;
  if (!digest || typeof digest !== 'string' || !DIGEST.test(digest)) return fail('MISSING_PROVENANCE', `${label}.digest must be a lowercase SHA-256 digest.`);
  if (source === undefined || commit === undefined || path === undefined || licence === undefined || permission === undefined) return fail('MISSING_PROVENANCE', `${label} requires source, commit, path, licence, and permission.`);
  return Object.freeze({ source, commit, path, licence, permission, digest });
}
function lineageKeys(record: CalibrationLineageRecord): string[] {
  const keys = [`repository:${record.repository ?? record.provenance.source}`];
  if (record.templateId !== undefined) keys.push(`template:${String(record.templateId)}`);
  if (record.nearDuplicateGroup !== undefined) keys.push(`near:${record.nearDuplicateGroup}`);
  return keys;
}
function normalize(input: unknown): NormalizedRecord {
  const raw = plain(input, 'lineage record');
  const id = text(raw.id, 'record.id');
  if (id === undefined) return fail('INVALID_RECORD', 'record.id must be safe non-empty text.');
  const rawProvenance = raw.provenance ?? { source: raw.source, commit: raw.commit, path: raw.path, licence: raw.licence, permission: raw.permission, digest: raw.digest };
  if (raw.provenance === undefined && [raw.source, raw.commit, raw.path, raw.licence, raw.permission, raw.digest].every((value) => value === undefined)) return fail('MISSING_PROVENANCE', `record ${id}.provenance is required.`);
  const provenance = metadata(rawProvenance, `record ${id}.provenance`);
  const repository = text(raw.repository, `record ${id}.repository`, false);
  const nearDuplicateGroup = text(raw.nearDuplicateGroup, `record ${id}.nearDuplicateGroup`, false);
  const templateId = raw.templateId === undefined ? undefined : (typeof raw.templateId === 'string' || typeof raw.templateId === 'number' ? String(raw.templateId) : fail('INVALID_RECORD', `record ${id}.templateId must be text or a number.`));
  const reviewRaw = raw.review === undefined ? undefined : plain(raw.review, `record ${id}.review`);
  const reviewLabelSource = reviewRaw === undefined ? undefined : text(reviewRaw.labelSource, `record ${id}.review.labelSource`, false);
  const reviewReviewer = reviewRaw === undefined ? undefined : text(reviewRaw.reviewer, `record ${id}.reviewer`, false);
  const reviewReviewedAt = reviewRaw === undefined ? undefined : text(reviewRaw.reviewedAt, `record ${id}.review.reviewedAt`, false);
  const reviewDispute = reviewRaw === undefined || reviewRaw.dispute === undefined ? undefined : parseDispute(reviewRaw.dispute, `record ${id}.review.dispute`);
  const review = reviewRaw === undefined ? undefined : Object.freeze({
    ...(reviewLabelSource === undefined ? {} : { labelSource: reviewLabelSource }),
    ...(reviewReviewer === undefined ? {} : { reviewer: reviewReviewer }),
    ...(reviewReviewedAt === undefined ? {} : { reviewedAt: reviewReviewedAt }),
    ...(reviewDispute === undefined ? {} : { dispute: reviewDispute }),
  });
  const labelSource = text(raw.labelSource ?? review?.labelSource, `record ${id}.labelSource`, false);
  const reviewer = text(raw.reviewer ?? review?.reviewer, `record ${id}.reviewer`, false);
  const disputeValue = raw.dispute ?? review?.dispute;
  const dispute = disputeValue === undefined ? undefined : parseDispute(disputeValue, `record ${id}.dispute`);
  const expectedValue = raw.expected;
  if (expectedValue !== undefined && !isExpectedRecord(expectedValue)) return fail('INVALID_RECORD', `record ${id}.expected.label is invalid.`);
  const label = parseExpectedLabel(raw.label ?? expectedValue?.label, `record ${id}.label`);
  const split = raw.split === undefined ? undefined : raw.split === 'development' || raw.split === 'holdout' ? raw.split : fail('INVALID_RECORD', `record ${id}.split is invalid.`);
  return Object.freeze({ id, provenance, repository, templateId, nearDuplicateGroup, label, labelSource, reviewer, dispute, review, split, expected: expectedValue, lineageKeys: Object.freeze(lineageKeys({ id, provenance, repository, templateId, nearDuplicateGroup })) });
}
function compare(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1; }
function unique(values: readonly string[]): string[] { return [...new Set(values)].sort(compare); }

export function groupCalibrationLineage(inputs: readonly unknown[]): CalibrationLineageGrouping {
  if (!Array.isArray(inputs) || inputs.length > MAX_RECORDS) return fail('TOO_MANY_RECORDS', `Calibration lineage is limited to ${MAX_RECORDS} records.`);
  const records = inputs.map(normalize).sort((left, right) => compare(left.id, right.id));
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) fail('DUPLICATE_ID', `Calibration lineage has duplicate case ID ${record.id}.`);
    if (digests.has(record.provenance.digest)) fail('DUPLICATE_DIGEST', `Calibration lineage has duplicate digest ${record.provenance.digest}.`);
    ids.add(record.id); digests.add(record.provenance.digest);
  }
  const parent = records.map((_, index) => index);
  const root = (index: number): number => { while (parent[index] !== index) { parent[index] = parent[parent[index]!]; index = parent[index]!; } return index; };
  const join = (left: number, right: number): void => { const a = root(left); const b = root(right); if (a !== b) parent[b] = a; };
  const firstByKey = new Map<string, number>();
  records.forEach((record, index) => record.lineageKeys.forEach((key) => { const previous = firstByKey.get(key); if (previous === undefined) firstByKey.set(key, index); else join(index, previous); }));
  const byRoot = new Map<number, NormalizedRecord[]>();
  records.forEach((record, index) => { const key = root(index); const members = byRoot.get(key) ?? []; members.push(record); byRoot.set(key, members); });
  const groups = [...byRoot.values()].map((members) => {
    const ordered = members.sort((left, right) => compare(left.id, right.id));
    const groupId = `lineage-${ordered[0]!.id}`;
    return Object.freeze({ groupId, caseIds: Object.freeze(ordered.map((record) => record.id)), repositoryKeys: Object.freeze(unique(ordered.map((record) => `repository:${record.repository ?? record.provenance.source}`))), templateIds: Object.freeze(unique(ordered.flatMap((record) => record.templateId === undefined ? [] : [String(record.templateId)]))), nearDuplicateGroups: Object.freeze(unique(ordered.flatMap((record) => record.nearDuplicateGroup === undefined ? [] : [record.nearDuplicateGroup]))) });
  }).sort((left, right) => compare(left.groupId, right.groupId));
  const groupById = new Map<string, string>();
  for (const group of groups) for (const id of group.caseIds) groupById.set(id, group.groupId);
  const assigned = records.map(({ lineageKeys: _, ...record }) => Object.freeze({ ...record, lineageGroup: groupById.get(record.id) }));
  return Object.freeze({ records: Object.freeze(assigned), groups: Object.freeze(groups) });
}
