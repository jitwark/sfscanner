import { describe, expect, it } from 'vitest';
import {
  sourceReceiptDigest,
  validateReceiptFiles,
  validateSourceReceipt,
  type SourceReceipt,
  type SourceReceiptValidation,
} from './source-receipt.js';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const ABCD_SHA256 = '88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589';
const FIXTURE_DIGEST = '04fd25c4593b60e53bb847253c64ce5c095d501575d17a120680f34eceb432b8';
const RECEIPT_FIELDS = ['packageName', 'packageVersion', 'artifactSha256', 'sourceCommit', 'licenseReceiptDigest', 'files'] as const;

const VALID: SourceReceipt = {
  packageName: 'n8n-nodes-base',
  packageVersion: '2.15.1',
  artifactSha256: 'a'.repeat(64),
  sourceCommit: 'b'.repeat(40),
  licenseReceiptDigest: 'c'.repeat(64),
  files: [
    { path: 'dist/a.js', sha256: ABC_SHA256 },
    { path: 'dist/b.js', sha256: ABCD_SHA256 },
  ],
};

const clone = (overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> =>
  ({ ...structuredClone(VALID), ...overrides });

const singleFile = (path: unknown): Record<string, unknown> =>
  clone({ files: [{ path, sha256: EMPTY_SHA256 }] });

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

// A JS caller can hand the validator values its declared type forbids.
const asFileMap = (entries: readonly (readonly [string, unknown])[]): ReadonlyMap<string, Uint8Array> =>
  new Map(entries) as unknown as ReadonlyMap<string, Uint8Array>;

function expectRejected(result: SourceReceiptValidation) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected rejection');
  return result;
}

describe('validateSourceReceipt', () => {
  it('accepts a valid receipt and produces a repeatable canonical digest', () => {
    const result = validateSourceReceipt(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt).toEqual(VALID);
    expect(Object.keys(result.receipt).sort()).toEqual([...RECEIPT_FIELDS].sort());
    expect(result.digest).toBe(FIXTURE_DIGEST);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceReceiptDigest(result.receipt)).toBe(result.digest);
    const again = validateSourceReceipt(VALID);
    expect(again.ok && again.digest).toBe(result.digest);
  });

  it('rejects malformed roots without throwing', () => {
    for (const root of [null, [], 'x', 42, [{ ...VALID }]]) {
      let result: SourceReceiptValidation | undefined;
      expect(() => { result = validateSourceReceipt(root); }).not.toThrow();
      expect(expectRejected(result!).reason).toBe('INVALID_ROOT');
    }
  });

  it('rejects each missing receipt field', () => {
    for (const field of RECEIPT_FIELDS) {
      const input = clone();
      delete input[field];
      const result = expectRejected(validateSourceReceipt(input));
      expect(result.reason).toBe('MISSING_FIELD');
      expect(result.field).toBe(field);
    }
  });

  it('rejects an extra receipt field', () => {
    const result = expectRejected(validateSourceReceipt(clone({ extra: true })));
    expect(result.reason).toBe('UNEXPECTED_FIELD');
    expect(result.field).toBe('extra');
  });

  it.each([
    ['packageName', ''],
    ['packageName', 'n'.repeat(215)],
    ['packageName', 'bad\u0000name'],
    ['packageName', 7],
    ['packageVersion', ''],
    ['packageVersion', 'v'.repeat(65)],
    ['packageVersion', 'bad\nversion'],
    ['artifactSha256', 'A'.repeat(64)],
    ['artifactSha256', 'a'.repeat(63)],
    ['artifactSha256', 'g'.repeat(64)],
    ['sourceCommit', 'B'.repeat(40)],
    ['sourceCommit', 'b'.repeat(39)],
    ['licenseReceiptDigest', 'C'.repeat(64)],
    ['licenseReceiptDigest', 'c'.repeat(63)],
  ] as const)('rejects invalid %s', (field, value) => {
    const result = expectRejected(validateSourceReceipt(clone({ [field]: value })));
    expect(result.reason).toBe('INVALID_FIELD');
    expect(result.field).toBe(field);
  });

  it('accepts package name and version at their length bounds', () => {
    const input = clone({ packageName: 'n'.repeat(214), packageVersion: 'v'.repeat(64) });
    expect(validateSourceReceipt(input).ok).toBe(true);
  });

  it.each([
    '../x',
    '/etc/passwd',
    'C:\\x',
    'C:/x',
    'dist\\x',
    'a//b',
    'a/./b',
    './x',
    'a/\u0000b',
    'a/',
  ])('rejects unsafe path %j', (path) => {
    const result = expectRejected(validateSourceReceipt(singleFile(path)));
    expect(result.reason).toBe('INVALID_PATH');
  });

  it('rejects duplicate paths', () => {
    const input = clone({
      files: [
        { path: 'a.js', sha256: EMPTY_SHA256 },
        { path: 'a.js', sha256: EMPTY_SHA256 },
      ],
    });
    const result = expectRejected(validateSourceReceipt(input));
    expect(result.reason).toBe('DUPLICATE_PATH');
    expect(result.path).toBe('a.js');
  });

  it('rejects unsorted paths', () => {
    const input = clone({
      files: [
        { path: 'b.js', sha256: EMPTY_SHA256 },
        { path: 'a.js', sha256: EMPTY_SHA256 },
      ],
    });
    const result = expectRejected(validateSourceReceipt(input));
    expect(result.reason).toBe('UNSORTED_PATHS');
    expect(result.path).toBe('a.js');
  });

  it('rejects too many files against maxFiles', () => {
    const input = clone({
      files: ['a.js', 'b.js', 'c.js'].map((path) => ({ path, sha256: EMPTY_SHA256 })),
    });
    const result = expectRejected(validateSourceReceipt(input, { maxFiles: 2 }));
    expect(result.reason).toBe('TOO_MANY_FILES');
  });

  it('rejects an empty file list', () => {
    const result = expectRejected(validateSourceReceipt(clone({ files: [] })));
    expect(result.reason).toBe('INVALID_FIELD');
    expect(result.field).toBe('files');
  });

  it('rejects malformed file entries', () => {
    const extra = expectRejected(validateSourceReceipt(clone({
      files: [{ path: 'a.js', sha256: EMPTY_SHA256, extra: true }],
    })));
    expect(extra.reason).toBe('UNEXPECTED_FIELD');
    const missing = expectRejected(validateSourceReceipt(clone({
      files: [{ path: 'a.js' }],
    })));
    expect(missing.reason).toBe('MISSING_FIELD');
    const badHash = expectRejected(validateSourceReceipt(clone({
      files: [{ path: 'a.js', sha256: 'A'.repeat(64) }],
    })));
    expect(badHash.reason).toBe('INVALID_FIELD');
    expect(badHash.path).toBe('a.js');
  });
});

