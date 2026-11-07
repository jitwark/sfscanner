import { parseSourceDocument } from '../source/source-parser';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import { createFixSuggestion, type FixSuggestionFactV1 } from './fix-suggestion';

/**
 * Reviewed suggestion data, keyed by the exact bytes it was reviewed against. Loading is a lookup,
 * never a scan: the source and semantic digests are recomputed from the supplied bytes with the
 * existing bounded parser/normalizer, and only the entry that matches both may contribute. The
 * suggestion objects are reviewed input; a malformed one is dropped, never repaired.
 */
export type ReviewedFixSuggestionArtifactV1 = Readonly<{
  schemaVersion: 'reviewed-fix-suggestions-v1';
  version: '1.0.0';
  entries: readonly Readonly<{
    sourceSha256: string;
    workflowDigest: string;
    suggestions: readonly unknown[];
  }>[];
}>;

const SCHEMA_VERSION = 'reviewed-fix-suggestions-v1';
const ARTIFACT_VERSION = '1.0.0';
const ARTIFACT_KEYS = ['schemaVersion', 'version', 'entries'] as const;
const ENTRY_KEYS = ['sourceSha256', 'workflowDigest', 'suggestions'] as const;
const SHA256 = /^[0-9a-f]{64}$/;
const EMPTY: readonly FixSuggestionFactV1[] = Object.freeze([]);

export function loadReviewedFixSuggestions(artifact: unknown, bytes: Uint8Array): readonly FixSuggestionFactV1[] {
  if (!isArtifact(artifact)) return EMPTY;
  const parsed = parseSourceDocument(bytes);
  if (!parsed.ok) return EMPTY;
  const normalized = normalizeSecurityWorkflow(parsed.document);
  if (!normalized.ok) return EMPTY;
  const entry = artifact.entries.find((candidate) => candidate.sourceSha256 === parsed.document.rawSha256 && candidate.workflowDigest === normalized.semanticSha256);
  if (entry === undefined) return EMPTY;
  const byId = new Map<string, FixSuggestionFactV1>();
  for (const value of entry.suggestions) {
    const created = createFixSuggestion(value);
    if (!created.ok) continue;
    const suggestion = created.suggestion;
    if (suggestion.sourceSha256 !== entry.sourceSha256 || suggestion.workflowDigest !== entry.workflowDigest) continue;
    if (!byId.has(suggestion.id)) byId.set(suggestion.id, suggestion);
  }
  return Object.freeze([...byId.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)));
}

function isArtifact(value: unknown): value is ReviewedFixSuggestionArtifactV1 {
  const record = exactRecord(value, ARTIFACT_KEYS);
  if (!record || record.schemaVersion !== SCHEMA_VERSION || record.version !== ARTIFACT_VERSION) return false;
  if (!denseArray(record.entries)) return false;
  return record.entries.every((candidate) => {
    const entry = exactRecord(candidate, ENTRY_KEYS);
    return entry !== undefined && isSha256(entry.sourceSha256) && isSha256(entry.workflowDigest) && denseArray(entry.suggestions);
  });
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length) return undefined;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!names.includes(key) || descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return undefined;
  }
  return value as Record<string, unknown>;
}

function denseArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && Object.keys(value).length === value.length;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}
