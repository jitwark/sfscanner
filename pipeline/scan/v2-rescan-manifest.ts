import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { ENTRY_SECURITY_PROJECTION_VERSION, type V2RescanRecord } from './v2-corpus-adapter.js';
import { createHash } from 'node:crypto';
import { type V2SourceReceipt, validateV2SourceReceipt } from './v2-source-receipt.js';

export const V2_RESCAN_MANIFEST_SCHEMA_VERSION = 'v2-rescan-manifest' as const;

export type V2RescanManifest = Readonly<{
  schemaVersion: typeof V2_RESCAN_MANIFEST_SCHEMA_VERSION;
  releaseId: string;
  receipt?: V2SourceReceipt;
  records: readonly V2RescanRecord[];
  manifestDigest: string;
}>;

const STATUS = ['COMPLETE', 'DEGRADED', 'INDETERMINATE'] as const;
const RIGHTS = ['redistributable', 'link_only', 'excluded'] as const;
const AUTHORITY_FIELDS = [
  'scannerVersion', 'engineBuildDigest', 'profileId', 'profileVersion',
  'rulesetDigest', 'semanticsDigest', 'limitsDigest',
] as const;
const DIGEST = /^[0-9a-f]{64}$/;
const GRADES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

type PlainRecord = Record<string, unknown>;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isPlainRecord(value: unknown): value is PlainRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertReleaseId(releaseId: unknown): asserts releaseId is string {
  if (typeof releaseId !== 'string' || releaseId.trim().length === 0 || releaseId.length > 128 || /[\u0000-\u001f\u007f/\\]/.test(releaseId)) {
    throw new TypeError('Release identity is malformed.');
  }
}

function normalizeRecord(value: unknown, index: number): V2RescanRecord {
  if (!isPlainRecord(value)) throw new TypeError(`Rescan record ${index} is malformed.`);
  const expected = ['entryId', 'sourceDigest', 'inputSha256', 'scannerVersion', 'engineBuildDigest', 'profileId', 'profileVersion', 'rulesetDigest', 'semanticsDigest', 'limitsDigest', 'analysisStatus', 'resultDigest', 'rightsClass', 'ok', 'findingIds', 'grade', 'securityProjectionVersion', 'securitySha256'];
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  if (unknown.length > 0) throw new TypeError(`Rescan record ${index} has unknown fields.`);
  if (typeof value.entryId !== 'string' || value.entryId.trim().length === 0 || value.entryId.length > 512 || /[\u0000-\u001f\u007f]/.test(value.entryId)) throw new TypeError(`Rescan record ${index} has an invalid entry ID.`);
  for (const field of ['sourceDigest', 'inputSha256', 'engineBuildDigest', 'rulesetDigest', 'semanticsDigest', 'limitsDigest']) {
    if (typeof value[field] !== 'string' || !DIGEST.test(value[field])) throw new TypeError(`Rescan record ${index}.${field} is not a SHA-256 digest.`);
  }
  for (const field of ['scannerVersion', 'profileId', 'profileVersion']) {
    if (typeof value[field] !== 'string' || value[field].length === 0 || value[field].length > 256 || /[\u0000-\u001f\u007f]/.test(value[field])) throw new TypeError(`Rescan record ${index}.${field} is malformed.`);
  }
  if (!STATUS.includes(value.analysisStatus as typeof STATUS[number])) throw new TypeError(`Rescan record ${index}.analysisStatus is invalid.`);
  if (!RIGHTS.includes(value.rightsClass as typeof RIGHTS[number]) || typeof value.ok !== 'boolean') throw new TypeError(`Rescan record ${index} status is malformed.`);
  if (value.resultDigest !== undefined && (typeof value.resultDigest !== 'string' || !DIGEST.test(value.resultDigest))) throw new TypeError(`Rescan record ${index}.resultDigest is not a SHA-256 digest.`);
  if (!Array.isArray(value.findingIds) || value.findingIds.some((item) => typeof item !== 'string' || item.length > 256 || /[\u0000-\u001f\u007f]/.test(item) || /(?:https?|ftp):\/\/|(?:password|secret|token|api[ _-]*key)\s*[:=]/i.test(item))) throw new TypeError(`Rescan record ${index}.findingIds is malformed.`);
  const findingIds = Object.freeze([...new Set(value.findingIds as string[])].sort(compareCanonicalStrings));
  if (value.grade !== undefined && (typeof value.grade !== 'string' || !GRADES.includes(value.grade as typeof GRADES[number]))) throw new TypeError(`Rescan record ${index}.grade is malformed.`);
  if (value.securityProjectionVersion !== undefined && (typeof value.securityProjectionVersion !== 'string' || value.securityProjectionVersion.length === 0 || value.securityProjectionVersion.length > 64)) {
    throw new TypeError(`Rescan record ${index}.securityProjectionVersion is malformed.`);
  }
  if (value.securitySha256 !== undefined && (typeof value.securitySha256 !== 'string' || !DIGEST.test(value.securitySha256 as string))) {
    throw new TypeError(`Rescan record ${index}.securitySha256 is not a SHA-256 digest.`);
  }
  return Object.freeze({
    entryId: value.entryId,
    sourceDigest: value.sourceDigest,
    inputSha256: value.inputSha256,
    scannerVersion: value.scannerVersion,
    engineBuildDigest: value.engineBuildDigest,
    profileId: value.profileId,
    profileVersion: value.profileVersion,
    rulesetDigest: value.rulesetDigest,
    semanticsDigest: value.semanticsDigest,
    limitsDigest: value.limitsDigest,
    analysisStatus: value.analysisStatus,
    ...(value.resultDigest === undefined ? {} : { resultDigest: value.resultDigest }),
    findingIds,
    ...(value.grade === undefined ? {} : { grade: value.grade }),
    rightsClass: value.rightsClass,
    ok: value.ok,
    ...(value.securityProjectionVersion === undefined ? {} : { securityProjectionVersion: value.securityProjectionVersion }),
    ...(value.securitySha256 === undefined ? {} : { securitySha256: value.securitySha256 }),
  }) as V2RescanRecord;
}

