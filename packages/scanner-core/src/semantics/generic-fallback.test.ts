import { describe, expect, it } from 'vitest';
import { inventoryDestinations } from '../analyzers/destinations/inventory';
import { parseSourceDocument } from '../source/source-parser';
import { scanWorkflowV2 } from '../v2';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from './builtin-catalogue';
import { SemanticCatalogueAdmissionError } from './catalogue-admission';
import { GENERIC_FALLBACK_SEMANTIC_ID, SCOPED_GMAIL_BUNDLE, SCOPED_GMAIL_BUNDLE_DIGEST, createGenericFallbackSemantics, resolveNodeSemanticsForScan } from './generic-fallback';

const encoder = new TextEncoder();
const RECORD_KEYS = [
  'semanticId', 'nodeType', 'versionRange', 'operation', 'entry', 'parameterPaths', 'authentication', 'credentialPaths',
  'destinationPaths', 'effects', 'endpoints', 'ports', 'overwritePaths', 'errorMode', 'retryMode', 'disabledMode', 'provenance',
];

const workflowOfSource = (source: string) => {
  const parsed = parseSourceDocument(encoder.encode(source));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.code);
  const normalized = normalizeSecurityWorkflow(parsed.document);
  expect(normalized.ok).toBe(true);
  if (!normalized.ok) throw new Error(normalized.code);
  return normalized.workflow;
};

const workflowOf = (node: Record<string, unknown>) => workflowOfSource(JSON.stringify({ nodes: [node], connections: {} }));

describe('generic semantic fallback', () => {
  it('emits a frozen, closed record the destination inventory accepts', () => {
    const node = { id: 'sheets', name: 'Sheets', type: 'n8n-nodes-base.googleSheets', typeVersion: 4, parameters: { spreadsheetId: '1AbC' } };
    const workflow = workflowOf(node);
    const record = createGenericFallbackSemantics('n8n-nodes-base.googleSheets');

    expect(Object.getOwnPropertyNames(record).sort()).toEqual([...RECORD_KEYS].sort());
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.provenance)).toBe(true);
    expect(record).toMatchObject({
      semanticId: GENERIC_FALLBACK_SEMANTIC_ID,
      nodeType: 'n8n-nodes-base.googleSheets',
      operation: null,
      entry: 'NONE',
      authentication: null,
      parameterPaths: [],
      credentialPaths: ['/credentials'],
      destinationPaths: [],
      effects: ['READ_EXTERNAL', 'WRITE_EXTERNAL'],
      endpoints: [],
      overwritePaths: [],
      ports: [{ type: 'main', index: 0, itemMode: 'EACH' }],
      errorMode: 'UNKNOWN',
      retryMode: 'UNKNOWN',
      disabledMode: 'SKIP',
    });
    expect(record.provenance.reviewer).toBe('scanner-core-generic-fallback');
    expect(record.provenance.sourceDigest).toMatch(/^[0-9a-f]{64}$/);

    // The real consumer contract: the inventory validates frozen plain records and requires the
    // record's `nodeType` to equal the scanned node's type.
    const inventory = inventoryDestinations(workflow, new Map([[workflow.nodes[0]!.ref.identityDigest, record]]));
    expect(inventory).toMatchObject({ status: 'COMPLETE', errors: [] });
    const mismatched = inventoryDestinations(workflow, new Map([[workflow.nodes[0]!.ref.identityDigest, createGenericFallbackSemantics('n8n-nodes-base.other')]]));
    expect(mismatched.errors).toEqual([{ code: 'MISSING_SEMANTICS', nodeIdentity: workflow.nodes[0]!.ref.identityDigest, parameterPath: null }]);
  });
  it('resolves unmodelled and versionless modelled types to the fallback', () => {
    const unmodelled = workflowOf({ id: 'a', name: 'A', type: 'n8n-nodes-base.discord', parameters: {} }).nodes[0]!;
    const versionless = workflowOf({ id: 'b', name: 'B', type: 'n8n-nodes-base.httpRequest', parameters: {} }).nodes[0]!;
    const candidate = workflowOf({ id: 'c', name: 'C', type: 'n8n-nodes-base.noOp', typeVersion: 2, parameters: {} }).nodes[0]!;

    // V5: an unmodelled type still receives the fallback.
    expect(resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, unmodelled)).toMatchObject({ origin: 'GENERIC_FALLBACK', semantics: { semanticId: GENERIC_FALLBACK_SEMANTIC_ID } });
    // V1: an absent typeVersion is not an observation of 1.0.0, so it never asserts the catalogue record.
    expect(versionless.typeVersion).toBeUndefined();
    expect(resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, versionless)).toMatchObject({ origin: 'GENERIC_FALLBACK', semantics: { semanticId: GENERIC_FALLBACK_SEMANTIC_ID } });
    // V6: noOp is catalogue-modelled at version 1 only; version 2 is a miss, so it falls back.
    expect(resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, candidate)).toMatchObject({ origin: 'GENERIC_FALLBACK' });
  });
  it('refuses the fallback for a node whose fields were not readable', () => {
    const unreadable = workflowOf({
      id: 'broken', name: 'Broken', type: 'n8n-nodes-base.discord', parameters: 'not-an-object',
    }).nodes[0]!;
    const readable = workflowOf({ id: 'named', name: 'Named', type: 'n8n-nodes-base.discord', parameters: {} }).nodes[0]!;

    expect(unreadable.scoringEligibility).toBe('INDETERMINATE');
    // V4: an ineligible node receives no fallback.
    expect(resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, unreadable)).toBeNull();
    expect(readable.scoringEligibility).toBe('ELIGIBLE');
    // V5: an eligible unmodelled node still receives the fallback.
    expect(resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, readable)?.origin).toBe('GENERIC_FALLBACK');
  });
  it('resolves the D-01 Sheets record as catalogue instead of fallback', () => {
    const sheets = workflowOf({ id: 'sheets', name: 'Sheets', type: 'n8n-nodes-base.googleSheets', typeVersion: 1, parameters: {} }).nodes[0]!;
    expect(resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, sheets)).toMatchObject({
      origin: 'CATALOGUE', semantics: { semanticId: 'google-workspace.google-sheets' },
    });
  });
  });
