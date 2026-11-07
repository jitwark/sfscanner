export type CandidateReason =
  | 'INVALID_ROOT' | 'INVALID_SCHEMA_VERSION' | 'RECEIPT_DIGEST_MISMATCH'
  | 'UNKNOWN_SOURCE_PATH' | 'INVALID_NODE_TYPE' | 'NON_CANONICAL_UNICODE'
  | 'INVALID_VERSION' | 'UNSORTED_VERSIONS' | 'DUPLICATE_VERSION'
  | 'INVALID_PARAMETER' | 'UNSORTED_PARAMETERS' | 'TOO_MANY_PARAMETERS'
  | 'INVALID_DIAGNOSTIC' | 'DUPLICATE_CANDIDATE' | 'UNSORTED_CANDIDATES'
  | 'INVALID_REJECTION' | 'UNKNOWN_REJECTED_PATH' | 'DUPLICATE_REJECTION'
  | 'OVERLAPPING_RESULT';

export type Failure = Readonly<{
  ok: false;
  reason: CandidateReason;
  path?: string;
  field?: string;
}>;
export type Resolved = Readonly<{ ok: true; values: Record<string, unknown> }>;
export type Item = Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>;

export const CANDIDATE_FIELDS = [
  'schemaVersion', 'receiptDigest', 'sourcePath', 'nodeType', 'versions', 'parameters', 'diagnostics',
] as const;
export const EXTRACTION_FIELDS = ['candidates', 'rejected'] as const;
export const REJECTION_FIELDS = ['path', 'reason'] as const;

export const MAX_NODE_TYPE_LENGTH = 200;
export const MAX_PARAMETER_LENGTH = 200;
export const MAX_PARAMETERS = 512;
export const MAX_DIAGNOSTICS = 16;
export const VERSION_PATTERN = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
export const DIAGNOSTIC_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/** Reads a closed plain object, rejecting unknown, missing, and accessor properties. */
export function closed(input: unknown, fields: readonly string[]): Resolved | Failure {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_ROOT');
  // Plain objects and `Object.create(null)` records only: a prototype can supply
  // `toJSON` or any other behaviour a receipt-shaped record must not carry.
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) return fail('INVALID_ROOT');
  for (const name of Object.getOwnPropertyNames(input)) {
    if (!fields.includes(name)) return fail('INVALID_ROOT', name);
  }
  const values: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if (descriptor === undefined || !('value' in descriptor)) return fail('INVALID_ROOT', field);
    values[field] = descriptor.value;
  }
  return { ok: true, values };
}

export function readItem(array: readonly unknown[], index: number): Item {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  if (descriptor === undefined || !('value' in descriptor)) return { ok: false };
  return { ok: true, value: descriptor.value };
}

export function isText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !CONTROL_PATTERN.test(value)
    && !hasLoneSurrogate(value);
}

/** True when a string holds an unpaired UTF-16 surrogate, which no UTF-8 receipt can encode. */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

export function isNfc(value: string): boolean {
  return value === value.normalize('NFC');
}

export function compareVersions(left: readonly number[], right: readonly number[]): number {
  return (left[0]! - right[0]!) || (left[1]! - right[1]!) || (left[2]! - right[2]!);
}

export function fail(reason: CandidateReason, field?: string, path?: string): Failure {
  return {
    ok: false,
    reason,
    ...(field === undefined ? {} : { field }),
    ...(path === undefined ? {} : { path }),
  };
}
