import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJsonBytes, canonicalizeJson } from '../canonical-json';
import { validateVersionRange, matchesVersionRange, type VersionRangeV2 } from './version-range';
import { parseStrictSemver, type StrictSemver } from './semver';
import type {
  ResolvedNodeSemanticsV2, SemanticAuthenticationV2, SemanticCatalogueBodyV2, SemanticCatalogueV2, SemanticEndpointV2,
  SemanticEffectV2, SemanticPathV2, SemanticPortV2, SemanticProvenanceV2,
} from './catalogue-schema';

type Dict = Record<string, unknown>;
export type SemanticCatalogueErrorCode = 'UNSAFE_INPUT' | 'UNKNOWN_KEY' | 'MISSING_KEY' | 'INVALID_SCHEMA_VERSION' | 'INVALID_VERSION' | 'INVALID_TEXT' | 'INVALID_ENUM' | 'INVALID_RANGE' | 'INVALID_PROVENANCE' | 'INVALID_AUTHENTICATION' | 'DUPLICATE_ID' | 'DUPLICATE_RECORD' | 'DUPLICATE_CONFIGURATION_KEY' | 'DIGEST_MISMATCH' | 'SEMANTIC_CATALOGUE_AMBIGUOUS';
export class SemanticCatalogueAdmissionError extends TypeError {
  readonly code: SemanticCatalogueErrorCode;
  constructor(code: SemanticCatalogueErrorCode, label?: string) { super(`${code}${label ? `: ${label}` : ''}`); this.name = 'SemanticCatalogueAdmissionError'; this.code = code; }
}
const TOP = ['schemaVersion', 'id', 'version', 'records', 'configurationKeys', 'digest'] as const;
const RECORD = ['semanticId', 'nodeType', 'versionRange', 'operation', 'entry', 'parameterPaths', 'authentication', 'credentialPaths', 'destinationPaths', 'effects', 'endpoints', 'ports', 'overwritePaths', 'errorMode', 'retryMode', 'disabledMode', 'provenance'] as const;
const PROVENANCE = ['sourceUrl', 'sourceDigest', 'reviewedAt', 'reviewer'] as const;
const MAX_ITEMS = 100_000;
const MAX_TEXT = 4_096;
const DIGEST = /^[0-9a-f]{64}$/;
const REVIEWED_AT = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z)?$/;
const enums = {
  entry: ['TRIGGER', 'MANUAL', 'SUBWORKFLOW', 'NONE'], valueType: ['ANY', 'STRING', 'BOOLEAN', 'NUMBER', 'OBJECT', 'ARRAY'],
  effect: ['READ_EXTERNAL', 'WRITE_EXTERNAL', 'EXECUTE_CODE', 'EXECUTE_COMMAND', 'READ_FILE', 'WRITE_FILE', 'DATABASE_READ', 'DATABASE_WRITE', 'SEND_MESSAGE', 'CALL_TOOL', 'START_SUBWORKFLOW'],
  channel: ['DATA', 'CONTROL', 'ERROR', 'MODEL', 'TOOL', 'CONTEXT'], direction: ['SOURCE', 'SINK', 'SANITIZER'], taint: ['CONFIDENTIALITY', 'INTEGRITY', 'BOTH'],
  itemMode: ['EACH', 'ALL', 'PAIRWISE', 'UNKNOWN'], errorMode: ['STOP', 'CONTINUE', 'OUTPUT', 'UNKNOWN'], retryMode: ['NONE', 'BOUNDED', 'PLATFORM', 'UNKNOWN'], disabledMode: ['SKIP', 'UNKNOWN'], unknownValueEffect: ['UNKNOWN', 'EXPOSED'],
} as const;
const has = (value: Dict, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
function fail(code: SemanticCatalogueErrorCode, label?: string): never { throw new SemanticCatalogueAdmissionError(code, label); }
function own(input: unknown, allowed: readonly string[], label: string): Dict {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('UNSAFE_INPUT', label);
    const proto = Object.getPrototypeOf(input); if (proto !== Object.prototype && proto !== null) return fail('UNSAFE_INPUT', label);
    const names = Object.getOwnPropertyNames(input); if (Object.getOwnPropertySymbols(input).length !== 0) return fail('UNSAFE_INPUT', label);
    for (const name of names) if (!allowed.includes(name)) return fail('UNKNOWN_KEY', `${label}.${name}`);
    const output: Dict = Object.create(null);
    for (const name of names) { const descriptor = Object.getOwnPropertyDescriptor(input, name); if (!descriptor || !('value' in descriptor)) return fail('UNSAFE_INPUT', `${label}.${name}`); output[name] = descriptor.value; }
    return output;
  } catch (error) { if (error instanceof SemanticCatalogueAdmissionError) throw error; return fail('UNSAFE_INPUT', label); }
}
function required(value: Dict, keys: readonly string[], label: string): void { for (const key of keys) if (!has(value, key)) fail('MISSING_KEY', `${label}.${key}`); }
function dense(input: unknown, label: string): unknown[] {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return fail('UNSAFE_INPUT', label);
    const length = Object.getOwnPropertyDescriptor(input, 'length'); if (!length || !('value' in length) || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_ITEMS) return fail('UNSAFE_INPUT', label);
    const names = Object.getOwnPropertyNames(input); if (names.length !== length.value + 1 || Object.getOwnPropertySymbols(input).length !== 0) return fail('UNSAFE_INPUT', label);
    for (const name of names) if (name !== 'length' && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= length.value)) return fail('UNSAFE_INPUT', label);
    const output: unknown[] = []; for (let index = 0; index < length.value; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(input, String(index)); if (!descriptor || !('value' in descriptor)) return fail('UNSAFE_INPUT', `${label}[${index}]`); output.push(descriptor.value); } return output;
  } catch (error) { if (error instanceof SemanticCatalogueAdmissionError) throw error; return fail('UNSAFE_INPUT', label); }
}
function text(input: unknown, label: string, maximum = MAX_TEXT, allowEmpty = false): string {
  if (typeof input !== 'string' || (!allowEmpty && input.length === 0) || input.length > maximum || input !== input.normalize('NFC')) return fail('INVALID_TEXT', label);
  for (let index = 0; index < input.length; index += 1) { const code = input.charCodeAt(index); if (code <= 0x1f || code >= 0x7f && code <= 0x9f) return fail('INVALID_TEXT', label); if (code >= 0xd800 && code <= 0xdbff) { const next = input.charCodeAt(index + 1); if (!(next >= 0xdc00 && next <= 0xdfff)) return fail('INVALID_TEXT', label); index += 1; } else if (code >= 0xdc00 && code <= 0xdfff) return fail('INVALID_TEXT', label); }
  if (new TextEncoder().encode(input).length > maximum) return fail('INVALID_TEXT', label); return input;
}
function enumValue<T extends string>(input: unknown, values: readonly T[], label: string): T { if (typeof input !== 'string' || !values.includes(input as T)) return fail('INVALID_ENUM', label); return input as T; }
function pointer(input: unknown, label: string): string { const value = text(input, label, 2_048, true); if (!/^(?:|\/(?:[^~]|~0|~1)*)$/.test(value)) return fail('INVALID_TEXT', label); return value; }
function compare(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1; }
function sortedUnique(values: string[], label: string): readonly string[] { const unique = new Set(values); if (unique.size !== values.length) return fail(label === 'configurationKeys' ? 'DUPLICATE_CONFIGURATION_KEY' : 'DUPLICATE_RECORD', label); return Object.freeze([...unique].sort()); }
function baseText(value: StrictSemver): string { return `${value.major}.${value.minor}.${value.patch}`; }
function versionText(value: StrictSemver): string {
  const prerelease = value.prerelease.length ? `-${value.prerelease.join('.')}` : '';
  const build = value.build.length ? `+${value.build.join('.')}` : '';
  return `${baseText(value)}${prerelease}${build}`;
}
function addPrereleaseSamples(result: Set<string>, value: StrictSemver): void {
  if (value.prerelease.length === 0) return;
  const base = baseText(value); const ids = [...value.prerelease];
  result.add(versionText(value));
  for (let index = 0; index < ids.length; index += 1) {
    const item = ids[index];
    if (/^\d+$/.test(item)) {
      const number = Number(item);
      if (Number.isSafeInteger(number)) {
        if (number > 0) result.add(`${base}-${ids.slice(0, index).concat(String(number - 1)).join('.')}`);
        if (number < Number.MAX_SAFE_INTEGER) result.add(`${base}-${ids.slice(0, index).concat(String(number + 1)).join('.')}`);
      }
    } else {
      for (const replacement of ['a', 'b', 'z']) result.add(`${base}-${ids.slice(0, index).concat(replacement).join('.')}`);
    }
    for (const suffix of ['0', '1', 'z']) result.add(`${base}-${ids.slice(0, index + 1).concat(suffix).join('.')}`);
  }
}
function addVersionSamples(result: Set<string>, value: StrictSemver): void {
  const base = baseText(value);
  result.add(versionText(value)); result.add(base); result.add(`${base}-0`); result.add(`${base}-z`); addPrereleaseSamples(result, value);
  if (value.patch < Number.MAX_SAFE_INTEGER) result.add(`${value.major}.${value.minor}.${value.patch + 1}`);
  if (value.minor < Number.MAX_SAFE_INTEGER) result.add(`${value.major}.${value.minor + 1}.0`);
  if (value.major < Number.MAX_SAFE_INTEGER) result.add(`${value.major + 1}.0.0`);
  if (value.patch > 0) result.add(`${value.major}.${value.minor}.${value.patch - 1}`);
  if (value.minor > 0) result.add(`${value.major}.${value.minor - 1}.0`);
  if (value.major > 0) result.add(`${value.major - 1}.0.0`);
}
function rangeSamples(left: VersionRangeV2, right: VersionRangeV2): readonly string[] {
  const result = new Set(['0.0.0', '1.0.0', '2.0.0', '999999.0.0']);
  for (const range of [left, right]) for (const clause of range.clauses) for (const item of clause) addVersionSamples(result, parseStrictSemver(item.version));
  return [...result];
}
function subset(left: VersionRangeV2, right: VersionRangeV2): boolean {
  let rightOnly = false;
  for (const textValue of rangeSamples(left, right)) { const value = parseStrictSemver(textValue); const leftMatch = matchesVersionRange(value, left); const rightMatch = matchesVersionRange(value, right); if (leftMatch && !rightMatch) return false; if (rightMatch && !leftMatch) rightOnly = true; }
  return rightOnly;
}
function overlap(left: VersionRangeV2, right: VersionRangeV2): boolean {
  return rangeSamples(left, right).some((textValue) => {
    const value = parseStrictSemver(textValue);
    return matchesVersionRange(value, left) && matchesVersionRange(value, right);
  });
}

