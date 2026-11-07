import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * B1a — semantic source receipts: identity-only provenance for the pinned
 * upstream packages behind the built-in semantic catalogue records.
 *
 * The loader is pure shape validation over the committed JSON. The verifier
 * hashes bytes the caller injects from a real re-fetch, or records SKIPPED
 * when the caller has no bytes. No module code path performs network access.
 */
const RECEIPT_PATH = 'docs/scanner/semantic-source-receipts.json';
const SCHEMA_VERSION = 'semantic-source-receipts-v1';
const DIGEST = /^[0-9a-f]{64}$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

export class SemanticSourceReceiptError extends TypeError {
  constructor(reason, message) {
    super(`semantic-source-receipts(${reason}): ${message}`);
    this.name = 'SemanticSourceReceiptError';
    this.reason = reason;
  }
}

function fail(reason, message) {
  throw new SemanticSourceReceiptError(reason, message);
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_FIELD', `${label} must be an object`);
  return value;
}

function string(value, label, { allowEmpty = false } = {}) {
  if (value === undefined) fail('MISSING_FIELD', label);
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) fail('INVALID_FIELD', `${label} must be a non-empty string`);
  return value;
}

function digest(value, label) {
  if (value === undefined) fail('MISSING_FIELD', label);
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('INVALID_DIGEST', `${label} must be 64 lowercase hex characters`);
  return value;
}