describe('frozen version-presence vectors (Q02.0a)', () => {
  it('V2 resolves an observed typeVersion through the catalogue', () => {
    const node = workflowOf({ id: 'v2', name: 'V2', type: 'n8n-nodes-base.httpRequest', typeVersion: 1, parameters: {} }).nodes[0]!;
    expect(node.typeVersion).toBe('1.0.0');
    expect(resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, node)).toMatchObject({
      origin: 'CATALOGUE', semantics: { semanticId: 'http-ai.http-request' },
    });
  });
  it('V3 keeps a malformed typeVersion indeterminate and resolves nothing', () => {
    const workflow = workflowOf({ id: 'v3', name: 'V3', type: 'n8n-nodes-base.httpRequest', typeVersion: true, parameters: {} });
    const node = workflow.nodes[0]!;

    expect(node.scoringEligibility).toBe('INDETERMINATE');
    expect(node.typeVersion).toBeUndefined();
    expect(workflow.ambiguities).toContainEqual(expect.objectContaining({
      kind: 'MALFORMED_SECURITY_VALUE', securityImpact: 'SCORING_INPUT', resolution: 'EXCLUDED_FROM_SCORING',
    }));
    expect(resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, node)).toBeNull();
  });
  it('V7 resolves a present version the broad catalogue record admits', () => {
    const node = workflowOf({ id: 'v7', name: 'V7', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, parameters: {} }).nodes[0]!;
    expect(node.typeVersion).toBe('4.0.0');
    expect(resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, node)).toMatchObject({
      origin: 'CATALOGUE', semantics: { semanticId: 'http-ai.http-request' },
    });
  });
  it('V8 fails closed when an unreadable type has no typeVersion', () => {
    const duplicatedType = '{"nodes":[{"id":"dup","name":"Dup","type":"n8n-nodes-base.discord","type":"n8n-nodes-base.discord","parameters":{}}],"connections":{}}';
    const node = workflowOfSource(duplicatedType).nodes[0]!;

    expect(node.type).toBe('');
    expect(node.scoringEligibility).toBe('INDETERMINATE');
    const resolve = () => resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, node);
    expect(resolve).toThrowError(SemanticCatalogueAdmissionError);
    expect(resolve).toThrowError(expect.objectContaining({ code: 'INVALID_TEXT' }));
    expect(scanWorkflowV2({ bytes: encoder.encode(duplicatedType), profile: { id: 'beta-default', version: '2.0.0' } }))
      .toMatchObject({ ok: false, code: 'SEMANTIC_CATALOGUE_INVALID' });
  });
  it('V9 rejects a non-empty type the catalogue rule refuses when no version is present', () => {
    const badType = '{"nodes":[{"id":"bad","name":"Bad","type":"bad type","parameters":{}}],"connections":{}}';
    const node = workflowOfSource(badType).nodes[0]!;

    expect(node.type).toBe('bad type');
    const resolve = () => resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, node);
    expect(resolve).toThrowError(SemanticCatalogueAdmissionError);
    expect(resolve).toThrowError(expect.objectContaining({ code: 'INVALID_TEXT' }));
    expect(scanWorkflowV2({ bytes: encoder.encode(badType), profile: { id: 'beta-default', version: '2.0.0' } }))
      .toMatchObject({ ok: false, code: 'SEMANTIC_CATALOGUE_INVALID' });
  });
});

