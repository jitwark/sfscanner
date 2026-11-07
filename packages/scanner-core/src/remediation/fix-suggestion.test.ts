import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import type { ScannerLimitsV2 } from '@hub/contracts';
import { parseSourceDocument } from '../source/source-parser';
import type { ReadonlySourceDocumentV2 } from '../source/source-types';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import type { SecurityNodeV2 } from '../workflow-v2/security-workflow';
import {
  createFixSuggestion,
  isUnsafePatchValue,
  planFixSuggestion,
  serializeWorkflowV1,
  type FixPrerequisiteCodeV1,
  type FixSuggestionFactV1,
} from './fix-suggestion';
import type { JsonValue } from './json-patch';

const WORKFLOW = `{
  "name": "demo",
  "nodes": [
    {
      "id": "n1",
      "name": "HTTP Request",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "parameters": { "url": "http://insecure.example.com", "method": "GET" },
      "credentials": { "httpHeaderAuth": { "id": "cred-1", "name": "Header Auth" } }
    }
  ],
  "connections": {}
}`;

const SHA = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);

type Fixture = Readonly<{
  bytes: Uint8Array;
  document: ReadonlySourceDocumentV2;
  workflowDigest: string;
  node: SecurityNodeV2;
  pointer: string;
}>;

function analyze(text = WORKFLOW): Fixture {
  const bytes = new TextEncoder().encode(text);
  const parsed = parseSourceDocument(bytes);
  if (!parsed.ok) throw new Error(`fixture parse failed: ${parsed.code}`);
  const normalized = normalizeSecurityWorkflow(parsed.document);
  if (!normalized.ok) throw new Error(`fixture normalize failed: ${normalized.code}`);
  const node = normalized.workflow.nodes[0];
  if (!node) throw new Error('fixture node missing');
  return {
    bytes,
    document: parsed.document,
    workflowDigest: normalized.semanticSha256,
    node,
    pointer: `${node.ref.source.pointer}/parameters/url`,
  };
}

function rawSuggestion(fixture: Fixture = analyze(), overrides: Record<string, unknown> = {}) {
  return {
    id: 'fix-1',
    findingIds: ['finding-1'],
    sourceSha256: fixture.document.rawSha256,
    workflowDigest: fixture.workflowDigest,
    targetVersion: { packageName: 'n8n-nodes-base.httpRequest', version: '4.2.0', inventoryDigest: SHA },
    resource: { kind: 'NODE_PARAMETER', nodeIdentityDigest: fixture.node.ref.identityDigest, pointer: fixture.pointer },
    templateId: 'REMOVE_INSECURE_OVERRIDE',
    rationaleId: 'REMOVE_INSECURE_OVERRIDE',
    prerequisites: ['USER_CONFIRMATION'],
    ...overrides,
  };
}

function build(fixture: Fixture = analyze(), overrides: Record<string, unknown> = {}): FixSuggestionFactV1 {
  const created = createFixSuggestion(rawSuggestion(fixture, overrides));
  if (!created.ok) throw new Error(`suggestion refused: ${created.reason}`);
  return created.suggestion;
}

function planFor(options: Readonly<{
  fixture?: Fixture;
  overrides?: Record<string, unknown>;
  evidence?: readonly FixPrerequisiteCodeV1[];
  limits?: Partial<ScannerLimitsV2>;
}> = {}) {
  const fixture = options.fixture ?? analyze();
  const suggestion = build(fixture, options.overrides);
  return planFixSuggestion({
    suggestion,
    bytes: fixture.bytes,
    prerequisites: (options.evidence ?? ['USER_CONFIRMATION']).map((code) => ({ code, evidenceDigest: DIGEST })),
    limits: options.limits,
  });
}