function httpsUrl(value, label) {
  const text = string(value, label);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return fail('INVALID_URL', `${label} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.hostname === '') {
    fail('INVALID_URL', `${label} must be an https URL without credentials`);
  }
  return text;
}

function validateFile(value, label, seenPaths) {
  const file = object(value, label);
  const path = string(file.path, `${label}.path`);
  if (seenPaths.has(path)) fail('DUPLICATE_FILE', `${label}.path ${path} is duplicated in the package`);
  seenPaths.add(path);
  const bytes = file.bytes;
  if (bytes === undefined) fail('MISSING_FIELD', `${label}.bytes`);
  if (!Number.isSafeInteger(bytes) || bytes < 0) fail('INVALID_FIELD', `${label}.bytes must be a non-negative integer`);
  digest(file.sha256, `${label}.sha256`);
}

function validatePackage(value, label, seenPackages) {
  const entry = object(value, label);
  const packageName = string(entry.package, `${label}.package`);
  const version = string(entry.version, `${label}.version`);
  const key = `${packageName}@${version}`;
  if (seenPackages.has(key)) fail('DUPLICATE_PACKAGE', `${key} appears more than once`);
  seenPackages.add(key);
  httpsUrl(entry.registry, `${label}.registry`);
  httpsUrl(entry.tarballUrl, `${label}.tarballUrl`);
  digest(entry.tarballSha256, `${label}.tarballSha256`);
  const integrity = string(entry.distIntegrity, `${label}.distIntegrity`);
  if (!INTEGRITY.test(integrity)) fail('INVALID_DIGEST', `${label}.distIntegrity must be a sha512- base64 integrity string`);
  string(entry.fetchedAt, `${label}.fetchedAt`);
  if (entry.files === undefined) fail('MISSING_FIELD', `${label}.files`);
  if (!Array.isArray(entry.files)) fail('INVALID_FIELD', `${label}.files must be an array`);
  if (entry.files.length === 0) fail('EMPTY_FILE_LIST', `${label}.files must not be empty`);
  const seenPaths = new Set();
  entry.files.forEach((file, index) => validateFile(file, `${label}.files[${index}]`, seenPaths));
  return key;
}

function validateDocumentsRecords(value, indexSet) {
  const records = object(value, 'documentsRecords');
  for (const [semanticId, refs] of Object.entries(records)) {
    if (!Array.isArray(refs) || refs.length === 0) fail('INVALID_FIELD', `documentsRecords.${semanticId} must be a non-empty array`);
    for (const ref of refs) {
      string(ref, `documentsRecords.${semanticId}[]`);
      if (!indexSet.has(ref)) fail('UNKNOWN_FILE_REFERENCE', `documentsRecords.${semanticId} points at ${ref}, which is not in packages[].files`);
    }
  }
}

function validateDocument(document) {
  const receipt = object(document, 'receipt');
  if (receipt.schemaVersion === undefined) fail('MISSING_FIELD', 'schemaVersion');
  if (receipt.schemaVersion !== SCHEMA_VERSION) fail('INVALID_FIELD', `schemaVersion must be ${SCHEMA_VERSION}`);
  string(receipt.note, 'note');
  if (receipt.packages === undefined) fail('MISSING_FIELD', 'packages');
  if (!Array.isArray(receipt.packages)) fail('INVALID_FIELD', 'packages must be an array');
  const indexSet = new Set();
  const seenPackages = new Set();
  receipt.packages.forEach((entry, index) => {
    const key = validatePackage(entry, `packages[${index}]`, seenPackages);
    for (const file of entry.files) indexSet.add(`${key}:${file.path}`);
  });
  if (receipt.documentsRecords !== undefined) validateDocumentsRecords(receipt.documentsRecords, indexSet);
  return receipt;
}

export function loadSemanticSourceReceipts({ root = process.cwd(), path } = {}) {
  const file = path === undefined ? join(root, RECEIPT_PATH) : resolve(root, path);
  let document;
  try {
    document = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail('UNREADABLE_DOCUMENT', `${file} could not be read as JSON: ${error.message}`);
  }
  return validateDocument(document);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function verifySemanticSourceReceipts({ receipts, readPackageBytes }) {
  if (typeof readPackageBytes !== 'function') fail('INVALID_FIELD', 'readPackageBytes must be a function');
  const observations = [];
  const failures = [];
  for (const entry of receipts.packages) {
    const provided = readPackageBytes(entry.tarballUrl);
    for (const file of entry.files) {
      const common = { package: entry.package, version: entry.version, path: file.path, expectedSha256: file.sha256 };
      if (provided === undefined || provided === null) {
        observations.push({ ...common, receivedSha256: null, status: 'SKIPPED' });
        continue;
      }
      const bytes = provided[file.path];
      if (bytes === undefined) {
        const message = `${entry.package}@${entry.version}: ${file.path} is absent from the provided package bytes`;
        observations.push({ ...common, receivedSha256: null, status: 'MISSING' });
        failures.push({ ...common, receivedSha256: null, message });
        continue;
      }
      const receivedSha256 = sha256(bytes);
      if (receivedSha256 === file.sha256) {
        observations.push({ ...common, receivedSha256, status: 'MATCH' });
        continue;
      }
      const message = `${entry.package}@${entry.version}: ${file.path} expected ${file.sha256} but read ${receivedSha256}`;
      observations.push({ ...common, receivedSha256, status: 'MISMATCH' });
      failures.push({ ...common, receivedSha256, message });
    }
  }
  const ok = failures.length === 0 && observations.length > 0 && observations.every((observation) => observation.status === 'MATCH');
  return { ok, failures, observations };
}

/**
 * Record → supporting upstream files, resolved to their receipt digests.
 * `undocumentedRecords` is the coverage assertion: a record fails it when it
 * has no mapped files or when its `sourceDigest` matches none of them.
 */
export function documentedRecords(receipts) {
  const index = new Map();
  for (const entry of receipts.packages) {
    for (const file of entry.files) {
      index.set(`${entry.package}@${entry.version}:${file.path}`, {
        package: entry.package,
        version: entry.version,
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
      });
    }
  }
  const records = {};
  for (const [semanticId, refs] of Object.entries(receipts.documentsRecords ?? {})) {
    records[semanticId] = refs.map((ref) => {
      const resolved = index.get(ref);
      if (resolved === undefined) fail('UNKNOWN_FILE_REFERENCE', `${semanticId} points at ${ref}`);
      return resolved;
    });
  }
  return records;
}

export function undocumentedRecords(receipts, records) {
  const documented = documentedRecords(receipts);
  const undocumented = [];
  for (const record of records) {
    const refs = documented[record.semanticId] ?? [];
    if (refs.length === 0 || !refs.some((ref) => ref.sha256 === record.sourceDigest)) undocumented.push(record.semanticId);
  }
  return undocumented;
}