describe('operation and action resolution', () => {
  const resolve = (parameters: Record<string, unknown>, type = 'n8n-nodes-base.httpRequest') => {
    const node = workflowOf({ id: 'n', name: 'N', type, typeVersion: 1, parameters }).nodes[0]!;
    return resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, node);
  };

  it('resolves a string operation when no action is present', () => {
    expect(resolve({ operation: 'request' })).toMatchObject({
      origin: 'CATALOGUE', semantics: { semanticId: 'http-ai.http-request.request' },
    });
  });
  it('resolves /action when /operation is absent', () => {
    expect(resolve({ action: 'request' })).toMatchObject({
      origin: 'CATALOGUE', semantics: { semanticId: 'http-ai.http-request.request' },
    });
  });
  it('prefers a string operation over a conflicting action, with no conflict diagnostic', () => {
    expect(resolve({ operation: 'request', action: 'delete' })).toMatchObject({
      origin: 'CATALOGUE', semantics: { semanticId: 'http-ai.http-request.request' },
    });
  });
  it('falls through a non-string operation to a string action', () => {
    expect(resolve({ operation: 42, action: 'request' })).toMatchObject({
      origin: 'CATALOGUE', semantics: { semanticId: 'http-ai.http-request.request' },
    });
  });
  it('does not invent a per-operation record for an unknown action value', () => {
    expect(resolve({ action: 'delete' })).toMatchObject({
      origin: 'CATALOGUE', semantics: { semanticId: 'http-ai.http-request', operation: null },
    });
  });
  it('never claims action semantics on the generic fallback', () => {
    expect(resolve({ action: 'request' }, 'n8n-nodes-base.discord')).toMatchObject({
      origin: 'GENERIC_FALLBACK', semantics: { semanticId: GENERIC_FALLBACK_SEMANTIC_ID, operation: null },
    });
  });
});

