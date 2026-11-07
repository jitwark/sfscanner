import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { parseStrictSemver } from '@hub/scanner-core/semantics/semver';
import type { AdvisoryRecordV2 } from '@hub/scanner-core/v2';
import { admitAdvisoryCatalogue, AdvisoryAdmissionError } from '@hub/scanner-core/v2';

export type SnapshotPinV1 = Readonly<{
  sourceId: string;
  url: string;
  sha256: string;
  schemaVersion: 'scanner-advisories-v2';
  capturedAt: string;
  maxAgeMs: number;
}>;

export type SnapshotValidationV1 =
  | Readonly<{ ok: true; snapshot: Readonly<{ sourceId: string; capturedAt: string; sha256: string; version: string; records: number; catalogueDigest: string }>; advisories?: readonly AdvisoryRecordV2[] }>
  | Readonly<{ ok: false; reason: SnapshotReasonV1 }>;

export type SnapshotReasonV1 = 'PIN_INVALID' | 'SIZE_EXCEEDED' | 'DIGEST_MISMATCH' | 'INVALID_UTF8' | 'INVALID_JSON'
  | 'DUPLICATE_KEY' | 'SCHEMA_INVALID' | 'SOURCE_MISMATCH' | 'CAPTURE_MISMATCH' | 'SNAPSHOT_STALE' | 'SNAPSHOT_FUTURE' | 'RECORD_LIMIT' | 'DUPLICATE_ADVISORY' | 'RECORD_INVALID';

export const SNAPSHOT_REASONS_V1: readonly SnapshotReasonV1[] = Object.freeze([
  'PIN_INVALID', 'SIZE_EXCEEDED', 'DIGEST_MISMATCH', 'INVALID_UTF8', 'INVALID_JSON', 'DUPLICATE_KEY', 'SCHEMA_INVALID',
  'SOURCE_MISMATCH', 'CAPTURE_MISMATCH', 'SNAPSHOT_STALE', 'SNAPSHOT_FUTURE', 'RECORD_LIMIT', 'DUPLICATE_ADVISORY', 'RECORD_INVALID',
] as const);

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_RECORDS = 25_000;
const DIGEST = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SNAPSHOT_KEYS = ['schemaVersion', 'version', 'records', 'digest', 'sourceId', 'capturedAt'] as const;

const fail = (reason: SnapshotReasonV1): SnapshotValidationV1 => Object.freeze({ ok: false, reason });

function plain(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== keys.length || keys.some((key) => !names.includes(key)) || Object.getOwnPropertySymbols(value).length !== 0) return undefined;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch { return undefined; }
}

function dense(value: unknown): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (length === undefined || !('value' in length) || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0) return undefined;
    if (Object.getOwnPropertyNames(value).length !== length.value + 1 || Object.getOwnPropertySymbols(value).length !== 0) return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) return undefined;
      output.push(descriptor.value);
    }
    return output;
  } catch { return undefined; }
}

function text(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || (value.length !== 20 && value.length !== 24) || !TIMESTAMP.test(value)) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  /** `Date.parse` normalizes impossible components (2026-02-30 → March 2), so require an exact calendar round-trip. */
  const canonical = new Date(parsed).toISOString();
  return canonical === (value.length === 20 ? `${value.slice(0, 19)}.000Z` : value) ? parsed : undefined;
}

/** Rejects duplicate object keys that `JSON.parse` would silently collapse. */
function hasDuplicateObjectKeys(text: string): boolean {
  let index = 0;
  const skip = (): void => { while (index < text.length && /\s/u.test(text[index]!)) index += 1; };
  const readString = (): string | undefined => {
    if (text[index] !== '"') return undefined;
    const start = index; index += 1;
    while (index < text.length) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index] === '"') {
        index += 1;
        try { return JSON.parse(text.slice(start, index)) as string; } catch { return undefined; }
      }
      if (text.charCodeAt(index) < 0x20) return undefined;
      index += 1;
    }
    return undefined;
  };
  const readValue = (): boolean => {
    skip();
    if (text[index] === '{') {
      index += 1; skip();
      if (text[index] === '}') { index += 1; return false; }
      const keys = new Set<string>();
      for (;;) {
        skip();
        const key = readString();
        if (key === undefined) return false;
        if (keys.has(key)) return true;
        keys.add(key); skip();
        if (text[index] !== ':') return false;
        index += 1;
        if (readValue()) return true;
        skip();
        if (text[index] === '}') { index += 1; return false; }
        if (text[index] !== ',') return false;
        index += 1;
      }
    }
    if (text[index] === '[') {
      index += 1; skip();
      if (text[index] === ']') { index += 1; return false; }
      for (;;) {
        if (readValue()) return true;
        skip();
        if (text[index] === ']') { index += 1; return false; }
        if (text[index] !== ',') return false;
        index += 1;
      }
    }
    if (text[index] === '"') { readString(); return false; }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(index));
    if (match === null) return false;
    index += match[0].length;
    return false;
  };
  const duplicate = readValue();
  skip();
  return duplicate && index <= text.length;
}

