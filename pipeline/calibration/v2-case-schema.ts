import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { TargetContextV3 } from '../../contracts/scanner-v2-result';
import { createTargetContextDigestV3, isStrictTargetSemver, validateTargetPairsV3 } from '../../contracts/scanner-target-v3';

export const V2_CALIBRATION_SCHEMA_VERSION = 'calibration-case-v2' as const;
export type V2CalibrationSplit = 'development' | 'holdout';
export type V2ExpectedLabel = 'POSITIVE' | 'NEGATIVE' | 'NEAR_MISS' | 'UNSUPPORTED';
export type V2ObservedState = 'POSITIVE' | 'NEGATIVE' | 'UNKNOWN' | 'ABSTAINED' | 'DEGRADED' | 'OMITTED' | 'REJECTED';
export type V2AnalysisStatus = 'COMPLETE' | 'DEGRADED' | 'INDETERMINATE' | 'REJECTED';
export type V2Digest = string;
export type V2CalibrationTarget = TargetContextV3;
export type V2CalibrationProvenance = { source: string; commit: string; path: string; licence: string; permission: string; digest: V2Digest };
export type V2CalibrationReview = { labelSource: string; reviewer: string; reviewedAt: string };
export type V2CalibrationAuthority = {
  engine: { id: string; version: string; buildDigest: V2Digest };
  profile: { id: string; version: string };
  ruleset: { id: string; version: string; digest: V2Digest; signatureStatus: 'VERIFIED' | 'UNVERIFIED' };
  semantics: { id: string; version: string; digest: V2Digest };
};
export type V2ExpectedRule = { ruleId: string; label: V2ExpectedLabel };
export type V2CalibrationExpectation = { label: V2ExpectedLabel; rules: readonly V2ExpectedRule[]; analysisStatus?: V2AnalysisStatus };
export type V2CalibrationCase = {
  schemaVersion: typeof V2_CALIBRATION_SCHEMA_VERSION;
  id: string;
  bytes: Uint8Array;
  provenance: V2CalibrationProvenance;
  review?: V2CalibrationReview;
  target: V2CalibrationTarget;
  profile: { id: string; version: string };
  authority: V2CalibrationAuthority;
  split: V2CalibrationSplit;
  expected: V2CalibrationExpectation;
};

export type V2CalibrationErrorCode =
  | 'UNKNOWN_KEY' | 'INVALID_CASE' | 'DUPLICATE_ID' | 'INVALID_UTF8' | 'UNSAFE_BYTES'
  | 'MISSING_PROVENANCE' | 'INVALID_EXPECTATION' | 'INVALID_AUTHORITY';
export class V2CalibrationValidationError extends Error {
  constructor(public readonly code: V2CalibrationErrorCode, message: string) { super(message); this.name = 'V2CalibrationValidationError'; }
}

const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ENUMS = {
  edition: ['COMMUNITY', 'ENTERPRISE', 'CLOUD', 'UNKNOWN'],
  deployment: ['SELF_HOSTED', 'CLOUD', 'UNKNOWN'], role: ['OWNER', 'ADMIN', 'MEMBER', 'UNKNOWN'],
  taskRunner: ['LEGACY', 'NATIVE', 'UNKNOWN'],
} as const;