function manifestBody(releaseId: string, records: readonly V2RescanRecord[], receipt?: V2SourceReceipt): PlainRecord {
  return {
    schemaVersion: V2_RESCAN_MANIFEST_SCHEMA_VERSION,
    releaseId,
    ...(receipt ? { receipt } : {}),
    records,
  };
}

function digestManifest(releaseId: string, records: readonly V2RescanRecord[], receipt?: V2SourceReceipt): string {
  return sha256(canonicalizeJson(manifestBody(releaseId, records, receipt)));
}

export function makeV2RescanManifest(
  releaseId: string,
  records: readonly V2RescanRecord[],
  receipt?: V2SourceReceipt,
): V2RescanManifest {
  assertReleaseId(releaseId);
  if (!Array.isArray(records)) throw new TypeError('Rescan records must be an array.');
  const normalized = records.map(normalizeRecord).sort((left, right) => compareCanonicalStrings(left.entryId, right.entryId));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]?.entryId === normalized[index]?.entryId) throw new TypeError(`Duplicate rescan entry: ${normalized[index]?.entryId}`);
  }
  const frozenRecords = Object.freeze(normalized);
  const validatedReceipt = receipt !== undefined ? validateV2SourceReceipt(receipt) : undefined;
  return Object.freeze({
    schemaVersion: V2_RESCAN_MANIFEST_SCHEMA_VERSION,
    releaseId,
    ...(validatedReceipt !== undefined ? { receipt: validatedReceipt } : {}),
    records: frozenRecords,
    manifestDigest: digestManifest(releaseId, frozenRecords, validatedReceipt),
  });
}

export function parseV2RescanManifest(value: unknown): V2RescanManifest {
  if (!isPlainRecord(value) || value.schemaVersion !== V2_RESCAN_MANIFEST_SCHEMA_VERSION || !Array.isArray(value.records)) throw new TypeError('Rescan manifest is malformed.');
  assertReleaseId(value.releaseId);
  if (typeof value.manifestDigest !== 'string' || !DIGEST.test(value.manifestDigest)) throw new TypeError('Rescan manifest digest is malformed.');
  const rawReceipt = 'receipt' in value ? (value.receipt as V2SourceReceipt) : undefined;
  const manifest = makeV2RescanManifest(value.releaseId, value.records, rawReceipt);
  if (manifest.manifestDigest !== value.manifestDigest) throw new TypeError('Rescan manifest digest does not match its records.');
  return manifest;
}

export const validateV2RescanManifest = parseV2RescanManifest;

export async function writeV2RescanManifest(releaseDirectory: string, manifest: V2RescanManifest): Promise<string> {
  const parsed = parseV2RescanManifest(manifest);
  const filePath = join(releaseDirectory, 'v2-rescan-manifest.json');
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return filePath;
}

export async function readV2RescanManifest(filePath: string): Promise<V2RescanManifest> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    throw new Error(`Unable to read rescan manifest: ${filePath}`);
  }
  try {
    return parseV2RescanManifest(JSON.parse(content) as unknown);
  } catch {
    throw new Error(`Invalid rescan manifest: ${filePath}`);
  }
}

export function isV2RescanRecordStale(previous: V2RescanRecord, current: V2RescanRecord): boolean {
  if (previous.entryId !== current.entryId || previous.sourceDigest !== current.sourceDigest || previous.inputSha256 !== current.inputSha256) return true;
  return AUTHORITY_FIELDS.some((field) => previous[field] !== current[field]);
}

export function isV2RescanRecordCacheEligible(record: V2RescanRecord): boolean {
  return (
    record.ok === true &&
    record.analysisStatus === 'COMPLETE' &&
    typeof record.securitySha256 === 'string' &&
    DIGEST.test(record.securitySha256) &&
    record.securityProjectionVersion === ENTRY_SECURITY_PROJECTION_VERSION
  );
}

export const isRescanRecordStale = isV2RescanRecordStale;