export function isValidStrictSemver(value: unknown): boolean {
  try { parseStrictSemver(value); return true; } catch { return false; }
}
/** Structural pin check only; this helper cannot confer release authority. */
export function snapshotPinReason(pin: SnapshotPinV1): SnapshotReasonV1 | undefined {
  try { return checkedPinReason(pin); } catch { return 'PIN_INVALID'; }
}
function checkedPinReason(pin: SnapshotPinV1): SnapshotReasonV1 | undefined {
  const checked = plain(pin, ['sourceId', 'url', 'sha256', 'schemaVersion', 'capturedAt', 'maxAgeMs']);
  if (checked === undefined) return 'PIN_INVALID';
  pin = checked as SnapshotPinV1;
  if (pin.schemaVersion !== 'scanner-advisories-v2' || (typeof pin.sha256 !== 'string' || !DIGEST.test(pin.sha256)) || pin.sha256.length !== 64
    || !Number.isSafeInteger(pin.maxAgeMs) || pin.maxAgeMs < 1 || pin.maxAgeMs > 7 * 24 * 60 * 60 * 1_000
    || text(pin.sourceId, 64) === undefined || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(pin.sourceId) || timestamp(pin.capturedAt) === undefined
    || text(pin.url, 2_048) === undefined || !/^https:\/\/[^/?#@]+(?:\/[^?#]*)?$/u.test(pin.url)) return 'PIN_INVALID';
  const url = new URL(pin.url);
  if (url.hostname === 'localhost' || /^(?:\d+\.){3}\d+$/.test(url.hostname) || url.hostname.includes(':')
    || !url.hostname.includes('.') || /\.(?:localhost|local|internal)$/.test(url.hostname)) return 'PIN_INVALID';
  return undefined;
}

/**
 * Validates one immutable pinned advisory snapshot without network, environment, or wall-clock access.
 * Shape validity is not rights, provenance, semantic completeness, or a safety verdict.
 */
export function validateSupplyChainSnapshot(bytes: Uint8Array, pin: SnapshotPinV1, now: number): SnapshotValidationV1 {
  try { return validateSnapshot(bytes, pin, now); } catch { return fail('INVALID_JSON'); }
}
function validateSnapshot(bytes: Uint8Array, pin: SnapshotPinV1, now: number): SnapshotValidationV1 {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return fail('SIZE_EXCEEDED');
  if (!Number.isFinite(now) || snapshotPinReason(pin) !== undefined) return fail('PIN_INVALID');
  const digest = bytesToHex(sha256(bytes));
  if (digest !== pin.sha256) return fail('DIGEST_MISMATCH');
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('INVALID_UTF8'); }
  if (hasDuplicateObjectKeys(source)) return fail('DUPLICATE_KEY');
  let raw: unknown;
  try { raw = JSON.parse(source) as unknown; } catch { return fail('INVALID_JSON'); }
  const snapshot = plain(raw, SNAPSHOT_KEYS);
  if (snapshot === undefined || snapshot.schemaVersion !== pin.schemaVersion || text(snapshot.version, 128) === undefined) return fail('SCHEMA_INVALID');
  if (snapshot.sourceId !== pin.sourceId) return fail('SOURCE_MISMATCH');
  if (snapshot.capturedAt !== pin.capturedAt) return fail('CAPTURE_MISMATCH');
  const captured = timestamp(snapshot.capturedAt);
  if (captured === undefined) return fail('SCHEMA_INVALID');
  if (captured > now) return fail('SNAPSHOT_FUTURE');
  if (now - captured > pin.maxAgeMs) return fail('SNAPSHOT_STALE');
  const records = dense(snapshot.records);
  if (records === undefined) return fail('SCHEMA_INVALID');
  if (records.length > MAX_RECORDS) return fail('RECORD_LIMIT');
  try {
    const catalogue = admitAdvisoryCatalogue({ schemaVersion: snapshot.schemaVersion, version: snapshot.version, records, digest: snapshot.digest });
    return Object.freeze({ ok: true, snapshot: Object.freeze({
      sourceId: pin.sourceId, capturedAt: pin.capturedAt, sha256: digest, version: catalogue.version,
      records: catalogue.records.length, catalogueDigest: catalogue.digest,
    }), advisories: catalogue.records });
  } catch (error) {
    return fail(error instanceof AdvisoryAdmissionError && ['DUPLICATE_ID', 'DUPLICATE_ALIAS'].includes(error.code) ? 'DUPLICATE_ADVISORY' : 'RECORD_INVALID');
  }
}