describe('scoped Gmail 2.2.0 pilot', () => {
  const gmail = (parameters: Record<string, unknown>) => workflowOf({
    id: 'gmail', name: 'Gmail', type: 'n8n-nodes-base.gmail', typeVersion: 2.2, parameters,
  }).nodes[0]!;
  const nestedSelector = (parameters: Record<string, unknown>, selector: 'resource' | 'operation', value: string) => {
    const node = gmail(parameters);
    return { ...node, parameters: [{ pointer: `/nodes/0/parameters/options/parameters/${selector}`, value }, ...node.parameters] };
  };

  it('resolves the reviewed message/send pair to the specific Gmail record', () => {
    const resolution = resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, gmail({ resource: 'message', operation: 'send' }));
    expect(resolution?.semantics).toBe(SCOPED_GMAIL_BUNDLE.records[0]?.record);
    expect(resolution).toMatchObject({
      origin: 'CATALOGUE',
      semantics: {
        semanticId: 'message-mcp.gmail',
        effects: expect.arrayContaining(['READ_EXTERNAL', 'WRITE_EXTERNAL', 'SEND_MESSAGE']),
        endpoints: [expect.objectContaining({ path: '/sendTo' })],
      },
    });
  });

  it('applies the pinned default resource message when the member is absent', () => {
    expect(resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, gmail({ operation: 'send' }))).toMatchObject({
      origin: 'CATALOGUE', semantics: { semanticId: 'message-mcp.gmail' },
    });
  });
  it.each([
    ['nested resource cannot override direct label', nestedSelector({ resource: 'label', operation: 'send' }, 'resource', 'message'), 'GENERIC_FALLBACK'],
    ['nested resource is ignored when direct resource is absent', nestedSelector({ operation: 'send' }, 'resource', 'label'), 'CATALOGUE'],
    ['nested operation cannot supply scope', nestedSelector({}, 'operation', 'send'), 'GENERIC_FALLBACK'],
    ['action cannot supply the scoped operation', gmail({ resource: 'message', action: 'send' }), 'GENERIC_FALLBACK'],
    ['non-string operation cannot inherit action', gmail({ resource: 'message', operation: 42, action: 'send' }), 'GENERIC_FALLBACK'],
    ['duplicate operation cannot scope an indeterminate node', workflowOfSource('{"nodes":[{"id":"g","name":"G","type":"n8n-nodes-base.gmail","typeVersion":2.2,"parameters":{"resource":"message","operation":"send","operation":"send"}}],"connections":{}}').nodes[0]!, null],
  ])('uses eligible direct selector members: %s', (_label, node, origin) => {
    if (origin === null) expect(node.scoringEligibility).toBe('INDETERMINATE');
    expect(resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, node)?.origin ?? null).toBe(origin);
  });

  it.each<[label: string, parameters: Record<string, unknown>]>([
    ...(['not-a-gmail-resource', 'draft', 'thread'] as const).map((resource): [string, Record<string, unknown>] =>
      [`${resource} resource`, { resource, operation: 'send' }]),
    ['unreadable resource', { resource: 42, operation: 'send' }],
    ['unknown operation', { resource: 'message', operation: 'not-a-gmail-operation' }],
    ['reviewed exclusion sendAndWait', { resource: 'message', operation: 'sendAndWait' }],
  ])('falls back safely for %s', (_label, parameters) => {
    expect(resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, gmail(parameters)))
      .toMatchObject({ origin: 'GENERIC_FALLBACK', semantics: { semanticId: GENERIC_FALLBACK_SEMANTIC_ID } });
  });

  it('leaves the older Gmail versions on the broad catalogue record', () => {
    const node = workflowOf({ id: 'g', name: 'Gmail', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, parameters: { resource: 'message', operation: 'send' } }).nodes[0]!;
    expect(resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, node)).toMatchObject({
      origin: 'CATALOGUE', semantics: { semanticId: 'message-mcp.gmail' },
    });
    const versionless = workflowOf({ id: 'v', name: 'Gmail', type: 'n8n-nodes-base.gmail', parameters: { resource: 'message', operation: 'send' } }).nodes[0]!;
    expect(versionless.typeVersion).toBeUndefined();
    expect(resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, versionless)).toMatchObject({ origin: 'GENERIC_FALLBACK' });
  });
});

describe('scoped Gmail bundle authority', () => {
  it('pins the frozen scope bundle digest', () => {
    expect(SCOPED_GMAIL_BUNDLE_DIGEST).toBe('2b21f771d2cf172e33e8f78e5d1deaaefc0a5e8ff45f7d9f252cb8ec321ad56a');
  });
});