type Plain = Record<string, unknown>;
function fail(code: V2CalibrationErrorCode, message: string): never { throw new V2CalibrationValidationError(code, message); }
function plain(value: unknown, keys: readonly string[], required: readonly string[], label: string): Plain {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || Object.getOwnPropertySymbols(value).length) return fail('INVALID_CASE', `${label} must be a plain object.`);
    const names = Object.getOwnPropertyNames(value);
    for (const name of names) if (!keys.includes(name)) return fail('UNKNOWN_KEY', `${label}.${name} is not allowed.`);
    for (const name of required) if (!names.includes(name)) return fail('INVALID_CASE', `${label}.${name} is required.`);
    const result: Plain = {};
    for (const name of names) { const descriptor = Object.getOwnPropertyDescriptor(value, name); if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail('INVALID_CASE', `${label}.${name} must be enumerable data.`); result[name] = descriptor.value; }
    return result;
  } catch (error) { if (error instanceof V2CalibrationValidationError) throw error; return fail('INVALID_CASE', `${label} cannot be inspected.`); }
}
function dense(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) return fail('INVALID_CASE', `${label} must be a dense array.`);
  const names = Object.getOwnPropertyNames(value); if (names.length !== value.length + 1 || !names.includes('length')) return fail('INVALID_CASE', `${label} must be a dense array.`);
  return value.map((item, index) => { if (!Object.prototype.hasOwnProperty.call(value, String(index))) return fail('INVALID_CASE', `${label}[${index}] is missing.`); return item; });
}
function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0') || /[\u0001-\u001f\u007f]/.test(value) || /[\ud800-\udfff]/.test(value) && !/^[\u0000-\ud7ff\ue000-\uffff]*(?:[\ud800-\udbff][\udc00-\udfff][\u0000-\ud7ff\ue000-\uffff]*)*$/.test(value)) return fail('INVALID_CASE', `${label} is unsafe text.`);
  return value;
}
function digest(value: unknown, label: string): string { if (typeof value !== 'string' || !DIGEST.test(value)) return fail('INVALID_AUTHORITY', `${label} must be a lowercase SHA-256 digest.`); return value; }
function enumValue(value: unknown, values: readonly string[], label: string): string { if (typeof value !== 'string' || !values.includes(value)) return fail('INVALID_CASE', `${label} has an invalid value.`); return value; }
function bytes(value: unknown): Uint8Array {
  try {
    if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype || Object.getOwnPropertySymbols(value).length) return fail('UNSAFE_BYTES', 'Calibration bytes must be a plain Uint8Array.');
    const names = Object.getOwnPropertyNames(value); if (names.length !== value.byteLength || names.some((name) => !/^\d+$/.test(name))) return fail('UNSAFE_BYTES', 'Calibration bytes have unsafe own properties.');
    for (const name of names) { const descriptor = Object.getOwnPropertyDescriptor(value, name); if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail('UNSAFE_BYTES', 'Calibration bytes must contain data elements only.'); }
    const copy = Uint8Array.prototype.slice.call(value) as Uint8Array;
    for (const byte of copy) if (byte === 0x7f || byte === 0 || byte < 0x09 || byte === 0x0b || byte === 0x0c || byte === 0x0e || byte === 0x0f || byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return fail('UNSAFE_BYTES', 'Calibration bytes contain unsafe raw control bytes.');
    try { new TextDecoder('utf-8', { fatal: true }).decode(copy); } catch { return fail('INVALID_UTF8', 'Calibration bytes are not valid UTF-8.'); }
    return copy;
  } catch (error) { if (error instanceof V2CalibrationValidationError) throw error; return fail('UNSAFE_BYTES', 'Calibration bytes cannot be inspected.'); }
}
function target(value: unknown): V2CalibrationTarget {
  const raw = plain(value, ['schemaVersion', 'n8nVersion', 'edition', 'deployment', 'role', 'taskRunner', 'communityPackages', 'configuration', 'contextDigest'], ['schemaVersion', 'edition', 'deployment', 'role', 'taskRunner', 'communityPackages', 'configuration', 'contextDigest'], 'target');
  enumValue(raw.schemaVersion, ['scanner-target-v3'], 'target.schemaVersion');
  if (raw.n8nVersion !== undefined && !isStrictTargetSemver(text(raw.n8nVersion, 'target.n8nVersion'))) return fail('INVALID_CASE', 'target.n8nVersion must be strict SemVer.');
  for (const key of ['edition', 'deployment', 'role', 'taskRunner'] as const) enumValue(raw[key], ENUMS[key], `target.${key}`);
  const packages = dense(raw.communityPackages, 'target.communityPackages');
  const communityPackages = packages.map((item, index) => { const p = plain(item, ['name', 'version'], ['name'], `target.communityPackages[${index}]`); const name = text(p.name, `${index}.name`, 512); return Object.freeze({ name, ...(p.version === undefined ? {} : { version: text(p.version, `${index}.version`, 128) }) }); });
  const configurations = dense(raw.configuration, 'target.configuration'); const configKeys = new Set<string>();
  const configuration = configurations.map((item, index) => { const c = plain(item, ['key', 'state'], ['key', 'state'], `target.configuration[${index}]`); const key = text(c.key, `${index}.key`, 512); if (configKeys.has(key)) return fail('INVALID_CASE', 'target.configuration has duplicate keys.'); configKeys.add(key); return Object.freeze({ key, state: enumValue(c.state, ['ENABLED', 'DISABLED', 'UNKNOWN'], `${index}.state`) as 'ENABLED' | 'DISABLED' | 'UNKNOWN' }); });
  const normalized = { schemaVersion: raw.schemaVersion as V2CalibrationTarget['schemaVersion'], ...(raw.n8nVersion === undefined ? {} : { n8nVersion: raw.n8nVersion as string }), edition: raw.edition as V2CalibrationTarget['edition'], deployment: raw.deployment as V2CalibrationTarget['deployment'], role: raw.role as V2CalibrationTarget['role'], taskRunner: raw.taskRunner as V2CalibrationTarget['taskRunner'], communityPackages: Object.freeze(communityPackages), configuration: Object.freeze(configuration) };
  if (!validateTargetPairsV3(normalized)) return fail('INVALID_CASE', 'target.communityPackages is not canonical.');
  const contextDigest = createTargetContextDigestV3(normalized);
  if (digest(raw.contextDigest, 'target.contextDigest') !== contextDigest) return fail('INVALID_CASE', 'target.contextDigest does not match target contents.');
  return Object.freeze({ ...normalized, contextDigest });
}
function authority(value: unknown): V2CalibrationAuthority {
  const raw = plain(value, ['engine', 'profile', 'ruleset', 'semantics'], ['engine', 'profile', 'ruleset', 'semantics'], 'authority');
  const engine = plain(raw.engine, ['id', 'version', 'buildDigest'], ['id', 'version', 'buildDigest'], 'authority.engine');
  const profile = plain(raw.profile, ['id', 'version'], ['id', 'version'], 'authority.profile');
  const ruleset = plain(raw.ruleset, ['id', 'version', 'digest', 'signatureStatus'], ['id', 'version', 'digest', 'signatureStatus'], 'authority.ruleset');
  const semantics = plain(raw.semantics, ['id', 'version', 'digest'], ['id', 'version', 'digest'], 'authority.semantics');
  return Object.freeze({ engine: Object.freeze({ id: text(engine.id, 'authority.engine.id'), version: text(engine.version, 'authority.engine.version'), buildDigest: digest(engine.buildDigest, 'authority.engine.buildDigest') }), profile: Object.freeze({ id: text(profile.id, 'authority.profile.id'), version: text(profile.version, 'authority.profile.version') }), ruleset: Object.freeze({ id: text(ruleset.id, 'authority.ruleset.id'), version: text(ruleset.version, 'authority.ruleset.version'), digest: digest(ruleset.digest, 'authority.ruleset.digest'), signatureStatus: enumValue(ruleset.signatureStatus, ['VERIFIED', 'UNVERIFIED'], 'authority.ruleset.signatureStatus') as 'VERIFIED' | 'UNVERIFIED' }), semantics: Object.freeze({ id: text(semantics.id, 'authority.semantics.id'), version: text(semantics.version, 'authority.semantics.version'), digest: digest(semantics.digest, 'authority.semantics.digest') }) });
}

