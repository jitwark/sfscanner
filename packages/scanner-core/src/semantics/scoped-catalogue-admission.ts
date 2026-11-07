import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJsonBytes, canonicalizeJson } from '../canonical-json';
import {
  admitSemanticCatalogue, assertPlainData, createSemanticCatalogueDigest, SemanticCatalogueAdmissionError,
  versionRangesOverlap, type SemanticCatalogueErrorCode,
} from './catalogue-admission';
import type { ResolvedNodeSemanticsV2, SemanticCatalogueV2 } from './catalogue-schema';
import type {
  ScopeDimensionV1, ScopeReceiptV1, ScopedCatalogueBodyV1, ScopedCatalogueBundleV1, ScopedRecordV1, SelectorScopeV1,
} from './scoped-catalogue-schema';

type Dict = Record<string, unknown>;

const TOP = ['schemaVersion', 'records', 'scopeReceipts', 'digest'] as const;
const SCOPED = ['record', 'resourceScope', 'operationScope'] as const;
const RECEIPT = ['semanticId', 'dimension', 'evidenceDigest'] as const;
const DIMENSIONS = ['RESOURCE', 'OPERATION'] as const;
const MAX_ITEMS = 100_000;
const MAX_SCOPE = 256;
const DIGEST = /^[0-9a-f]{64}$/;
const has = (value: Dict, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
function fail(code: SemanticCatalogueErrorCode, label?: string): never { throw new SemanticCatalogueAdmissionError(code, label); }
function compare(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1; }

/** Closed data-only view of one nested object; `assertPlainData` has already rejected accessors. */
function closed(input: unknown, allowed: readonly string[], label: string): Dict {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('UNSAFE_INPUT', label);
  const names = Object.getOwnPropertyNames(input);
  for (const name of names) if (!allowed.includes(name)) return fail('UNKNOWN_KEY', `${label}.${name}`);
  const output: Dict = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (descriptor === undefined || !('value' in descriptor)) return fail('UNSAFE_INPUT', `${label}.${name}`);
    output[name] = descriptor.value;
  }
  return output;
}

function required(value: Dict, keys: readonly string[], label: string): void {
  for (const key of keys) if (!has(value, key)) return fail('MISSING_KEY', `${label}.${key}`);
}

function list(input: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > MAX_ITEMS) return fail('UNSAFE_INPUT', label);
  const output: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined || !('value' in descriptor)) return fail('UNSAFE_INPUT', `${label}[${index}]`);
    output.push(descriptor.value);
  }
  return output;
}

function scopeValue(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_SCOPE || input !== input.normalize('NFC')) return fail('INVALID_TEXT', label);
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return fail('INVALID_TEXT', label);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return fail('INVALID_TEXT', label);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return fail('INVALID_TEXT', label);
  }
  return input;
}

function scope(input: unknown, label: string): SelectorScopeV1 {
  const value = closed(input, ['kind', 'value'], label);
  required(value, ['kind'], label);
  if (value.kind === 'EXACT') {
    required(value, ['value'], label);
    return Object.freeze({ kind: 'EXACT', value: scopeValue(value.value, `${label}.value`) });
  }
  if (value.kind !== 'ABSENT' && value.kind !== 'ANY_REVIEWED') return fail('INVALID_ENUM', `${label}.kind`);
  if (has(value, 'value')) return fail('UNKNOWN_KEY', `${label}.value`);
  return value.kind === 'ABSENT' ? Object.freeze({ kind: 'ABSENT' }) : Object.freeze({ kind: 'ANY_REVIEWED' });
}

/**
 * Each scoped record is validated by the frozen catalogue admission path as a
 * one-record synthetic catalogue, so the scoped bundle cannot accept a record
 * the plain catalogue refuses.
 */
function admittedRecord(raw: unknown, label: string): ResolvedNodeSemanticsV2 {
  const body = {
    schemaVersion: 'scanner-semantics-v2', id: 'scoped-record', version: '1.0.0',
    records: [raw], configurationKeys: [],
  } as unknown as Omit<SemanticCatalogueV2, 'digest'>;
  const [record] = admitSemanticCatalogue({ ...body, digest: createSemanticCatalogueDigest(body) }).records;
  if (record === undefined) return fail('MISSING_KEY', `${label}.record`);
  return record;
}

function scopedRecord(raw: unknown, index: number): ScopedRecordV1 {
  const label = `bundle.records[${index}]`;
  const value = closed(raw, SCOPED, label);
  required(value, SCOPED, label);
  const record = admittedRecord(value.record, label);
  const resourceScope = scope(value.resourceScope, `${label}.resourceScope`);
  const operationScope = scope(value.operationScope, `${label}.operationScope`);
  if (operationScope.kind === 'EXACT') {
    if (operationScope.value !== record.operation) return fail('INVALID_TEXT', `${label}.operationScope.value`);
  } else if (record.operation !== null) return fail('INVALID_TEXT', `${label}.operationScope`);
  return Object.freeze({ record, resourceScope, operationScope });
}

