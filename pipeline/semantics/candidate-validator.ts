import type { Extraction, MetadataCandidate } from './metadata-extractor.js';
import { sourceReceiptDigest, type SourceReceipt } from './source-receipt.js';
import {
  CANDIDATE_FIELDS,
  DIAGNOSTIC_PATTERN,
  EXTRACTION_FIELDS,
  MAX_DIAGNOSTICS,
  MAX_NODE_TYPE_LENGTH,
  MAX_PARAMETERS,
  MAX_PARAMETER_LENGTH,
  REJECTION_FIELDS,
  VERSION_PATTERN,
  closed,
  compareVersions,
  fail,
  isNfc,
  isText,
  readItem,
  type CandidateReason,
  type Failure,
} from './candidate-validation-fields.js';

export type { CandidateReason } from './candidate-validation-fields.js';

export type CandidateValidation =
  | Readonly<{ ok: true; candidate: MetadataCandidate }>
  | Readonly<{ ok: false; reason: CandidateReason; path?: string; field?: string }>;

export type ExtractionValidation =
  | Readonly<{ ok: true; extraction: Extraction }>
  | Readonly<{ ok: false; reason: CandidateReason; path?: string; field?: string }>;

/**
 * Validates one extracted candidate against the receipt it claims to come
 * from. Data errors are returned, never thrown: roots, candidate members, and
 * array items are read through property descriptors so no getter runs.
 */
export function validateMetadataCandidate(input: unknown, receipt: SourceReceipt): CandidateValidation {
  try {
    return validateCandidate(input, receipt);
  } catch {
    return fail('INVALID_ROOT');
  }
}

/** Validates a whole extraction without mutating or re-sorting accepted input. */
export function validateExtraction(input: unknown, receipt: SourceReceipt): ExtractionValidation {
  try {
    return inspectExtraction(input, receipt);
  } catch {
    return fail('INVALID_ROOT');
  }
}

function validateCandidate(input: unknown, receipt: SourceReceipt): CandidateValidation {
  const root = closed(input, CANDIDATE_FIELDS);
  if (!root.ok) return root;
  const values = root.values;

  if (values.schemaVersion !== '1') return fail('INVALID_SCHEMA_VERSION', 'schemaVersion');
  if (values.receiptDigest !== sourceReceiptDigest(receipt)) {
    return fail('RECEIPT_DIGEST_MISMATCH', 'receiptDigest');
  }
  const receiptPaths = new Set(receipt.files.map((file) => file.path));
  if (typeof values.sourcePath !== 'string' || !receiptPaths.has(values.sourcePath)) {
    return fail('UNKNOWN_SOURCE_PATH', 'sourcePath');
  }
  const nodeType = values.nodeType;
  if (!isText(nodeType, MAX_NODE_TYPE_LENGTH)) return fail('INVALID_NODE_TYPE', 'nodeType');
  if (!isNfc(nodeType)) return fail('NON_CANONICAL_UNICODE', 'nodeType');

  const versionFailure = checkVersions(values.versions);
  if (versionFailure !== null) return versionFailure;
  const parameterFailure = checkParameters(values.parameters);
  if (parameterFailure !== null) return parameterFailure;
  const diagnosticFailure = checkDiagnostics(values.diagnostics);
  if (diagnosticFailure !== null) return diagnosticFailure;

  return { ok: true, candidate: input as MetadataCandidate };
}