describe('validateReceiptFiles', () => {
  const validFiles = new Map<string, Uint8Array>([
    ['dist/a.js', bytes('abc')],
    ['dist/b.js', bytes('abcd')],
  ]);

  it('accepts matching files and returns aggregate bytes', () => {
    expect(validateReceiptFiles(VALID, validFiles)).toEqual({ ok: true, aggregateBytes: 7 });
  });

  it('rejects a missing file', () => {
    const files = new Map(validFiles);
    files.delete('dist/b.js');
    expect(validateReceiptFiles(VALID, files)).toEqual({
      ok: false,
      reason: 'MISSING_FILE',
      path: 'dist/b.js',
    });
  });

  it('rejects an extra file', () => {
    const files = new Map(validFiles);
    files.set('dist/c.js', bytes(''));
    expect(validateReceiptFiles(VALID, files)).toEqual({
      ok: false,
      reason: 'UNEXPECTED_FILE',
      path: 'dist/c.js',
    });
  });

  it('rejects a hash mismatch', () => {
    const files = new Map(validFiles);
    files.set('dist/a.js', bytes('xyz'));
    expect(validateReceiptFiles(VALID, files)).toEqual({
      ok: false,
      reason: 'HASH_MISMATCH',
      path: 'dist/a.js',
    });
  });

  it('rejects a file over the per-file byte limit', () => {
    expect(validateReceiptFiles(VALID, validFiles, { maxFileBytes: 3 })).toEqual({
      ok: false,
      reason: 'FILE_TOO_LARGE',
      path: 'dist/b.js',
    });
  });

  it('rejects an aggregate over the aggregate byte limit', () => {
    expect(validateReceiptFiles(VALID, validFiles, { maxAggregateBytes: 5 })).toEqual({
      ok: false,
      reason: 'AGGREGATE_TOO_LARGE',
      path: 'dist/b.js',
    });
  });

  it('rejects a non-Uint8Array map value instead of trusting the type', () => {
    const files = asFileMap([
      ['dist/a.js', 'not-bytes'],
      ['dist/b.js', bytes('abcd')],
    ]);
    expect(validateReceiptFiles(VALID, files)).toEqual({
      ok: false,
      reason: 'INVALID_FILE_CONTENT',
      path: 'dist/a.js',
    });
  });

  it('rejects a null map value without throwing', () => {
    const files = asFileMap([
      ['dist/a.js', null],
      ['dist/b.js', bytes('abcd')],
    ]);
    expect(() => validateReceiptFiles(VALID, files)).not.toThrow();
    expect(validateReceiptFiles(VALID, files)).toEqual({
      ok: false,
      reason: 'INVALID_FILE_CONTENT',
      path: 'dist/a.js',
    });
  });

  it('accepts a Uint8Array control', () => {
    const files = asFileMap([
      ['dist/a.js', bytes('abc')],
      ['dist/b.js', bytes('abcd')],
    ]);
    expect(validateReceiptFiles(VALID, files)).toEqual({ ok: true, aggregateBytes: 7 });
  });
});
