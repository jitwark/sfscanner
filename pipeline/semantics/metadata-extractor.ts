import ts from 'typescript';
import { countNodes, createAstContext, findDescriptionExpressions } from './metadata-ast.js';
import { extractDescription } from './metadata-description.js';
import {
  validateReceiptFiles,
  validateSourceReceipt,
  type SourceReceipt,
} from './source-receipt.js';

export type MetadataCandidate = Readonly<{
  schemaVersion: '1';
  receiptDigest: string;
  sourcePath: string;
  nodeType: string;
  versions: readonly string[];
  parameters: readonly string[];
  diagnostics: readonly string[];
}>;

export type ExtractionRejection = Readonly<{ path: string; reason: string }>;

export type Extraction = Readonly<{
  candidates: readonly MetadataCandidate[];
  rejected: readonly ExtractionRejection[];
}>;

export type ExtractionLimits = Readonly<{
  maxFiles: number;
  maxAggregateBytes: number;
  maxFileBytes: number;
  maxNodesPerFile: number;
  maxConstantsPerFile: number;
  maxLiteralDepth: number;
  maxScalarUnits: number;
}>;

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = Object.freeze({
  maxFiles: 5_000,
  maxAggregateBytes: 64 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxNodesPerFile: 200_000,
  maxConstantsPerFile: 1_024,
  maxLiteralDepth: 32,
  maxScalarUnits: 100_000,
});

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

type FileOutcome =
  | Readonly<{ ok: true; candidates: readonly MetadataCandidate[] }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * Extracts node metadata from an already-acquired source receipt without
 * importing, requiring, evaluating, or otherwise executing upstream code.
 * Data errors are returned as rejections; this function does not throw for
 * malformed receipt or file contents.
 */
export function extractMetadata(
  receipt: SourceReceipt,
  files: ReadonlyMap<string, Uint8Array>,
  overrides?: Partial<ExtractionLimits>,
): Extraction {
  const limits = resolveLimits(overrides);
  const receiptValidation = validateSourceReceipt(receipt, { maxFiles: limits.maxFiles });
  if (!receiptValidation.ok) {
    return { candidates: [], rejected: [{ path: '<receipt>', reason: 'INVALID_RECEIPT' }] };
  }

  const fileValidation = validateReceiptFiles(receiptValidation.receipt, files, {
    maxFileBytes: limits.maxFileBytes,
    maxAggregateBytes: limits.maxAggregateBytes,
  });
  if (!fileValidation.ok) {
    return {
      candidates: [],
      rejected: [{
        path: fileValidation.path ?? '<files>',
        reason: `RECEIPT_${fileValidation.reason}`,
      }],
    };
  }

  const candidates: MetadataCandidate[] = [];
  const rejected: ExtractionRejection[] = [];
  const receiptDigest = receiptValidation.digest;

  for (const file of receiptValidation.receipt.files) {
    const text = decodeStrictUtf8(files.get(file.path)!);
    if (text === null) {
      rejected.push({ path: file.path, reason: 'INVALID_UTF8' });
      continue;
    }

    const outcome = processFile(file.path, text, receiptDigest, limits);
    if (!outcome.ok) {
      rejected.push({ path: file.path, reason: outcome.reason });
      continue;
    }
    candidates.push(...outcome.candidates);
  }

  candidates.sort((left, right) =>
    compareUtf16(left.sourcePath, right.sourcePath) || compareUtf16(left.nodeType, right.nodeType));
  rejected.sort((left, right) => compareUtf16(left.path, right.path) || compareUtf16(left.reason, right.reason));
  return { candidates, rejected };
}

function processFile(
  path: string,
  text: string,
  receiptDigest: string,
  limits: ExtractionLimits,
): FileOutcome {
  try {
    const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (countNodes(sourceFile) > limits.maxNodesPerFile) return { ok: false, reason: 'NODE_LIMIT' };

    const contextResult = createAstContext(sourceFile, limits);
    if (!contextResult.ok) return contextResult;

    const expressions = findDescriptionExpressions(sourceFile);
    if (expressions.length === 0) return { ok: false, reason: 'NO_DESCRIPTION' };

    const found: MetadataCandidate[] = [];
    for (const expression of expressions) {
      const result = extractDescription(expression, contextResult.context);
      if (!result.ok) return result;
      const { nodeType, versions, parameters, diagnostics } = result.candidate;
      found.push({
        schemaVersion: '1',
        receiptDigest,
        sourcePath: path,
        nodeType,
        versions,
        parameters,
        diagnostics,
      });
    }

    const identities = new Set(found.map((candidate) => candidate.nodeType));
    if (identities.size !== found.length) return { ok: false, reason: 'DUPLICATE_IDENTITY' };
    return { ok: true, candidates: found };
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, reason: 'PARSE_DEPTH' };
    throw error;
  }
}

function decodeStrictUtf8(content: Uint8Array): string | null {
  try {
    return utf8Decoder.decode(content);
  } catch {
    return null;
  }
}

function resolveLimits(overrides: Partial<ExtractionLimits> | undefined): ExtractionLimits {
  return {
    maxFiles: safeLimit(overrides?.maxFiles, DEFAULT_EXTRACTION_LIMITS.maxFiles),
    maxAggregateBytes: safeLimit(overrides?.maxAggregateBytes, DEFAULT_EXTRACTION_LIMITS.maxAggregateBytes),
    maxFileBytes: safeLimit(overrides?.maxFileBytes, DEFAULT_EXTRACTION_LIMITS.maxFileBytes),
    maxNodesPerFile: safeLimit(overrides?.maxNodesPerFile, DEFAULT_EXTRACTION_LIMITS.maxNodesPerFile),
    maxConstantsPerFile: safeLimit(overrides?.maxConstantsPerFile, DEFAULT_EXTRACTION_LIMITS.maxConstantsPerFile),
    maxLiteralDepth: safeLimit(overrides?.maxLiteralDepth, DEFAULT_EXTRACTION_LIMITS.maxLiteralDepth),
    maxScalarUnits: safeLimit(overrides?.maxScalarUnits, DEFAULT_EXTRACTION_LIMITS.maxScalarUnits),
  };
}

function safeLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
