import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJsonBytes, canonicalizeJson } from '../canonical-json';
import { compareSemver, parseStrictSemver, type StrictSemver } from '../semantics/semver';
import { validateVersionRange, type VersionComparatorV2, type VersionRangeV2 } from '../semantics/version-range';
import type {
  AdvisoryCatalogueV2, AdvisoryCvssV2, AdvisoryPrerequisiteV2, AdvisoryRecordV2, AdvisoryReviewStateV2,
} from './advisory-schema';

type Dict = Record<string, unknown>;
export type AdvisoryAdmissionErrorCode =
  | 'UNSAFE_INPUT' | 'UNKNOWN_KEY' | 'MISSING_KEY' | 'INVALID_SCHEMA_VERSION' | 'INVALID_VERSION'
  | 'INVALID_RANGE' | 'INVALID_TEXT' | 'INVALID_PACKAGE' | 'INVALID_PROVENANCE' | 'INVALID_CVSS'
  | 'INVALID_STATE' | 'DUPLICATE_ID' | 'DUPLICATE_ALIAS' | 'DIGEST_MISMATCH';
export class AdvisoryAdmissionError extends TypeError {
  readonly code: AdvisoryAdmissionErrorCode;
  constructor(code: AdvisoryAdmissionErrorCode, label?: string) { super(`${code}${label ? `: ${label}` : ''}`); this.name = 'AdvisoryAdmissionError'; this.code = code; }
}