describe('createFixSuggestion', () => {
  it('accepts a reviewed record and exposes only IDs, digests and typed references', () => {
    const created = createFixSuggestion(rawSuggestion());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(Object.keys(created.suggestion).sort()).toEqual([
      'findingIds', 'id', 'prerequisites', 'rationaleId', 'resource',
      'sourceSha256', 'targetVersion', 'templateId', 'workflowDigest',
    ]);
    expect(Object.isFrozen(created.suggestion)).toBe(true);
    expect(created.suggestion).not.toHaveProperty('patch');
  });

  it('refuses a patch body smuggled into the fact', () => {
    expect(createFixSuggestion({ ...rawSuggestion(), patch: [] }))
      .toEqual({ ok: false, reason: 'MALFORMED_PATCH' });
  });

  it('refuses non-lowercase digests and empty IDs', () => {
    expect(createFixSuggestion(rawSuggestion(undefined, { sourceSha256: 'A'.repeat(64) })).ok).toBe(false);
    expect(createFixSuggestion(rawSuggestion(undefined, { workflowDigest: 'abc' })).ok).toBe(false);
    expect(createFixSuggestion(rawSuggestion(undefined, { id: '' })).ok).toBe(false);
    expect(createFixSuggestion(rawSuggestion(undefined, { findingIds: [] })).ok).toBe(false);
    expect(createFixSuggestion(rawSuggestion(undefined, { findingIds: ['ok', ' '] })).ok).toBe(false);
    expect(createFixSuggestion(rawSuggestion(undefined, { id: ' padded ' })).ok).toBe(false);
  });

  it('refuses template or rationale IDs outside the static registries', () => {
    expect(createFixSuggestion(rawSuggestion(undefined, { templateId: 'FABRICATED' })))
      .toEqual({ ok: false, reason: 'UNKNOWN_OPERATION' });
    expect(createFixSuggestion(rawSuggestion(undefined, { rationaleId: 'FABRICATED' })))
      .toEqual({ ok: false, reason: 'UNKNOWN_OPERATION' });
  });

  it('refuses a malformed resource pointer', () => {
    const fixture = analyze();
    expect(createFixSuggestion(rawSuggestion(fixture, {
      resource: { kind: 'NODE_PARAMETER', nodeIdentityDigest: fixture.node.ref.identityDigest, pointer: '/nodes/0/parameters/url~2' },
    }))).toEqual({ ok: false, reason: 'MALFORMED_PATCH' });
    expect(createFixSuggestion(rawSuggestion(fixture, {
      resource: { kind: 'NODE_PARAMETER', nodeIdentityDigest: fixture.node.ref.identityDigest, pointer: '' },
    }))).toEqual({ ok: false, reason: 'MALFORMED_PATCH' });
  });

  it('requires the resource-implied prerequisite codes', () => {
    const fixture = analyze();
    expect(createFixSuggestion(rawSuggestion(fixture, {
      resource: {
        kind: 'CREDENTIAL_REFERENCE',
        nodeIdentityDigest: fixture.node.ref.identityDigest,
        pointer: '/nodes/0/credentials/httpHeaderAuth/id',
      },
    }))).toEqual({ ok: false, reason: 'MISSING_PREREQUISITE' });
    expect(createFixSuggestion(rawSuggestion(fixture, {
      resource: { kind: 'ENDPOINT', nodeIdentityDigest: fixture.node.ref.identityDigest, pointer: fixture.pointer },
    }))).toEqual({ ok: false, reason: 'MISSING_PREREQUISITE' });
  });

  it('refuses unknown or duplicated prerequisite codes', () => {
    expect(createFixSuggestion(rawSuggestion(undefined, { prerequisites: ['NOT_A_CODE'] }))).toEqual({
      ok: false, reason: 'MISSING_PREREQUISITE',
    });
    expect(createFixSuggestion(rawSuggestion(undefined, {
      prerequisites: ['USER_CONFIRMATION', 'USER_CONFIRMATION'],
    }))).toEqual({ ok: false, reason: 'MISSING_PREREQUISITE' });
  });
});

