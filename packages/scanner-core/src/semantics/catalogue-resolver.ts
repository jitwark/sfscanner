import { matchesVersionRange, type VersionRangeV2 } from './version-range';
import { parseStrictSemver, type StrictSemver } from './semver';
import { SemanticCatalogueAdmissionError } from './catalogue-admission';
import type { ResolvedNodeSemanticsV2, SemanticCatalogueV2, SemanticResolutionQueryV2 } from './catalogue-schema';

type Dict = Record<string, unknown>;
const NODE = /^(?:\*|@?[A-Za-z0-9][A-Za-z0-9._/@-]*\.[A-Za-z0-9_$-]+)$/;
const MAX_ITEMS = 100_000;
const CATALOGUE = ['schemaVersion', 'id', 'version', 'records', 'configurationKeys', 'digest'] as const;
function fail(code: 'UNSAFE_INPUT' | 'UNKNOWN_KEY' | 'INVALID_TEXT' | 'INVALID_VERSION' | 'DUPLICATE_RECORD' | 'SEMANTIC_CATALOGUE_AMBIGUOUS', label?: string): never { throw new SemanticCatalogueAdmissionError(code, label); }
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
function text(input: unknown, label: string, maximum = 4_096): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > maximum || input !== input.normalize('NFC')) return fail('INVALID_TEXT', label);
  for (let index = 0; index < input.length; index += 1) { const code = input.charCodeAt(index); if (code <= 0x1f || code >= 0x7f && code <= 0x9f) return fail('INVALID_TEXT', label); if (code >= 0xd800 && code <= 0xdbff) { const next = input.charCodeAt(index + 1); if (!(next >= 0xdc00 && next <= 0xdfff)) return fail('INVALID_TEXT', label); index += 1; } else if (code >= 0xdc00 && code <= 0xdfff) return fail('INVALID_TEXT', label); }
  if (new TextEncoder().encode(input).length > maximum) return fail('INVALID_TEXT', label);
  return input;
}
function nodeType(input: unknown, label: string): string { const value = text(input, label, 512); if (!NODE.test(value)) return fail('INVALID_TEXT', label); return value; }
/**
 * The catalogue's own node-type rule, shared with per-node callers that must fail closed without a
 * catalogue lookup (an absent `typeVersion` skips `resolveNodeSemantics` but not this validation).
 * Throws `SemanticCatalogueAdmissionError('INVALID_TEXT', 'query.nodeType')` for an empty, oversized
 * or non-conforming type.
 */
export function validateSemanticNodeType(input: unknown): string { return nodeType(input, 'query.nodeType'); }
function dense(input: unknown, label: string): unknown[] {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return fail('UNSAFE_INPUT', label);
    const length = Object.getOwnPropertyDescriptor(input, 'length'); if (!length || !('value' in length) || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_ITEMS) return fail('UNSAFE_INPUT', label);
    const names = Object.getOwnPropertyNames(input); if (names.length !== length.value + 1 || Object.getOwnPropertySymbols(input).length !== 0) return fail('UNSAFE_INPUT', label);
    const output: unknown[] = []; for (let index = 0; index < length.value; index += 1) { if (!names.includes(String(index))) return fail('UNSAFE_INPUT', `${label}[${index}]`); const descriptor = Object.getOwnPropertyDescriptor(input, String(index)); if (!descriptor || !('value' in descriptor)) return fail('UNSAFE_INPUT', `${label}[${index}]`); output.push(descriptor.value); } return output;
  } catch (error) { if (error instanceof SemanticCatalogueAdmissionError) throw error; return fail('UNSAFE_INPUT', label); }
}
function catalogueRecords(input: unknown): readonly ResolvedNodeSemanticsV2[] {
  try {
    const value = own(input, CATALOGUE, 'catalogue');
    const records = dense(value.records, 'catalogue.records');
    for (let index = 0; index < records.length; index += 1) {
      const item = records[index];
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return fail('UNSAFE_INPUT', `catalogue.records[${index}]`);
      const prototype = Object.getPrototypeOf(item);
      if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(item).length !== 0) return fail('UNSAFE_INPUT', `catalogue.records[${index}]`);
      for (const name of Object.getOwnPropertyNames(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, name);
        if (!descriptor || !('value' in descriptor)) return fail('UNSAFE_INPUT', `catalogue.records[${index}].${name}`);
      }
    }
    return records as ResolvedNodeSemanticsV2[];
  } catch (error) {
    if (error instanceof SemanticCatalogueAdmissionError) throw error;
    return fail('UNSAFE_INPUT', 'catalogue');
  }
}