const TOP = ['schemaVersion', 'version', 'records', 'digest'] as const;
const RECORD = ['id', 'aliases', 'packageName', 'rawAffectedRange', 'affected', 'fixedVersions', 'fixedBranches', 'prerequisites', 'cvss', 'sourceUrl', 'sourceDigest', 'reviewedAt', 'reviewer', 'reviewState'] as const;
const PREREQUISITE = ['key', 'expected'] as const;
const CVSS = ['version', 'publisher', 'vector'] as const;
const DIGEST = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Z0-9][A-Z0-9._:-]*$/;
const PACKAGE = /^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/;
const DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z)?$/;
const STATES = ['ADMITTED', 'QUARANTINED', 'WITHDRAWN', 'REJECTED'] as const;
const ENUM_PREREQUISITES = new Set(['edition', 'deployment', 'role', 'taskRunner']);
const MAX_TEXT = 4096;
const MAX_ITEMS = 100_000;
const has = (value: Dict, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
function fail(code: AdvisoryAdmissionErrorCode, label?: string): never { throw new AdvisoryAdmissionError(code, label); }
function own(input: unknown, allowed: readonly string[], label: string): Dict {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('UNSAFE_INPUT', label);
    const proto = Object.getPrototypeOf(input); if (proto !== Object.prototype && proto !== null) return fail('UNSAFE_INPUT', label);
    if (Object.getOwnPropertySymbols(input).length !== 0) return fail('UNSAFE_INPUT', label);
    const output: Dict = Object.create(null);
    const names = Object.getOwnPropertyNames(input);
    if (names.length > MAX_ITEMS) return fail('UNSAFE_INPUT', label);
    for (const name of names) {
      if (!allowed.includes(name)) return fail('UNKNOWN_KEY', `${label}.${name}`);
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (!descriptor || !('value' in descriptor)) return fail('UNSAFE_INPUT', `${label}.${name}`);
      output[name] = descriptor.value;
    }
    return output;
  } catch (error) { if (error instanceof AdvisoryAdmissionError) throw error; return fail('UNSAFE_INPUT', label); }
}
function dense(input: unknown, label: string): unknown[] {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return fail('UNSAFE_INPUT', label);
    const length = Object.getOwnPropertyDescriptor(input, 'length');
    if (!length || !('value' in length) || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_ITEMS) return fail('UNSAFE_INPUT', label);
    const names = Object.getOwnPropertyNames(input); if (names.length !== length.value + 1 || Object.getOwnPropertySymbols(input).length !== 0) return fail('UNSAFE_INPUT', label);
    const result: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(input, String(index)); if (!descriptor || !('value' in descriptor)) return fail('UNSAFE_INPUT', `${label}[${index}]`); result.push(descriptor.value); }
    return result;
  } catch (error) { if (error instanceof AdvisoryAdmissionError) throw error; return fail('UNSAFE_INPUT', label); }
}
function text(input: unknown, label: string, maximum = MAX_TEXT): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > maximum || input !== input.normalize('NFC')) return fail('INVALID_TEXT', label);
  for (let index = 0; index < input.length; index += 1) { const code = input.charCodeAt(index); if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return fail('INVALID_TEXT', label); if (code >= 0xd800 && code <= 0xdbff) { const next = input.charCodeAt(index + 1); if (!(next >= 0xdc00 && next <= 0xdfff)) return fail('INVALID_TEXT', label); index += 1; } else if (code >= 0xdc00 && code <= 0xdfff) return fail('INVALID_TEXT', label); }
  if (new TextEncoder().encode(input).length > maximum) return fail('INVALID_TEXT', label);
  return input;
}
function compareText(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1; }
function sorted(values: readonly string[]): readonly string[] { return Object.freeze([...new Set(values)].sort(compareText)); }
function identifier(input: unknown, label: string): string { const value = text(input, label, 255).trim().toUpperCase(); if (!IDENTIFIER.test(value)) return fail('INVALID_TEXT', label); return value; }
function packageName(input: unknown, label: string): string { const value = text(input, label, 214).trim().toLowerCase(); if (!PACKAGE.test(value)) return fail('INVALID_PACKAGE', label); return value; }
function calendarDate(input: unknown, label: string): string {
  const value = text(input, label, 64); const match = DATE.exec(value); if (!match) return fail('INVALID_PROVENANCE', label);
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]); const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (day > days) return fail('INVALID_PROVENANCE', label); return value;
}
function semverText(input: unknown, label: string): string {
  if (typeof input === 'string') return input;
  const value = own(input, ['major', 'minor', 'patch', 'prerelease', 'build'], label);
  const numbers = ['major', 'minor', 'patch'].map((key) => value[key]);
  if (numbers.some((part) => typeof part !== 'number' || !Number.isSafeInteger(part) || part < 0)) return fail('INVALID_VERSION', label);
  const readIdentifiers = (part: unknown): string[] => dense(part, label).map((item) => text(item, label, 256));
  const prerelease = readIdentifiers(value.prerelease); const build = readIdentifiers(value.build);
  return `${numbers[0]}.${numbers[1]}.${numbers[2]}${prerelease.length ? `-${prerelease.join('.')}` : ''}${build.length ? `+${build.join('.')}` : ''}`;
}
function semver(input: unknown, label: string): StrictSemver {
  try { return parseStrictSemver(semverText(input, label)); } catch { return fail('INVALID_VERSION', label); }
}
function comparator(input: unknown, label: string): VersionComparatorV2 {
  const value = own(input, ['op', 'version'], label); if (!has(value, 'op') || !has(value, 'version')) return fail('MISSING_KEY', label);
  if (!['EQ', 'LT', 'LTE', 'GT', 'GTE'].includes(value.op as string)) return fail('INVALID_RANGE', label);
  const version = semverText(value.version, `${label}.version`); semver(version, `${label}.version`); return { op: value.op as VersionComparatorV2['op'], version };
}
function compareComparator(left: VersionComparatorV2, right: VersionComparatorV2): number {
  const byVersion = compareSemver(parseStrictSemver(left.version), parseStrictSemver(right.version));
  if (byVersion !== 0) return byVersion;
  const order: Record<VersionComparatorV2['op'], number> = { EQ: 0, LT: 1, LTE: 2, GT: 3, GTE: 4 };
  return order[left.op] - order[right.op] || compareText(canonicalizeJson(left), canonicalizeJson(right));
}
function normalizedRange(input: unknown, label: string): VersionRangeV2 {
  const value = own(input, ['clauses'], label); if (!has(value, 'clauses')) return fail('MISSING_KEY', label);
  const clauses = dense(value.clauses, `${label}.clauses`).map((rawClause, clauseIndex) => {
    const items = dense(rawClause, `${label}.clauses[${clauseIndex}]`).map((item, index) => comparator(item, `${label}.clauses[${clauseIndex}][${index}]`));
    if (items.length === 0) return fail('INVALID_RANGE', label);
    return items.sort(compareComparator);
  }).sort((left, right) => compareText(canonicalizeJson(left), canonicalizeJson(right)));
  try { return validateVersionRange({ clauses }); } catch { return fail('INVALID_RANGE', label); }
}
function prerequisite(input: unknown, label: string): AdvisoryPrerequisiteV2 {
  const value = own(input, PREREQUISITE, label); if (!has(value, 'key') || !has(value, 'expected')) return fail('MISSING_KEY', label);
  let key = text(value.key, `${label}.key`).trim(); let expected = text(value.expected, `${label}.expected`).trim();
  if (!key || !expected) return fail('INVALID_TEXT', label);
  const aliases: Record<string, string> = { edition: 'edition', deployment: 'deployment', role: 'role', taskrunner: 'taskRunner', n8nversion: 'n8nVersion' };
  key = aliases[key.toLowerCase()] ?? key;
  if (ENUM_PREREQUISITES.has(key)) expected = expected.toUpperCase();
  if (key.startsWith('package:')) key = `package:${packageName(key.slice(8), `${label}.key`)}`;
  if (key.startsWith('configuration:')) key = `configuration:${text(key.slice(14), `${label}.key`)}`;
  if (!/^(?:edition|deployment|role|taskRunner|n8nVersion|package:[a-z0-9@][a-z0-9._@/-]*|configuration:[a-zA-Z0-9._-]+)$/.test(key)) return fail('INVALID_TEXT', `${label}.key`);
  const enums: Record<string, readonly string[]> = { edition: ['COMMUNITY', 'ENTERPRISE', 'CLOUD'], deployment: ['SELF_HOSTED', 'CLOUD'], role: ['OWNER', 'ADMIN', 'MEMBER'], taskRunner: ['LEGACY', 'NATIVE'] };
  if (enums[key] && !enums[key].includes(expected)) return fail('INVALID_TEXT', label);
  if (key === 'n8nVersion' || key.startsWith('package:')) { try { parseStrictSemver(expected); } catch { return fail('INVALID_VERSION', label); } }
  if (key.startsWith('configuration:') && !['ENABLED', 'DISABLED'].includes(expected)) return fail('INVALID_TEXT', label);
  return Object.freeze({ key, expected });
}
function cvss(input: unknown, label: string): AdvisoryCvssV2 {
  const value = own(input, CVSS, label); if (!has(value, 'version') || !has(value, 'publisher') || !has(value, 'vector')) return fail('MISSING_KEY', label);
  if (value.version !== '3.1' && value.version !== '4.0') return fail('INVALID_CVSS', label);
  if (typeof value.publisher !== 'string' || value.publisher.trim().length === 0 || typeof value.vector !== 'string' || value.vector.trim().length === 0) return fail('INVALID_CVSS', label);
  const publisher = text(value.publisher, `${label}.publisher`, 256).trim(); const vector = text(value.vector, `${label}.vector`, 512).trim();
  if (!publisher || !new RegExp(`^CVSS:${value.version}/[A-Z0-9-]+:[A-Z0-9-]+(?:/[A-Z0-9-]+:[A-Z0-9-]+)+$`).test(vector)) return fail('INVALID_CVSS', label);
  return Object.freeze({ version: value.version, publisher, vector });
}
function record(input: unknown, label: string): AdvisoryRecordV2 | null {
  const value = own(input, RECORD, label); if (value.reviewState === 'QUARANTINED') return null;
  for (const key of RECORD) if (key !== 'cvss' && !has(value, key)) return fail('MISSING_KEY', `${label}.${key}`);
  if (!STATES.includes(value.reviewState as AdvisoryReviewStateV2)) return fail('INVALID_STATE', `${label}.reviewState`);
  const aliases = dense(value.aliases, `${label}.aliases`).map((item, index) => identifier(item, `${label}.aliases[${index}]`));
  const id = identifier(value.id, `${label}.id`); const allAliases = sorted([...aliases, id]);
  const fixedVersions = dense(value.fixedVersions, `${label}.fixedVersions`).map((item, index) => semver(item, `${label}.fixedVersions[${index}]`));
  const fixedBranches = sorted(dense(value.fixedBranches, `${label}.fixedBranches`).map((item, index) => text(item, `${label}.fixedBranches[${index}]`).trim()));
  if (fixedBranches.some((branch) => branch.length === 0)) return fail('INVALID_TEXT', `${label}.fixedBranches`);
  const prerequisites = dense(value.prerequisites, `${label}.prerequisites`).map((item, index) => prerequisite(item, `${label}.prerequisites[${index}]`)).sort((left, right) => compareText(canonicalizeJson(left), canonicalizeJson(right)));
  if (new Set(prerequisites.map((item) => canonicalizeJson(item))).size !== prerequisites.length) return fail('INVALID_TEXT', `${label}.prerequisites`);
  const rawAffectedRange = text(value.rawAffectedRange, `${label}.rawAffectedRange`); if (!rawAffectedRange.trim()) return fail('INVALID_RANGE', `${label}.rawAffectedRange`);
  const sourceUrl = text(value.sourceUrl, `${label}.sourceUrl`, 2_048).trim();
  try { const parsed = new URL(sourceUrl); if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) return fail('INVALID_PROVENANCE', `${label}.sourceUrl`); } catch { return fail('INVALID_PROVENANCE', `${label}.sourceUrl`); }
  const sourceDigest = text(value.sourceDigest, `${label}.sourceDigest`, 64); if (!DIGEST.test(sourceDigest)) return fail('INVALID_PROVENANCE', `${label}.sourceDigest`);
  const reviewer = text(value.reviewer, `${label}.reviewer`).trim(); if (!reviewer) return fail('INVALID_PROVENANCE', `${label}.reviewer`);
  const result: Dict = { id, aliases: allAliases, packageName: packageName(value.packageName, `${label}.packageName`), rawAffectedRange, affected: normalizedRange(value.affected, `${label}.affected`), fixedVersions: Object.freeze(fixedVersions.sort((left, right) => compareSemver(left, right) || compareText(semverText(left, `${label}.fixedVersions`), semverText(right, `${label}.fixedVersions`)))), fixedBranches, prerequisites: Object.freeze(prerequisites), sourceUrl, sourceDigest, reviewedAt: calendarDate(value.reviewedAt, `${label}.reviewedAt`), reviewer, reviewState: value.reviewState };
  if (has(value, 'cvss')) { if (value.cvss === undefined) return fail('INVALID_CVSS', `${label}.cvss`); result.cvss = cvss(value.cvss, `${label}.cvss`); }
  return Object.freeze(result) as AdvisoryRecordV2;
}
function body(input: unknown): { schemaVersion: 'scanner-advisories-v2'; version: string; records: readonly AdvisoryRecordV2[] } {
  const value = own(input, TOP, 'catalogue'); for (const key of TOP.slice(0, -1)) if (!has(value, key)) return fail('MISSING_KEY', `catalogue.${key}`);
  if (value.schemaVersion !== 'scanner-advisories-v2') return fail('INVALID_SCHEMA_VERSION');
  const version = semverText(value.version, 'catalogue.version'); semver(version, 'catalogue.version');
  const records = dense(value.records, 'catalogue.records').map((item, index) => record(item, `catalogue.records[${index}]`)).filter((item): item is AdvisoryRecordV2 => item !== null).sort((left, right) => compareText(canonicalizeJson(left), canonicalizeJson(right)));
  const ids = new Set<string>(); const aliases = new Set<string>();
  for (const item of records) { if (ids.has(item.id)) return fail('DUPLICATE_ID', item.id); ids.add(item.id); for (const alias of item.aliases) { if (aliases.has(alias)) return fail('DUPLICATE_ALIAS', alias); aliases.add(alias); } }
  return { schemaVersion: 'scanner-advisories-v2', version, records: Object.freeze(records) };
}
function freeze<T>(value: T, seen = new WeakSet<object>()): T { if (value !== null && typeof value === 'object') { if (seen.has(value)) return value; seen.add(value); for (const key of Object.getOwnPropertyNames(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (descriptor && 'value' in descriptor) freeze(descriptor.value, seen); } Object.freeze(value); } return value; }

export function createAdvisoryCatalogueDigest(input: unknown): string { return bytesToHex(sha256(canonicalJsonBytes(body(input)))); }
export function admitAdvisoryCatalogue(input: unknown): AdvisoryCatalogueV2 {
  try {
    const normalized = body(input); const value = own(input, TOP, 'catalogue');
    const expected = createAdvisoryCatalogueDigest(normalized); const supplied = value.digest;
    if (typeof supplied !== 'string' || !DIGEST.test(supplied) || supplied !== expected) return fail('DIGEST_MISMATCH');
    return freeze({ version: normalized.version, records: normalized.records, digest: expected });
  } catch (error) { if (error instanceof AdvisoryAdmissionError) throw error; return fail('UNSAFE_INPUT'); }
}