function receipt(raw: unknown, index: number): ScopeReceiptV1 {
  const label = `bundle.scopeReceipts[${index}]`;
  const value = closed(raw, RECEIPT, label);
  required(value, RECEIPT, label);
  if (typeof value.semanticId !== 'string' || value.semanticId.length === 0) return fail('INVALID_TEXT', `${label}.semanticId`);
  if (typeof value.dimension !== 'string' || !(DIMENSIONS as readonly string[]).includes(value.dimension)) return fail('INVALID_ENUM', `${label}.dimension`);
  if (typeof value.evidenceDigest !== 'string' || !DIGEST.test(value.evidenceDigest)) return fail('DIGEST_MISMATCH', `${label}.evidenceDigest`);
  return Object.freeze({ semanticId: value.semanticId, dimension: value.dimension as ScopeDimensionV1, evidenceDigest: value.evidenceDigest });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor !== undefined && 'value' in descriptor) deepFreeze(descriptor.value);
    }
  }
  return Object.freeze(value);
}

export function admitScopedCatalogue(input: unknown): ScopedCatalogueBundleV1 {
  try {
    assertPlainData(input);
    const top = closed(input, TOP, 'bundle');
    required(top, TOP, 'bundle');
    if (top.schemaVersion !== '1') return fail('INVALID_SCHEMA_VERSION');
    const records = list(top.records, 'bundle.records').map((item, index) => scopedRecord(item, index));
    const receipts = list(top.scopeReceipts, 'bundle.scopeReceipts').map((item, index) => receipt(item, index));
    const digest = top.digest;
    if (typeof digest !== 'string' || !DIGEST.test(digest)) return fail('DIGEST_MISMATCH', 'bundle.digest');
    const ids = new Set<string>();
    for (const { record } of records) {
      if (ids.has(record.semanticId)) return fail('DUPLICATE_ID', record.semanticId);
      ids.add(record.semanticId);
    }
    // ANY_REVIEWED is evidence-gated: exactly one receipt per reviewed dimension, no orphans.
    const reviewed = new Set<string>();
    for (const { record, resourceScope, operationScope } of records) {
      if (resourceScope.kind === 'ANY_REVIEWED') reviewed.add(`${record.semanticId}\u0000RESOURCE`);
      if (operationScope.kind === 'ANY_REVIEWED') reviewed.add(`${record.semanticId}\u0000OPERATION`);
    }
    const bound = new Set<string>();
    for (const item of receipts) {
      const label = `bundle.scopeReceipts.${item.semanticId}.${item.dimension}`;
      if (!ids.has(item.semanticId)) return fail('INVALID_TEXT', `bundle.scopeReceipts.${item.semanticId}`);
      const key = `${item.semanticId}\u0000${item.dimension}`;
      if (!reviewed.has(key)) return fail('UNKNOWN_KEY', label);
      if (bound.has(key)) return fail('DUPLICATE_RECORD', label);
      bound.add(key);
    }
    for (const key of reviewed) if (!bound.has(key)) return fail('MISSING_KEY', `bundle.scopeReceipts.${key.replace('\u0000', '.')}`);
    // Equal-rank intersection on both selector dimensions is ambiguous; differing specificity resolves.
    const ranked = new Map<string, ScopedRecordV1[]>();
    for (const item of records) {
      const key = `${item.record.nodeType}\u0000${canonicalizeJson(item.resourceScope)}\u0000${canonicalizeJson(item.operationScope)}`;
      const group = ranked.get(key) ?? [];
      for (const candidate of group) {
        if (versionRangesOverlap(candidate.record.versionRange, item.record.versionRange)) return fail('SEMANTIC_CATALOGUE_AMBIGUOUS', item.record.semanticId);
      }
      group.push(item);
      ranked.set(key, group);
    }
    const body: ScopedCatalogueBodyV1 = Object.freeze({
      schemaVersion: '1',
      records: Object.freeze([...records].sort((left, right) => compare(canonicalizeJson(left), canonicalizeJson(right)))),
      scopeReceipts: Object.freeze([...receipts].sort((left, right) => compare(left.semanticId, right.semanticId) || compare(left.dimension, right.dimension))),
    });
    const expected = bytesToHex(sha256(canonicalJsonBytes(body)));
    if (expected !== digest) return fail('DIGEST_MISMATCH');
    return deepFreeze({ ...body, digest });
  } catch (error) {
    if (error instanceof SemanticCatalogueAdmissionError) throw error;
    return fail('UNSAFE_INPUT');
  }
}