function queryValue(input: unknown): { nodeType: string; version: StrictSemver; operation: string | null; aliases: readonly string[] } {
  const value = own(input, ['nodeType', 'version', 'operation', 'aliases'], 'query'); if (!Object.prototype.hasOwnProperty.call(value, 'nodeType') || !Object.prototype.hasOwnProperty.call(value, 'version')) return fail('UNSAFE_INPUT', 'query');
  const node = nodeType(value.nodeType, 'query.nodeType'); let version: StrictSemver; try { version = parseStrictSemver(value.version); } catch { return fail('INVALID_VERSION', 'query.version'); }
  const operation = Object.prototype.hasOwnProperty.call(value, 'operation') ? value.operation === null ? null : text(value.operation, 'query.operation', 256) : null;
  const aliases = Object.prototype.hasOwnProperty.call(value, 'aliases') ? dense(value.aliases, 'query.aliases').map((item, index) => nodeType(item, `query.aliases[${index}]`)) : [];
  if (new Set(aliases).size !== aliases.length) return fail('DUPLICATE_RECORD', 'query.aliases');
  return { nodeType: node, version, operation, aliases: Object.freeze([...aliases].sort()) };
}
function versionText(value: StrictSemver): string {
  const base = `${value.major}.${value.minor}.${value.patch}`;
  const prerelease = value.prerelease.length ? `-${value.prerelease.join('.')}` : '';
  const build = value.build.length ? `+${value.build.join('.')}` : '';
  return `${base}${prerelease}${build}`;
}
function addPrereleaseSamples(samples: Set<string>, value: StrictSemver): void {
  if (value.prerelease.length === 0) return;
  const base = `${value.major}.${value.minor}.${value.patch}`; const ids = [...value.prerelease];
  samples.add(versionText(value));
  for (let index = 0; index < ids.length; index += 1) {
    const item = ids[index];
    if (/^\d+$/.test(item)) {
      const number = Number(item);
      if (Number.isSafeInteger(number)) {
        if (number > 0) samples.add(`${base}-${ids.slice(0, index).concat(String(number - 1)).join('.')}`);
        if (number < Number.MAX_SAFE_INTEGER) samples.add(`${base}-${ids.slice(0, index).concat(String(number + 1)).join('.')}`);
      }
    } else for (const replacement of ['a', 'b', 'z']) samples.add(`${base}-${ids.slice(0, index).concat(replacement).join('.')}`);
    for (const suffix of ['0', '1', 'z']) samples.add(`${base}-${ids.slice(0, index + 1).concat(suffix).join('.')}`);
  }
}
function addSamples(samples: Set<string>, value: StrictSemver): void {
  const base = `${value.major}.${value.minor}.${value.patch}`;
  samples.add(versionText(value)); samples.add(base); samples.add(`${base}-0`); samples.add(`${base}-z`); addPrereleaseSamples(samples, value);
  if (value.patch < Number.MAX_SAFE_INTEGER) samples.add(`${value.major}.${value.minor}.${value.patch + 1}`);
  if (value.minor < Number.MAX_SAFE_INTEGER) samples.add(`${value.major}.${value.minor + 1}.0`);
  if (value.major < Number.MAX_SAFE_INTEGER) samples.add(`${value.major + 1}.0.0`);
  if (value.patch > 0) samples.add(`${value.major}.${value.minor}.${value.patch - 1}`);
  if (value.minor > 0) samples.add(`${value.major}.${value.minor - 1}.0`);
  if (value.major > 0) samples.add(`${value.major - 1}.0.0`);
}
function rangeSamples(left: VersionRangeV2, right: VersionRangeV2): readonly string[] {
  const samples = new Set(['0.0.0', '1.0.0', '2.0.0', '999999.0.0']);
  for (const range of [left, right]) for (const clause of range.clauses) for (const comparator of clause) addSamples(samples, parseStrictSemver(comparator.version));
  return [...samples];
}
function strictSubset(left: VersionRangeV2, right: VersionRangeV2): boolean {
  let rightOnly = false;
  for (const candidate of rangeSamples(left, right)) { let value: StrictSemver; try { value = parseStrictSemver(candidate); } catch { continue; } const leftMatch = matchesVersionRange(value, left); const rightMatch = matchesVersionRange(value, right); if (leftMatch && !rightMatch) return false; if (rightMatch && !leftMatch) rightOnly = true; }
  return rightOnly;
}
function best(candidates: readonly ResolvedNodeSemanticsV2[]): ResolvedNodeSemanticsV2 | null {
  if (candidates.length === 0) return null;
  const winners = candidates.filter((candidate, index) => candidates.every((other, otherIndex) => index === otherIndex || strictSubset(candidate.versionRange, other.versionRange)));
  if (winners.length !== 1) return fail('SEMANTIC_CATALOGUE_AMBIGUOUS');
  return winners[0];
}
export function resolveNodeSemantics(catalogue: SemanticCatalogueV2, input: SemanticResolutionQueryV2): ResolvedNodeSemanticsV2 | null {
  const query = queryValue(input); const records = catalogueRecords(catalogue);
  let candidates = records.filter((record) => record.nodeType === query.nodeType && matchesVersionRange(query.version, record.versionRange));
  if (candidates.length === 0) candidates = records.filter((record) => query.aliases.includes(record.nodeType) && matchesVersionRange(query.version, record.versionRange));
  if (candidates.length === 0) candidates = records.filter((record) => record.nodeType === '*' && matchesVersionRange(query.version, record.versionRange));
  if (query.operation !== null) { const exact = candidates.filter((record) => record.operation === query.operation); if (exact.length > 0) candidates = exact; else candidates = candidates.filter((record) => record.operation === null); } else candidates = candidates.filter((record) => record.operation === null);
  return best(candidates);
}
