import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';

export type SourceReceiptFile = Readonly<{ path: string; sha256: string }>;

export type SourceReceipt = Readonly<{
  packageName: string;
  packageVersion: string;
  artifactSha256: string;
  sourceCommit: string;
  licenseReceiptDigest: string;
  files: readonly SourceReceiptFile[];
}>;

export type SourceReceiptReason =
  | 'INVALID_ROOT'
  | 'MISSING_FIELD'
  | 'UNEXPECTED_FIELD'
  | 'INVALID_FIELD'
  | 'INVALID_PATH'
  | 'TOO_MANY_FILES'
  | 'DUPLICATE_PATH'
  | 'UNSORTED_PATHS';

export type SourceReceiptValidation =
  | Readonly<{ ok: true; receipt: SourceReceipt; digest: string }>
  | Readonly<{ ok: false; reason: SourceReceiptReason; field?: string; path?: string }>;

export type ReceiptFileReason =
  | 'MISSING_FILE'
  | 'UNEXPECTED_FILE'
  | 'INVALID_FILE_CONTENT'
  | 'HASH_MISMATCH'
  | 'FILE_TOO_LARGE'
  | 'AGGREGATE_TOO_LARGE';

export type ReceiptFileValidation =
  | Readonly<{ ok: true; aggregateBytes: number }>
  | Readonly<{ ok: false; reason: ReceiptFileReason; path?: string }>;

const RECEIPT_FIELDS = [
  'packageName',
  'packageVersion',
  'artifactSha256',
  'sourceCommit',
  'licenseReceiptDigest',
  'files',
] as const;

const MAX_PACKAGE_NAME_LENGTH = 214;
const MAX_PACKAGE_VERSION_LENGTH = 64;
const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_AGGREGATE_BYTES = 64 * 1024 * 1024;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export function validateSourceReceipt(
  input: unknown,
  limits: { maxFiles?: number } = {},
): SourceReceiptValidation {
  if (!isPlainObject(input)) return { ok: false, reason: 'INVALID_ROOT' };

  const extra = Object.keys(input).find((key) => !(RECEIPT_FIELDS as readonly string[]).includes(key));
  if (extra !== undefined) return { ok: false, reason: 'UNEXPECTED_FIELD', field: extra };
  for (const field of RECEIPT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) {
      return { ok: false, reason: 'MISSING_FIELD', field };
    }
  }

  const { packageName, packageVersion, artifactSha256, sourceCommit, licenseReceiptDigest, files } = input;
  if (!isSafeText(packageName, MAX_PACKAGE_NAME_LENGTH)) return invalidField('packageName');
  if (!isSafeText(packageVersion, MAX_PACKAGE_VERSION_LENGTH)) return invalidField('packageVersion');
  if (!isHash(artifactSha256)) return invalidField('artifactSha256');
  if (typeof sourceCommit !== 'string' || !COMMIT_PATTERN.test(sourceCommit)) return invalidField('sourceCommit');
  if (!isHash(licenseReceiptDigest)) return invalidField('licenseReceiptDigest');
  if (!Array.isArray(files) || files.length === 0) return invalidField('files');
  if (files.length > (limits.maxFiles ?? DEFAULT_MAX_FILES)) {
    return { ok: false, reason: 'TOO_MANY_FILES', field: 'files' };
  }

  const normalizedFiles: SourceReceiptFile[] = [];
  for (const entry of files) {
    if (!isPlainObject(entry)) return invalidField('files');
    const entryKeys = Object.keys(entry);
    if (entryKeys.some((key) => key !== 'path' && key !== 'sha256')) {
      return {
        ok: false,
        reason: 'UNEXPECTED_FIELD',
        field: 'files',
        path: typeof entry.path === 'string' ? entry.path : undefined,
      };
    }
    if (!Object.prototype.hasOwnProperty.call(entry, 'path') || !Object.prototype.hasOwnProperty.call(entry, 'sha256')) {
      return {
        ok: false,
        reason: 'MISSING_FIELD',
        field: 'files',
        path: typeof entry.path === 'string' ? entry.path : undefined,
      };
    }
    if (!isSafeRelativePath(entry.path)) {
      return { ok: false, reason: 'INVALID_PATH', path: typeof entry.path === 'string' ? entry.path : undefined };
    }
    if (!isHash(entry.sha256)) return { ok: false, reason: 'INVALID_FIELD', field: 'files', path: entry.path };

    const previous = normalizedFiles.at(-1);
    if (previous !== undefined) {
      if (entry.path === previous.path) return { ok: false, reason: 'DUPLICATE_PATH', path: entry.path };
      if (entry.path < previous.path) return { ok: false, reason: 'UNSORTED_PATHS', path: entry.path };
    }
    normalizedFiles.push({ path: entry.path, sha256: entry.sha256 });
  }

  const receipt: SourceReceipt = {
    packageName,
    packageVersion,
    artifactSha256,
    sourceCommit,
    licenseReceiptDigest,
    files: normalizedFiles,
  };
  return { ok: true, receipt, digest: sourceReceiptDigest(receipt) };
}

export function sourceReceiptDigest(receipt: SourceReceipt): string {
  return createHash('sha256').update(canonicalizeJson(receipt), 'utf8').digest('hex');
}

export function validateReceiptFiles(
  receipt: SourceReceipt,
  files: ReadonlyMap<string, Uint8Array>,
  limits: { maxFileBytes?: number; maxAggregateBytes?: number } = {},
): ReceiptFileValidation {
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxAggregateBytes = limits.maxAggregateBytes ?? DEFAULT_MAX_AGGREGATE_BYTES;
  const expected = new Set(receipt.files.map((file) => file.path));

  for (const file of receipt.files) {
    if (!files.has(file.path)) return { ok: false, reason: 'MISSING_FILE', path: file.path };
  }
  for (const path of [...files.keys()].sort()) {
    if (!expected.has(path)) return { ok: false, reason: 'UNEXPECTED_FILE', path };
  }

  let aggregateBytes = 0;
  for (const file of receipt.files) {
    const content = files.get(file.path);
    if (content === undefined) return { ok: false, reason: 'MISSING_FILE', path: file.path };
    if (!(content instanceof Uint8Array)) return { ok: false, reason: 'INVALID_FILE_CONTENT', path: file.path };
    if (content.byteLength > maxFileBytes) return { ok: false, reason: 'FILE_TOO_LARGE', path: file.path };
    aggregateBytes += content.byteLength;
    if (aggregateBytes > maxAggregateBytes) {
      return { ok: false, reason: 'AGGREGATE_TOO_LARGE', path: file.path };
    }
    if (createHash('sha256').update(content).digest('hex') !== file.sha256) {
      return { ok: false, reason: 'HASH_MISMATCH', path: file.path };
    }
  }
  return { ok: true, aggregateBytes };
}

function invalidField(field: string): SourceReceiptValidation {
  return { ok: false, reason: 'INVALID_FIELD', field };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !CONTROL_PATTERN.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (CONTROL_PATTERN.test(value) || value.includes('\\') || value.startsWith('/') || value.includes('//')) {
    return false;
  }
  if (/^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
