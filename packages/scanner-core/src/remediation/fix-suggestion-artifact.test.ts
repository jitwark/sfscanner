import { describe, expect, it } from 'vitest';
import { parseSourceDocument } from '../source/source-parser';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import { createFixSuggestion, type FixSuggestionFactV1 } from './fix-suggestion';
import { loadReviewedFixSuggestions } from './fix-suggestion-artifact';

/** The shipped reviewed fixture: the same bytes the packaged CLI offers a suggestion for. */
const WORKFLOW = '{"name":"reviewed-fixture","nodes":[{"id":"n1","name":"HTTP Request","type":"n8n-nodes-base.httpRequest","typeVersion":4.2,"parameters":{"url":"http://insecure.example.com"}}],"connections":{}}';
const SOURCE_SHA = '84b6257de1ec8d086e21288e41bd2f5c012cbe6d862171ce823e1bfa6cf12a7b';
const WORKFLOW_DIGEST = 'b5f25698aec85a55554275ce4b1879a06a93624d2c58386504f225a8807573a6';
const NODE_DIGEST = '2c42f43bc370403fb86c432041ab7828d39c6552281a16ee04ca77ffe649b518';
const INVENTORY_DIGEST = '26728f7db41960ef0fee9b3fdc67158db3d268e17bd4683c017fd733c3772ba7';
const encoder = new TextEncoder();

function fixture(text = WORKFLOW): Readonly<{ bytes: Uint8Array; sourceSha256: string; workflowDigest: string }> {
  const bytes = encoder.encode(text);
  const parsed = parseSourceDocument(bytes);
  if (!parsed.ok) throw new Error(`fixture parse failed: ${parsed.code}`);
  const normalized = normalizeSecurityWorkflow(parsed.document);
  if (!normalized.ok) throw new Error(`fixture normalize failed: ${normalized.code}`);
  return Object.freeze({ bytes, sourceSha256: parsed.document.rawSha256, workflowDigest: normalized.semanticSha256 });
}

function suggestion(overrides: Record<string, unknown> = {}): FixSuggestionFactV1 {
  const created = createFixSuggestion({
    id: 'fix-reviewed-http-insecure-example',
    findingIds: ['49dade28807ba74aac5165e46e2944d74f4bb3f4339cab1958ff21c6f92f2aed'],
    sourceSha256: SOURCE_SHA,
    workflowDigest: WORKFLOW_DIGEST,
    targetVersion: { packageName: 'n8n-nodes-base.httpRequest', version: '4.2.0', inventoryDigest: INVENTORY_DIGEST },
    resource: { kind: 'NODE_PARAMETER', nodeIdentityDigest: NODE_DIGEST, pointer: '/nodes/0/parameters/url' },
    templateId: 'REMOVE_INSECURE_OVERRIDE',
    rationaleId: 'REMOVE_INSECURE_OVERRIDE',
    prerequisites: ['USER_CONFIRMATION'],
    ...overrides,
  });
  if (!created.ok) throw new Error(`fixture suggestion refused: ${created.reason}`);
  return created.suggestion;
}

function artifact(entries: unknown): Record<string, unknown> {
  return { schemaVersion: 'reviewed-fix-suggestions-v1', version: '1.0.0', entries };
}

function entry(overrides: Record<string, unknown> = {}): unknown {
  return { sourceSha256: SOURCE_SHA, workflowDigest: WORKFLOW_DIGEST, suggestions: [suggestion()], ...overrides };
}

describe('loadReviewedFixSuggestions', () => {
  it('returns the one reviewed suggestion for the exact fixture bytes', () => {
    const loaded = loadReviewedFixSuggestions(artifact([entry()]), fixture().bytes);

    expect(loaded).toEqual([suggestion()]);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded[0])).toBe(true);
  });

  it('pins the shipped fixture digests to its exact bytes', () => {
    const parsed = fixture();
    expect(parsed.sourceSha256).toBe(SOURCE_SHA);
    expect(parsed.workflowDigest).toBe(WORKFLOW_DIGEST);
  });

  it('returns nothing when either digest does not match', () => {
    const bytes = fixture().bytes;
    expect(loadReviewedFixSuggestions(artifact([entry({ sourceSha256: 'f'.repeat(64) })]), bytes)).toEqual([]);
    expect(loadReviewedFixSuggestions(artifact([entry({ workflowDigest: 'f'.repeat(64) })]), bytes)).toEqual([]);
  });

  it('returns nothing for a malformed artifact', () => {
    const bytes = fixture().bytes;
    const brokenEntry = { ...(entry() as Record<string, unknown>), extra: true };
    const malformed: readonly unknown[] = [
      undefined, null, 'artifact', [], {}, { ...artifact([entry()]), schemaVersion: 'reviewed-fix-suggestions-v2' },
      { ...artifact([entry()]), version: '2.0.0' }, { ...artifact([entry()]), extra: true },
      artifact('entries'), artifact([brokenEntry]),
      artifact([entry({ sourceSha256: SOURCE_SHA.toUpperCase() })]),
      artifact([entry({ workflowDigest: 'not-a-digest' })]),
      artifact([entry({ suggestions: 'suggestion' })]),
    ];
    for (const value of malformed) expect(loadReviewedFixSuggestions(value, bytes)).toEqual([]);
  });

  it('drops invalid suggestions and deduplicates the rest by id', () => {
    const older = suggestion({ id: 'fix-0-reviewed' });
    const loaded = loadReviewedFixSuggestions(
      artifact([entry({ suggestions: [{ id: 'broken' }, suggestion(), suggestion(), older] })]),
      fixture().bytes,
    );

    expect(loaded.map((item) => item.id)).toEqual(['fix-0-reviewed', 'fix-reviewed-http-insecure-example']);
  });

  it('drops a reviewed suggestion whose nested digests do not match the entry', () => {
    const bytes = fixture().bytes;
    const sourceMismatch = suggestion({ sourceSha256: 'e'.repeat(64) });
    const workflowMismatch = suggestion({ workflowDigest: 'e'.repeat(64) });

    expect(loadReviewedFixSuggestions(artifact([entry({ suggestions: [sourceMismatch] })]), bytes)).toEqual([]);
    expect(loadReviewedFixSuggestions(artifact([entry({ suggestions: [workflowMismatch] })]), bytes)).toEqual([]);
  });

  it('returns nothing for bytes that do not match the reviewed entry', () => {
    const other = fixture(WORKFLOW.replace('http://insecure.example.com', 'http://other.example.com'));
    expect(loadReviewedFixSuggestions(artifact([entry()]), other.bytes)).toEqual([]);
  });

  it('returns nothing when the bytes are refused', () => {
    expect(loadReviewedFixSuggestions(artifact([entry()]), encoder.encode('{ not json'))).toEqual([]);
    expect(loadReviewedFixSuggestions(artifact([entry()]), encoder.encode('[]'))).toEqual([]);
  });
});
