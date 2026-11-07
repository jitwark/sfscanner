import { parse, type ValueNode } from '@humanwhocodes/momoa';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ScannerLimitsV2 } from '@hub/contracts';
import { exceedsJsonDocumentDepth, MAX_SOURCE_PARSER_DEPTH } from './source-preflight';
import { preflightJson } from './json-preflight';
import { analyzeSource, buildSourceTree } from './source-tree';
import { resolveScannerLimits } from './scanner-limit-resolution';
import { markParsedSourceDocument } from './source-document-provenance';
import type { SourceParseResult } from './source-types';

const INVALID_JSON = Object.freeze({
  ok: false,
  code: 'INVALID_JSON',
  message: 'Workflow bytes are not valid JSON.',
} as const);

export function parseSourceDocument(bytes: Uint8Array, partialLimits?: Partial<ScannerLimitsV2>): SourceParseResult {
  try {
    if (!(bytes instanceof Uint8Array)) return INVALID_JSON;
    const limits = resolveScannerLimits(partialLimits);
    if (!limits) return INVALID_JSON;
    return parseSourceDocumentWithLimits(bytes, limits);
  } catch {
    return INVALID_JSON;
  }
}

function parseSourceDocumentWithLimits(bytes: Uint8Array, limits: ScannerLimitsV2): SourceParseResult {
  if (bytes.length > limits.maxBytes) {
    return {
      ok: false,
      code: 'WORKFLOW_TOO_LARGE',
      message: 'Workflow bytes exceed the configured payload limit.',
    };
  }
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const payload = hasBom ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload);
  } catch {
    return {
      ok: false,
      code: 'UTF8_DECODING_FAILED',
      message: 'Workflow bytes are not valid UTF-8.',
    };
  }
  const effectiveDepth = Math.min(limits.maxDocumentDepth, MAX_SOURCE_PARSER_DEPTH);
  const preflight = preflightJson(payload, {
    maxBytes: limits.maxBytes, maxDepth: effectiveDepth, maxTokens: Math.max(16, limits.maxSyntaxNodes * 3),
    maxRawStringBytes: limits.maxBytes, maxWork: limits.maxBytes,
  });
  if (!preflight.ok) {
    if (preflight.reason === 'BYTES') return { ok: false, code: 'WORKFLOW_TOO_LARGE', message: 'Workflow bytes exceed the configured payload limit.' };
    if (preflight.reason === 'MALFORMED') return INVALID_JSON;
    const cause = preflight.reason === 'DEPTH' ? 'DOCUMENT_DEPTH_LIMIT'
      : preflight.reason === 'TOKENS' ? 'SYNTAX_NODE_LIMIT' : 'SOURCE_WORK_LIMIT';
    return { ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause, message: 'Workflow bytes exceed the configured source complexity limit.' };
  }
  if (exceedsJsonDocumentDepth(text, effectiveDepth)) {
    return {
      ok: false,
      code: 'WORKFLOW_TOO_COMPLEX',
      cause: 'DOCUMENT_DEPTH_LIMIT',
      message: 'Workflow bytes exceed the configured source complexity limit.',
    };
  }

  let root: ValueNode;
  try {
    root = parse(text, { mode: 'json', ranges: true }).body;
  } catch {
    return INVALID_JSON;
  }
  let analysis: ReturnType<typeof analyzeSource>;
  try {
    analysis = analyzeSource(root, text, limits);
  } catch {
    return INVALID_JSON;
  }
  if ('ok' in analysis) return analysis;

  try {
    const tree = buildSourceTree(analysis.contexts, text, limits.maxStoredSourceSpans);
    const document = Object.freeze({
      rawSha256: bytesToHex(sha256(bytes)),
      utf8Bytes: bytes.length,
      bom: hasBom ? 'UTF8' : 'NONE',
      root: tree.value,
      duplicateCount: analysis.duplicateCount,
      syntaxNodeCount: analysis.syntaxNodeCount,
    });
    markParsedSourceDocument(document);
    return {
      ok: true,
      document,
      sourceWorkUnits: analysis.sourceWorkUnits,
      sourceSpanUsage: tree.usage,
    };
  } catch {
    return INVALID_JSON;
  }
}