export function createV2CalibrationCase(input: unknown): V2CalibrationCase {
  const raw = plain(input, ['schemaVersion', 'id', 'bytes', 'provenance', 'review', 'target', 'profile', 'authority', 'split', 'expected'], ['schemaVersion', 'id', 'bytes', 'provenance', 'target', 'profile', 'authority', 'split', 'expected'], 'case');
  if (raw.schemaVersion !== V2_CALIBRATION_SCHEMA_VERSION) return fail('INVALID_CASE', 'case.schemaVersion is not calibration-case-v2.');
  const id = text(raw.id, 'case.id', 128); if (!ID.test(id)) return fail('INVALID_CASE', 'case.id must be a stable lowercase identifier.');
  const rawBytes = bytes(raw.bytes);
  const provenanceRaw = plain(raw.provenance, ['source', 'commit', 'path', 'licence', 'permission', 'digest'], ['source', 'commit', 'path', 'licence', 'permission', 'digest'], 'provenance');
  const provenance = Object.freeze({ source: text(provenanceRaw.source, 'provenance.source'), commit: text(provenanceRaw.commit, 'provenance.commit'), path: text(provenanceRaw.path, 'provenance.path'), licence: text(provenanceRaw.licence, 'provenance.licence'), permission: text(provenanceRaw.permission, 'provenance.permission'), digest: digest(provenanceRaw.digest, 'provenance.digest') });
  const review = raw.review === undefined ? undefined : (() => { const reviewRaw = plain(raw.review, ['labelSource', 'reviewer', 'reviewedAt'], ['labelSource', 'reviewer', 'reviewedAt'], 'review'); const reviewedAt = text(reviewRaw.reviewedAt, 'review.reviewedAt', 64); if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt)) return fail('INVALID_CASE', 'review.reviewedAt must be an ISO date.'); return Object.freeze({ labelSource: text(reviewRaw.labelSource, 'review.labelSource'), reviewer: text(reviewRaw.reviewer, 'review.reviewer'), reviewedAt }); })();
  const actualDigest = bytesToHex(sha256(rawBytes)); if (provenance.digest !== actualDigest) return fail('MISSING_PROVENANCE', 'provenance.digest does not match the source bytes.');
  const profileRaw = plain(raw.profile, ['id', 'version'], ['id', 'version'], 'profile'); const profileId = text(profileRaw.id, 'profile.id'); const profileVersion = text(profileRaw.version, 'profile.version'); if (!VERSION.test(profileVersion)) return fail('INVALID_CASE', 'profile.version must be semver.'); const profile = Object.freeze({ id: profileId, version: profileVersion });
  const expectedRaw = plain(raw.expected, ['label', 'rules', 'analysisStatus'], ['label', 'rules'], 'expected'); const ruleItems = dense(expectedRaw.rules, 'expected.rules'); const seen = new Set<string>();
  const rules = ruleItems.map((item, index) => { const rule = plain(item, ['ruleId', 'label'], ['ruleId', 'label'], `expected.rules[${index}]`); const ruleId = text(rule.ruleId, `${index}.ruleId`, 256); if (seen.has(ruleId)) return fail('INVALID_EXPECTATION', 'expected.rules has duplicate rule IDs.'); seen.add(ruleId); return Object.freeze({ ruleId, label: enumValue(rule.label, ['POSITIVE', 'NEGATIVE', 'NEAR_MISS', 'UNSUPPORTED'], `${index}.label`) as V2ExpectedLabel }); });
  const label = enumValue(expectedRaw.label, ['POSITIVE', 'NEGATIVE', 'NEAR_MISS', 'UNSUPPORTED'], 'expected.label') as V2ExpectedLabel;
  if (label === 'POSITIVE' && !rules.some((rule) => rule.label === 'POSITIVE')) return fail('INVALID_EXPECTATION', 'POSITIVE cases must name at least one POSITIVE rule.');
  const expected = Object.freeze({ label, rules: Object.freeze(rules), ...(expectedRaw.analysisStatus === undefined ? {} : { analysisStatus: enumValue(expectedRaw.analysisStatus, ['COMPLETE', 'DEGRADED', 'INDETERMINATE', 'REJECTED'], 'expected.analysisStatus') as V2AnalysisStatus }) });
  const normalizedTarget = target(raw.target); const normalizedAuthority = authority(raw.authority);
  if (normalizedAuthority.profile.id !== profile.id || normalizedAuthority.profile.version !== profile.version) return fail('INVALID_AUTHORITY', 'authority.profile must match profile identity.');
  return Object.freeze({ schemaVersion: V2_CALIBRATION_SCHEMA_VERSION, id, bytes: rawBytes, provenance, ...(review === undefined ? {} : { review }), target: normalizedTarget, profile, authority: normalizedAuthority, split: enumValue(raw.split, ['development', 'holdout'], 'case.split') as V2CalibrationSplit, expected });
}
export const validateV2CalibrationCase = createV2CalibrationCase;