function stringList(input: unknown, label: string, isPointer = false): readonly string[] { const values = dense(input, label).map((item, index) => isPointer ? pointer(item, `${label}[${index}]`) : text(item, `${label}[${index}]`)); return sortedUnique(values, label); }
function path(input: unknown, label: string): SemanticPathV2 { const value = own(input, ['pointer', 'valueType', 'required'], label); required(value, ['pointer', 'valueType', 'required'], label); return Object.freeze({ pointer: pointer(value.pointer, `${label}.pointer`), valueType: enumValue(value.valueType, enums.valueType, `${label}.valueType`), required: typeof value.required === 'boolean' ? value.required : fail('INVALID_TEXT', `${label}.required`) }); }
function paths(input: unknown, label: string): readonly SemanticPathV2[] {
  const output = dense(input, label).map((item, index) => path(item, `${label}[${index}]`));
  const keys = output.map((item) => canonicalizeJson(item));
  if (new Set(keys).size !== keys.length) return fail('DUPLICATE_RECORD', label);
  return Object.freeze(output.sort((a, b) => compare(canonicalizeJson(a), canonicalizeJson(b))));
}
function authentication(input: unknown, label: string): SemanticAuthenticationV2 | null {
  if (input === null) return null;
  const value = own(input, ['path', 'noneValues', 'authenticatedValues', 'unknownValueEffect'], label);
  required(value, ['path', 'noneValues', 'authenticatedValues', 'unknownValueEffect'], label);
  const noneValues = stringList(value.noneValues, `${label}.noneValues`);
  const authenticatedValues = stringList(value.authenticatedValues, `${label}.authenticatedValues`);
  if (noneValues.some((item) => authenticatedValues.includes(item))) return fail('INVALID_AUTHENTICATION', label);
  return Object.freeze({ path: pointer(value.path, `${label}.path`), noneValues, authenticatedValues, unknownValueEffect: enumValue(value.unknownValueEffect, enums.unknownValueEffect, `${label}.unknownValueEffect`) });
}
function endpoint(input: unknown, label: string): SemanticEndpointV2 { const value = own(input, ['path', 'channel', 'direction', 'taint', 'scope'], label); required(value, ['path', 'channel', 'direction', 'taint'], label); const result: Dict = { path: pointer(value.path, `${label}.path`), channel: enumValue(value.channel, enums.channel, `${label}.channel`), direction: enumValue(value.direction, enums.direction, `${label}.direction`), taint: enumValue(value.taint, enums.taint, `${label}.taint`) }; if (has(value, 'scope')) result.scope = text(value.scope, `${label}.scope`); return Object.freeze(result) as SemanticEndpointV2; }
function endpoints(input: unknown, label: string): readonly SemanticEndpointV2[] { const output = dense(input, label).map((item, index) => endpoint(item, `${label}[${index}]`)); const keys = output.map((item) => canonicalizeJson(item)); if (new Set(keys).size !== keys.length) return fail('DUPLICATE_RECORD', label); return Object.freeze(output.sort((a, b) => compare(canonicalizeJson(a), canonicalizeJson(b)))); }
function ports(input: unknown, label: string): readonly SemanticPortV2[] { const output = dense(input, label).map((item, index) => { const value = own(item, ['type', 'index', 'itemMode'], `${label}[${index}]`); required(value, ['type', 'index', 'itemMode'], `${label}[${index}]`); if (typeof value.index !== 'number' || !Number.isSafeInteger(value.index) || value.index < 0) return fail('INVALID_TEXT', `${label}[${index}].index`); return Object.freeze({ type: text(value.type, `${label}[${index}].type`, 256), index: value.index, itemMode: enumValue(value.itemMode, enums.itemMode, `${label}[${index}].itemMode`) }); }); const keys = output.map((item) => canonicalizeJson(item)); if (new Set(keys).size !== keys.length) return fail('DUPLICATE_RECORD', label); return Object.freeze(output.sort((a, b) => compare(canonicalizeJson(a), canonicalizeJson(b)))); }
function reviewedAt(input: unknown, label: string): string {
  const value = text(input, label, 24);
  const match = REVIEWED_AT.exec(value);
  if (!match) return fail('INVALID_PROVENANCE', label);
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (day > days) return fail('INVALID_PROVENANCE', label);
  return value;
}
function provenance(input: unknown, label: string): SemanticProvenanceV2 { const value = own(input, PROVENANCE, label); required(value, PROVENANCE, label); const sourceUrl = text(value.sourceUrl, `${label}.sourceUrl`, 2_048); try { const parsed = new URL(sourceUrl); if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) return fail('INVALID_PROVENANCE', `${label}.sourceUrl`); } catch { return fail('INVALID_PROVENANCE', `${label}.sourceUrl`); } const sourceDigest = text(value.sourceDigest, `${label}.sourceDigest`, 64); if (!DIGEST.test(sourceDigest)) return fail('INVALID_PROVENANCE', `${label}.sourceDigest`); return Object.freeze({ sourceUrl, sourceDigest, reviewedAt: reviewedAt(value.reviewedAt, `${label}.reviewedAt`), reviewer: text(value.reviewer, `${label}.reviewer`) }); }
function nodeType(input: unknown, label: string): string { const value = text(input, label, 512); if (value !== '*' && !/^@?[A-Za-z0-9][A-Za-z0-9._/@-]*\.[A-Za-z0-9_$-]+$/.test(value)) return fail('INVALID_TEXT', label); return value; }
function record(input: unknown, label: string): ResolvedNodeSemanticsV2 { const value = own(input, RECORD, label); required(value, RECORD, label); const operation = value.operation === null ? null : text(value.operation, `${label}.operation`, 256); const range = (() => { try { return validateVersionRange(value.versionRange); } catch { return fail('INVALID_RANGE', `${label}.versionRange`); } })(); const result: Dict = { semanticId: text(value.semanticId, `${label}.semanticId`, 512), nodeType: nodeType(value.nodeType, `${label}.nodeType`), versionRange: range, operation, entry: enumValue(value.entry, enums.entry, `${label}.entry`), parameterPaths: paths(value.parameterPaths, `${label}.parameterPaths`), authentication: authentication(value.authentication, `${label}.authentication`), credentialPaths: stringList(value.credentialPaths, `${label}.credentialPaths`, true), destinationPaths: stringList(value.destinationPaths, `${label}.destinationPaths`, true), effects: sortedUnique(dense(value.effects, `${label}.effects`).map((item, index) => enumValue(item, enums.effect, `${label}.effects[${index}]`)), `${label}.effects`) as readonly SemanticEffectV2[], endpoints: endpoints(value.endpoints, `${label}.endpoints`), ports: ports(value.ports, `${label}.ports`), overwritePaths: stringList(value.overwritePaths, `${label}.overwritePaths`, true), errorMode: enumValue(value.errorMode, enums.errorMode, `${label}.errorMode`), retryMode: enumValue(value.retryMode, enums.retryMode, `${label}.retryMode`), disabledMode: enumValue(value.disabledMode, enums.disabledMode, `${label}.disabledMode`), provenance: provenance(value.provenance, `${label}.provenance`) }; return Object.freeze(result) as ResolvedNodeSemanticsV2; }
function freeze<T>(value: T, seen = new WeakSet<object>()): T { if (value !== null && typeof value === 'object') { if (seen.has(value)) return value; seen.add(value); for (const name of Object.getOwnPropertyNames(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, name); if (descriptor && 'value' in descriptor) freeze(descriptor.value, seen); } Object.freeze(value); } return value; }
function preflight(input: unknown, seen = new Set<object>(), depth = 0): void {
  if (input === null || typeof input !== 'object') return;
  if (depth > 256 || seen.has(input)) return fail('UNSAFE_INPUT');
  seen.add(input);
  try {
    const proto = Object.getPrototypeOf(input); if (Array.isArray(input) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return fail('UNSAFE_INPUT');
    const names = Object.getOwnPropertyNames(input); if (names.length > MAX_ITEMS || Object.getOwnPropertySymbols(input).length !== 0) return fail('UNSAFE_INPUT');
    if (Array.isArray(input)) {
      const length = Object.getOwnPropertyDescriptor(input, 'length');
      if (!length || !('value' in length) || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_ITEMS || names.length !== length.value + 1) return fail('UNSAFE_INPUT');
      for (const name of names) if (name !== 'length' && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= length.value)) return fail('UNSAFE_INPUT');
    }
    for (const name of names) { if (name === 'length' && Array.isArray(input)) continue; const descriptor = Object.getOwnPropertyDescriptor(input, name); if (!descriptor || !('value' in descriptor)) return fail('UNSAFE_INPUT'); preflight(descriptor.value, seen, depth + 1); }
  } catch (error) { if (error instanceof SemanticCatalogueAdmissionError) throw error; return fail('UNSAFE_INPUT'); } finally { seen.delete(input); }
}
function body(input: unknown): SemanticCatalogueBodyV2 {
  const value = own(input, TOP, 'catalogue'); required(value, TOP.slice(0, -1), 'catalogue');
  if (value.schemaVersion !== 'scanner-semantics-v2') return fail('INVALID_SCHEMA_VERSION');
  const version = text(value.version, 'catalogue.version', 128);
  try { parseStrictSemver(version); } catch { return fail('INVALID_VERSION', 'catalogue.version'); }
  const records = dense(value.records, 'catalogue.records').map((item, index) => record(item, `catalogue.records[${index}]`));
  const ids = new Set<string>(); const recordsByKey = new Map<string, ResolvedNodeSemanticsV2>(); const recordsByScope = new Map<string, ResolvedNodeSemanticsV2[]>();
  for (const item of records) {
    if (ids.has(item.semanticId)) return fail('DUPLICATE_ID', item.semanticId); ids.add(item.semanticId);
    const scope = `${item.nodeType}\0${item.operation ?? ''}`;
    const key = `${scope}\0${canonicalizeJson(item.versionRange)}`;
    const prior = recordsByKey.get(key);
    if (prior !== undefined) return fail(canonicalizeJson(prior) === canonicalizeJson(item) ? 'DUPLICATE_RECORD' : 'SEMANTIC_CATALOGUE_AMBIGUOUS', item.semanticId);
    const scoped = recordsByScope.get(scope) ?? [];
    for (const candidate of scoped) {
      if (overlap(candidate.versionRange, item.versionRange) && !subset(candidate.versionRange, item.versionRange) && !subset(item.versionRange, candidate.versionRange)) {
        return fail('SEMANTIC_CATALOGUE_AMBIGUOUS', item.semanticId);
      }
    }
    recordsByKey.set(key, item); scoped.push(item); recordsByScope.set(scope, scoped);
  }
  records.sort((a, b) => compare(canonicalizeJson(a), canonicalizeJson(b)));
  return Object.freeze({ schemaVersion: 'scanner-semantics-v2', id: text(value.id, 'catalogue.id', 512), version, records: Object.freeze(records), configurationKeys: sortedUnique(dense(value.configurationKeys, 'configurationKeys').map((item, index) => text(item, `configurationKeys[${index}]`)), 'configurationKeys') });
}
export function createSemanticCatalogueDigest(value: SemanticCatalogueBodyV2): string { return bytesToHex(sha256(canonicalJsonBytes(body(value)))); }
export const createCatalogueDigest = createSemanticCatalogueDigest;
export function admitSemanticCatalogue(input: unknown): SemanticCatalogueV2 { try { preflight(input); const normalized = body(input); const value = own(input, TOP, 'catalogue'); const digest = text(value.digest, 'catalogue.digest', 64); if (!DIGEST.test(digest)) return fail('DIGEST_MISMATCH', 'catalogue.digest'); const expected = createSemanticCatalogueDigest(normalized); if (digest !== expected) return fail('DIGEST_MISMATCH'); return freeze({ ...normalized, digest }) as SemanticCatalogueV2; } catch (error) { if (error instanceof SemanticCatalogueAdmissionError) throw error; return fail('UNSAFE_INPUT'); } }

export function versionRangesOverlap(left: VersionRangeV2, right: VersionRangeV2): boolean { return overlap(left, right); }
export function assertPlainData(input: unknown): void { preflight(input); }