function inspectExtraction(input: unknown, receipt: SourceReceipt): ExtractionValidation {
  const root = closed(input, EXTRACTION_FIELDS);
  if (!root.ok) return root;
  const { candidates, rejected } = root.values;
  if (!Array.isArray(candidates)) return fail('INVALID_ROOT', 'candidates');
  if (!Array.isArray(rejected)) return fail('INVALID_ROOT', 'rejected');

  let previousCandidate: string | null = null;
  const identities = new Set<string>();
  const acceptedPaths: string[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const item = readItem(candidates, index);
    if (!item.ok) return fail('INVALID_ROOT', 'candidates');
    const validation = validateMetadataCandidate(item.value, receipt);
    if (!validation.ok) return validation;
    const { sourcePath, nodeType } = validation.candidate;
    const key = `${sourcePath}\u0000${nodeType}`;
    if (identities.has(key)) return fail('DUPLICATE_CANDIDATE', 'nodeType', sourcePath);
    identities.add(key);
    if (previousCandidate !== null && key < previousCandidate) {
      return fail('UNSORTED_CANDIDATES', 'sourcePath', sourcePath);
    }
    previousCandidate = key;
    acceptedPaths.push(sourcePath);
  }

  const receiptPaths = new Set(receipt.files.map((file) => file.path));
  const rejectedPaths = new Set<string>();
  let previousRejection: string | null = null;
  for (let index = 0; index < rejected.length; index += 1) {
    const item = readItem(rejected, index);
    if (!item.ok) return fail('INVALID_REJECTION');
    const entry = closed(item.value, REJECTION_FIELDS);
    if (!entry.ok) return fail('INVALID_REJECTION');
    const { path, reason } = entry.values;
    if (typeof path !== 'string' || !receiptPaths.has(path)) {
      return fail('UNKNOWN_REJECTED_PATH', undefined, typeof path === 'string' ? path : undefined);
    }
    if (typeof reason !== 'string' || !DIAGNOSTIC_PATTERN.test(reason)) {
      return fail('INVALID_REJECTION', 'reason', path);
    }
    const key = `${path}\u0000${reason}`;
    if (rejectedPaths.has(path)) return fail('DUPLICATE_REJECTION', undefined, path);
    rejectedPaths.add(path);
    if (previousRejection !== null && key < previousRejection) {
      return fail('INVALID_REJECTION', 'reason', path);
    }
    previousRejection = key;
  }

  for (const path of acceptedPaths) {
    if (rejectedPaths.has(path)) return fail('OVERLAPPING_RESULT', undefined, path);
  }

  const accepted = new Set(acceptedPaths);
  for (const path of receiptPaths) {
    if (!accepted.has(path) && !rejectedPaths.has(path)) {
      return fail('INVALID_ROOT', undefined, path);
    }
  }
  return { ok: true, extraction: input as Extraction };
}

function checkVersions(value: unknown): Failure | null {
  if (!Array.isArray(value) || value.length === 0) return fail('INVALID_VERSION', 'versions');
  const versions: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = readItem(value, index);
    if (!item.ok || typeof item.value !== 'string' || !VERSION_PATTERN.test(item.value)) {
      return fail('INVALID_VERSION', 'versions');
    }
    versions.push(item.value);
  }
  const seen = new Set<string>();
  let previous: readonly number[] | null = null;
  for (const version of versions) {
    if (seen.has(version)) return fail('DUPLICATE_VERSION', 'versions');
    seen.add(version);
    const parts = version.split('.').map(Number);
    if (previous !== null && compareVersions(parts, previous) < 0) {
      return fail('UNSORTED_VERSIONS', 'versions');
    }
    previous = parts;
  }
  return null;
}

function checkParameters(value: unknown): Failure | null {
  if (!Array.isArray(value)) return fail('INVALID_PARAMETER', 'parameters');
  if (value.length > MAX_PARAMETERS) return fail('TOO_MANY_PARAMETERS', 'parameters');
  let previous: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const item = readItem(value, index);
    if (!item.ok || !isText(item.value, MAX_PARAMETER_LENGTH)) {
      return fail('INVALID_PARAMETER', 'parameters');
    }
    if (!isNfc(item.value)) return fail('NON_CANONICAL_UNICODE', 'parameters');
    if (previous !== null) {
      if (item.value === previous) return fail('INVALID_PARAMETER', 'parameters');
      if (item.value < previous) return fail('UNSORTED_PARAMETERS', 'parameters');
    }
    previous = item.value;
  }
  return null;
}

function checkDiagnostics(value: unknown): Failure | null {
  if (!Array.isArray(value) || value.length > MAX_DIAGNOSTICS) {
    return fail('INVALID_DIAGNOSTIC', 'diagnostics');
  }
  let previous: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const item = readItem(value, index);
    if (!item.ok || typeof item.value !== 'string' || !DIAGNOSTIC_PATTERN.test(item.value)) {
      return fail('INVALID_DIAGNOSTIC', 'diagnostics');
    }
    if (previous !== null && item.value <= previous) return fail('INVALID_DIAGNOSTIC', 'diagnostics');
    previous = item.value;
  }
  return null;
}