describe('planFixSuggestion', () => {
  it('returns a deterministic READY plan with an exact result digest', () => {
    const fixture = analyze();
    const plan = planFor({ fixture });
    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.suggestionId).toBe('fix-1');
    expect(plan.sourceSha256).toBe(fixture.document.rawSha256);
    expect(plan.patch).toEqual([{ op: 'remove', path: fixture.pointer }]);
    const expected = JSON.parse(WORKFLOW) as { nodes: Array<{ parameters: Record<string, JsonValue> }> };
    delete expected.nodes[0].parameters.url;
    expect(plan.resultSha256).toBe(bytesToHex(sha256(serializeWorkflowV1(expected as unknown as JsonValue))));

    const again = planFor({ fixture });
    expect(again).toEqual(plan);
  });

  it('accepts ENDPOINT resources only with compatibility evidence', () => {
    const fixture = analyze();
    const suggestion = build(fixture, {
      resource: { kind: 'ENDPOINT', nodeIdentityDigest: fixture.node.ref.identityDigest, pointer: fixture.pointer },
      prerequisites: ['USER_CONFIRMATION', 'ENDPOINT_COMPATIBILITY'],
    });
    const plan = planFixSuggestion({
      suggestion,
      bytes: fixture.bytes,
      prerequisites: [
        { code: 'USER_CONFIRMATION', evidenceDigest: DIGEST },
        { code: 'ENDPOINT_COMPATIBILITY', evidenceDigest: DIGEST },
      ],
    });
    expect(plan.status).toBe('READY');
  });

  it('refuses a stale source digest', () => {
    expect(planFor({ overrides: { sourceSha256: 'c'.repeat(64) } }))
      .toMatchObject({ status: 'REFUSED', reason: 'STALE_SOURCE' });
  });

  it('refuses a workflow digest that does not match the normalized source', () => {
    expect(planFor({ overrides: { workflowDigest: 'c'.repeat(64) } }))
      .toMatchObject({ status: 'REFUSED', reason: 'UNKNOWN_TARGET' });
  });

  it('refuses duplicate keys anywhere in the source', () => {
    const duplicated = WORKFLOW.replace('"name": "demo",', '"name": "demo", "name": "duplicate",');
    expect(planFor({ fixture: analyze(duplicated) }))
      .toMatchObject({ status: 'REFUSED', reason: 'DUPLICATE_KEYS' });
    const nested = WORKFLOW.replace('"method": "GET"', '"method": "GET", "method": "POST"');
    expect(planFor({ fixture: analyze(nested) }))
      .toMatchObject({ status: 'REFUSED', reason: 'DUPLICATE_KEYS' });
  });

  it('refuses invalid JSON and sources beyond the configured byte limit', () => {
    const fixture = analyze();
    const suggestion = build(fixture);
    expect(planFixSuggestion({ suggestion, bytes: new TextEncoder().encode('{') }))
      .toMatchObject({ status: 'REFUSED', reason: 'INVALID_JSON' });
    expect(planFor({ fixture, limits: { maxBytes: 10 } }))
      .toMatchObject({ status: 'REFUSED', reason: 'SOURCE_LIMIT' });
  });

  it('refuses an unknown or ambiguous node identity', () => {
    expect(planFor({ overrides: {
      resource: { kind: 'NODE_PARAMETER', nodeIdentityDigest: 'd'.repeat(64), pointer: '/nodes/0/parameters/url' },
    } })).toMatchObject({ status: 'REFUSED', reason: 'UNKNOWN_TARGET' });
  });

  it('refuses a version that does not match the resolved node', () => {
    expect(planFor({ overrides: {
      targetVersion: { packageName: 'n8n-nodes-base.httpRequest', version: '4.3.0', inventoryDigest: SHA },
    } })).toMatchObject({ status: 'REFUSED', reason: 'UNKNOWN_VERSION' });
    const withoutVersion = WORKFLOW.replace('      "typeVersion": 4.2,\n', '');
    expect(planFor({ fixture: analyze(withoutVersion) }))
      .toMatchObject({ status: 'REFUSED', reason: 'UNKNOWN_VERSION' });
  });

  it('refuses pointers outside the resolved resource region or absent from the source', () => {
    const fixture = analyze();
    expect(planFor({ fixture, overrides: {
      resource: { kind: 'NODE_PARAMETER', nodeIdentityDigest: fixture.node.ref.identityDigest, pointer: '/nodes/0/settings/url' },
    } })).toMatchObject({ status: 'REFUSED', reason: 'UNKNOWN_RESOURCE' });
    expect(planFor({ fixture, overrides: {
      resource: { kind: 'NODE_PARAMETER', nodeIdentityDigest: fixture.node.ref.identityDigest, pointer: '/nodes/0/parameters/missing' },
    } })).toMatchObject({ status: 'REFUSED', reason: 'UNKNOWN_RESOURCE' });
  });

  it('refuses a template that does not accept the resource kind', () => {
    const fixture = analyze();
    expect(planFor({ fixture, overrides: {
      resource: {
        kind: 'CREDENTIAL_REFERENCE',
        nodeIdentityDigest: fixture.node.ref.identityDigest,
        pointer: '/nodes/0/credentials/httpHeaderAuth/id',
      },
      prerequisites: ['USER_CONFIRMATION', 'CREDENTIAL_MAPPING'],
    }, evidence: ['USER_CONFIRMATION', 'CREDENTIAL_MAPPING'] }))
      .toMatchObject({ status: 'REFUSED', reason: 'UNKNOWN_OPERATION' });
  });

  it('refuses when required prerequisite evidence is absent or malformed', () => {
    expect(planFor({ evidence: [] })).toMatchObject({ status: 'REFUSED', reason: 'MISSING_PREREQUISITE' });
    const fixture = analyze();
    expect(planFixSuggestion({
      suggestion: build(fixture),
      bytes: fixture.bytes,
      prerequisites: [{ code: 'USER_CONFIRMATION', evidenceDigest: 'not-a-digest' }],
    })).toMatchObject({ status: 'REFUSED', reason: 'MISSING_PREREQUISITE' });
  });

  it('refuses numbers that cannot round-trip through JSON', () => {
    const unsafeInteger = WORKFLOW.replace('"method": "GET"', '"method": "GET", "retries": 9007199254740993');
    expect(planFor({ fixture: analyze(unsafeInteger) }))
      .toMatchObject({ status: 'REFUSED', reason: 'UNROUNDTRIPPABLE_NUMBER', cause: '/nodes/0/parameters/retries' });
    const negativeZero = WORKFLOW.replace('"method": "GET"', '"method": "GET", "retries": -0');
    expect(planFor({ fixture: analyze(negativeZero) }))
      .toMatchObject({ status: 'REFUSED', reason: 'UNROUNDTRIPPABLE_NUMBER' });
  });

  it('accepts decimal and exponent lexemes that round-trip exactly', () => {
    const safeNumbers = WORKFLOW.replace('"method": "GET"', '"method": "GET", "ratio": 1.0, "limit": 1e2');
    expect(planFor({ fixture: analyze(safeNumbers) }).status).toBe('READY');
  });

  it('re-validates a tampered suggestion before planning', () => {
    const fixture = analyze();
    const tampered = { ...build(fixture), patch: [{ op: 'remove', path: fixture.pointer }] };
    expect(planFixSuggestion({
      suggestion: tampered as unknown as FixSuggestionFactV1,
      bytes: fixture.bytes,
    })).toMatchObject({ status: 'REFUSED', reason: 'MALFORMED_PATCH' });
  });
});

describe('isUnsafePatchValue', () => {
  it('refuses environment substitution, placeholders and provider tokens', () => {
    expect(isUnsafePatchValue('{{ $env.API_KEY }}')).toBe(true);
    expect(isUnsafePatchValue('CREDENTIAL_REPLACE_ME')).toBe(true);
    expect(isUnsafePatchValue('sk_live_12345678')).toBe(true);
    expect(isUnsafePatchValue({ nested: ['Bearer opaque-token-value-123'] })).toBe(true);
  });

  it('accepts plain reviewed literals', () => {
    expect(isUnsafePatchValue('https://api.example.com/v1')).toBe(false);
    expect(isUnsafePatchValue({ method: 'GET', retries: 2, enabled: true, empty: null })).toBe(false);
  });
});
