import type { Entry } from '@hub/contracts';
import type { DownloadSpec } from './download';

export type DownloadVerificationErrorCode =
  | 'CONTENT_RANGE_MISSING'
  | 'CONTENT_RANGE_MISMATCH'
  | 'BODY_LENGTH_MISMATCH'
  | 'BODY_TOO_LARGE'
  | 'EMPTY_BODY'
  | 'MULTI_RECORD_BODY'
  | 'JSONL_NEWLINE_MISSING'
  | 'MALFORMED_JSON'
  | 'IDENTITY_MISMATCH'
  | 'CONTENT_HASH_MISMATCH';

/**
 * Thrown whenever a downloaded byte range cannot be proven to be the single,
 * complete, correctly-addressed record for the requested entry. Distinct from
 * a plain `Error` so a caller (or the UI) can tell "we caught a bad delivery"
 * apart from "the network failed" instead of rendering both as one opaque
 * "download failed".
 */
export class DownloadVerificationError extends Error {
  readonly code: DownloadVerificationErrorCode;
  constructor(code: DownloadVerificationErrorCode, message: string) {
    super(message);
    this.name = 'DownloadVerificationError';
    this.code = code;
  }
}

/**
 * Independent of the manifest-declared length: a hard ceiling so a
 * misbehaving cache or server can never make this module decode or
 * `JSON.parse` an unbounded body. The largest real workflow record in the
 * current corpus is ~115 KB; 4 MB leaves headroom without being "unbounded".
 */
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;

function expectedContentRange(spec: DownloadSpec): string {
  return `bytes ${spec.offset}-${spec.offset + spec.length - 1}/${spec.totalSize}`;
}

function verifyContentRange(header: string | null, spec: DownloadSpec): void {
  const expected = expectedContentRange(spec);
  if (!header) {
    throw new DownloadVerificationError('CONTENT_RANGE_MISSING', 'Partial response carried no Content-Range header.');
  }
  if (header !== expected) {
    throw new DownloadVerificationError(
      'CONTENT_RANGE_MISMATCH',
      `Content-Range "${header}" does not match the requested range "${expected}".`,
    );
  }
}

function verifyByteLength(byteLength: number, spec: DownloadSpec): void {
  if (byteLength > MAX_RECORD_BYTES) {
    throw new DownloadVerificationError(
      'BODY_TOO_LARGE',
      `Downloaded body is ${byteLength} bytes, over the ${MAX_RECORD_BYTES}-byte bound.`,
    );
  }
  if (byteLength !== spec.length) {
    throw new DownloadVerificationError(
      'BODY_LENGTH_MISMATCH',
      `Downloaded body is ${byteLength} bytes; expected exactly ${spec.length}.`,
    );
  }
}

/**
 * Require exactly one complete record: empty and multi-record bodies are
 * rejected here, before anything trusts the text as a single workflow. A
 * truncated trailing record still reads as "one line" and is caught
 * downstream instead, by the `MALFORMED_JSON` check in `verifyRecordIdentity`.
 */
function requireSingleRecord(trimmed: string): string {
  if (!trimmed) {
    throw new DownloadVerificationError('EMPTY_BODY', 'Downloaded workflow record is empty.');
  }
  if (trimmed.includes('\n')) {
    throw new DownloadVerificationError('MULTI_RECORD_BODY', 'Downloaded body contains more than one record.');
  }
  return trimmed;
}

function decodeSingleRecord(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DownloadVerificationError('MALFORMED_JSON', 'Downloaded body is not valid UTF-8.');
  }
  const recordBytes = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (recordBytes.includes('\n')) {
    throw new DownloadVerificationError('MULTI_RECORD_BODY', 'Downloaded body contains more than one record.');
  }
  const jsonText = requireSingleRecord(recordBytes.trim());
  return jsonText;
}

function requireCanonicalJsonlLf(bytes: Uint8Array): void {
  if (bytes[bytes.byteLength - 1] !== 0x0a) {
    throw new DownloadVerificationError('JSONL_NEWLINE_MISSING', 'Downloaded workflow record is missing its JSONL newline.');
  }
}

/** Bounded parse plus the pipeline-produced structural identity check.
 * The manifest currently has only whole-artifact hashes; per-line hashes must
 * be produced when final bytes are written by the packaging pipeline.
 */
function verifyRecordIdentity(jsonText: string, entry: Entry): unknown {
  // R3-F5: this compared `jsonText.length` — UTF-16 code units — against a
  // byte constant, so a body of multi-byte characters could exceed the real
  // byte bound while passing. Not exploitable at a 4 MB bound against ~115 KB
  // records, but it is the wrong unit and the message said so too.
  const byteLength = new TextEncoder().encode(jsonText).byteLength;
  if (byteLength > MAX_RECORD_BYTES) {
    throw new DownloadVerificationError(
      'BODY_TOO_LARGE',
      `Record text is ${byteLength} bytes, over the ${MAX_RECORD_BYTES}-byte bound.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new DownloadVerificationError('MALFORMED_JSON', 'Downloaded workflow record is not valid JSON.');
  }
  const nodes = parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).nodes)
    ? (parsed as { nodes: unknown[] }).nodes
    : null;
  if (!nodes || nodes.length !== entry.structure.rawNodeCount) {
    throw new DownloadVerificationError(
      'IDENTITY_MISMATCH',
      `Downloaded record has ${nodes ? nodes.length : 'no'} node(s); the requested entry declares ${entry.structure.rawNodeCount}.`,
    );
  }
  const actualTypes = new Set(
    nodes.map((node) => (node && typeof node === 'object' ? (node as Record<string, unknown>).type : undefined)),
  );
  for (const type of entry.structure.nodeTypes) {
    if (!actualTypes.has(type)) {
      throw new DownloadVerificationError(
        'IDENTITY_MISMATCH',
        `Downloaded record is missing node type "${type}" declared on the requested entry.`,
      );
    }
  }
  return parsed;
}

/** Full pipeline for a genuine `206 Partial Content` response. */
export function verifyRangeResponse(
  bytes: Uint8Array,
  spec: DownloadSpec,
  entry: Entry,
  contentRangeHeader: string | null,
): string {
  verifyContentRange(contentRangeHeader, spec);
  verifyByteLength(bytes.byteLength, spec);
  const jsonText = decodeSingleRecord(bytes);
  verifyRecordIdentity(jsonText, entry);
  requireCanonicalJsonlLf(bytes);
  return jsonText;
}

/**
 * A server that returned `200` and ignored the `Range` header: the caller
 * has already sliced the full body down to the requested offset/length.
 * There is no Content-Range to check, but the slice must still be the exact
 * expected length (a source shorter than `spec.offset + spec.length` yields a
 * short slice, caught here as truncation) and pass the same record and
 * identity checks as a real partial response.
 */
export function verifySlicedResponse(selected: Uint8Array, spec: DownloadSpec, entry: Entry): string {
  verifyByteLength(selected.byteLength, spec);
  const jsonText = decodeSingleRecord(selected);
  verifyRecordIdentity(jsonText, entry);
  requireCanonicalJsonlLf(selected);
  return jsonText;
}
