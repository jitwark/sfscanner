import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { parseSourceDocument } from '@hub/scanner-core/source/source-parser';
import type { ReadonlySourceDocumentV2 } from '@hub/scanner-core/source/source-types';
import { createEdgeIdentityDigest } from './node-edge-identity';
import { normalizeSecurityWorkflow } from './normalize-security-workflow';

const encoder = new TextEncoder();

function source(text: string): ReadonlySourceDocumentV2 {
  const result = parseSourceDocument(encoder.encode(text), DEFAULT_SCANNER_LIMITS_V2);
  if (!result.ok) throw new Error('fixture source must parse');
  return result.document;
}

function freezeGraph<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    if (Array.isArray(value)) value.forEach((item) => freezeGraph(item));
    else Object.values(value as Record<string, unknown>).forEach((item) => freezeGraph(item));
    Object.freeze(value);
  }
  return value;
}

describe('normalizeSecurityWorkflow', () => {
  it('normalizes a minimal workflow with frozen deterministic digests', () => {
    const result = normalizeSecurityWorkflow(source('{"name":"demo","nodes":[],"connections":{}}'), DEFAULT_SCANNER_LIMITS_V2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.nodes).toEqual([]);
    expect(result.workflow.edges).toEqual([]);
    expect(result.ambiguityCount).toBe(0);
    expect(result.semanticSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.ambiguitySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.workflow)).toBe(true);
  });

  it.each([
    ['null', 'root'],
    ['{"nodes":[],"connections":[]}', 'connections'],
    ['{"nodes":{ },"connections":{}}', 'nodes'],
  ])('rejects malformed %s workflow shape', (text) => {
    const result = normalizeSecurityWorkflow(source(text), DEFAULT_SCANNER_LIMITS_V2);
    expect(result).toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
  });

  it('retains malformed parameters as source evidence without inventing an object', () => {
    const result = normalizeSecurityWorkflow(source('{"nodes":[{"name":"A","type":"x","parameters":"secret"}],"connections":{}}'), DEFAULT_SCANNER_LIMITS_V2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.nodes[0].parameters).toEqual([]);
    expect(result.workflow.ambiguities.some((item) => item.kind === 'MALFORMED_SECURITY_VALUE')).toBe(true);
  });

  it('keeps duplicate IDs and names as separate graph subjects', () => {
    const result = normalizeSecurityWorkflow(source('{"nodes":[{"id":"same","name":"A","type":"x"},{"id":"same","name":"A","type":"x"}],"connections":{}}'), DEFAULT_SCANNER_LIMITS_V2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.nodes).toHaveLength(2);
    expect(result.workflow.nodes[0].ref.identityDigest).not.toBe(result.workflow.nodes[1].ref.identityDigest);
    expect(result.workflow.ambiguities.filter((item) => item.kind === 'AMBIGUOUS_NODE')).toHaveLength(2);
  });

  it('retains resolved, ambiguous, unresolved, and non-zero-port edges', () => {
    const text = '{"nodes":[{"name":"A","type":"x"},{"name":"B","type":"x"},{"name":"B","type":"x"}],"connections":{"A":{"main":[[{"node":"B","index":2}],[{"node":"Missing","index":1}]]}}}';
    const result = normalizeSecurityWorkflow(source(text), DEFAULT_SCANNER_LIMITS_V2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.edges).toHaveLength(2);
    expect(result.workflow.edges[0]).toMatchObject({ sourcePort: 0, targetPort: 2, resolution: 'AMBIGUOUS' });
    expect(result.workflow.edges[1]).toMatchObject({ sourcePort: 1, targetPort: 1, resolution: 'UNRESOLVED' });
    expect(result.workflow.ambiguities.map((item) => item.kind)).toContain('AMBIGUOUS_EDGE');
    expect(result.workflow.ambiguities.map((item) => item.kind)).toContain('UNRESOLVED_EDGE');
  });

  it('retains an unknown-source edge as unresolved graph evidence', () => {
    const text = '{"nodes":[{"name":"B","type":"x"}],"connections":{"Missing":{"main":[[{"node":"B","index":0}]]}}}';
    const result = normalizeSecurityWorkflow(source(text), DEFAULT_SCANNER_LIMITS_V2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.edges).toHaveLength(1);
    expect(result.workflow.edges[0]).toMatchObject({
      resolution: 'UNRESOLVED', sourceLabel: 'Missing', targetLabel: 'B',
    });
    expect(Object.prototype.hasOwnProperty.call(result.workflow.edges[0], 'sourceNode')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.workflow.edges[0], 'targetNode')).toBe(true);
    expect(createEdgeIdentityDigest(result.workflow.edges[0])).not.toBe(createEdgeIdentityDigest({
      ...result.workflow.edges[0], sourceLabel: 'Other',
    }));
    expect(result.workflow.ambiguities.map((item) => item.kind)).toContain('UNRESOLVED_EDGE');
  });

  it('marks duplicate security members indeterminate, omits duplicate labels, and makes duplicate types non-catalogue-resolvable', () => {
    const text = '{"nodes":[{"id":"same","id":"same-2","name":"A","name":"A-2","type":"x","type":"y","typeVersion":1,"typeVersion":2,"disabled":false,"disabled":true,"parameters":{"a":1},"parameters":{"b":2},"credentials":{},"credentials":{},"settings":{},"settings":{}}],"connections":{}}';
    const result = normalizeSecurityWorkflow(source(text), DEFAULT_SCANNER_LIMITS_V2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.nodes[0]).toMatchObject({ type: '', scoringEligibility: 'INDETERMINATE' });
    expect(result.workflow.nodes[0].ref).not.toHaveProperty('explicitId');
    expect(result.workflow.nodes[0].ref).not.toHaveProperty('name');
    expect(result.workflow.nodes[0].parameters.map((field) => field.pointer)).toEqual(['/nodes/0/parameters/a', '/nodes/0/parameters/b']);
  });

  it('marks duplicate valid parameter members indeterminate', () => {
    const result = normalizeSecurityWorkflow(source('{"nodes":[{"name":"A","type":"x","parameters":{"a":1},"parameters":{"b":2}}],"connections":{}}'), DEFAULT_SCANNER_LIMITS_V2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.workflow.nodes[0].scoringEligibility).toBe('INDETERMINATE');
  });

  it('marks nested parameter and top-level execution duplicates indeterminate', () => {
    const nested = normalizeSecurityWorkflow(source('{"nodes":[{"name":"A","type":"x","parameters":{"nested":{"key":1,"key":2}}}],"connections":{}}'), DEFAULT_SCANNER_LIMITS_V2);
    const topLevel = normalizeSecurityWorkflow(source('{"nodes":[{"name":"A","type":"x","retryOnFail":true,"retryOnFail":false}],"connections":{}}'), DEFAULT_SCANNER_LIMITS_V2);
    expect(nested.ok && nested.workflow.nodes[0].scoringEligibility).toBe('INDETERMINATE');
    expect(topLevel.ok && topLevel.workflow.nodes[0].scoringEligibility).toBe('INDETERMINATE');
  });

  it('retains duplicate edge node and index candidates as unresolved without target identity', () => {
    const text = '{"nodes":[{"name":"A","type":"x"},{"name":"B","type":"x"}],"connections":{"A":{"main":[[{"node":"B","node":"B","index":0,"index":1}]]}}}';
    const result = normalizeSecurityWorkflow(source(text), DEFAULT_SCANNER_LIMITS_V2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.edges[0]).toMatchObject({ resolution: 'UNRESOLVED', sourceLabel: 'A' });
    expect(result.workflow.edges[0]).not.toHaveProperty('targetNode');
    expect(result.workflow.edges[0]).toHaveProperty('targetLabel', 'B');
    expect(result.workflow.ambiguities.map((item) => item.kind)).toContain('MALFORMED_SECURITY_VALUE');
  });

  it('retains a duplicate edge when a later node or index occurrence is malformed', () => {
    const text = '{"nodes":[{"name":"A","type":"x"},{"name":"B","type":"x"}],"connections":{"A":{"main":[[{"node":"B","node":null,"index":0,"index":true}]]}}}';
    const result = normalizeSecurityWorkflow(source(text), DEFAULT_SCANNER_LIMITS_V2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.edges).toHaveLength(1);
    expect(result.workflow.edges[0]).toMatchObject({ resolution: 'UNRESOLVED', targetLabel: 'B', targetPort: 0 });
    expect(Object.prototype.hasOwnProperty.call(result.workflow.edges[0], 'targetNode')).toBe(false);
    expect(result.workflow.ambiguities.map((item) => item.kind)).toContain('MALFORMED_SECURITY_VALUE');
  });

  it('checks the accepted-edge budget before allocating edge records', () => {
    const text = '{"nodes":[{"name":"A","type":"x"},{"name":"B","type":"x"}],"connections":{"A":{"main":[[{"node":"B"},{"node":"B"}]]}}}';
    const parsed = source(text);
    expect(normalizeSecurityWorkflow(parsed, { ...DEFAULT_SCANNER_LIMITS_V2, maxEdges: 0 })).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'EDGE_LIMIT' });
    expect(normalizeSecurityWorkflow(parsed, { ...DEFAULT_SCANNER_LIMITS_V2, maxEdges: 1 })).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'EDGE_LIMIT' });
    const atOne = normalizeSecurityWorkflow(source('{"nodes":[{"name":"A","type":"x"},{"name":"B","type":"x"}],"connections":{"A":{"main":[[{"node":"B"}]]}}}'), { ...DEFAULT_SCANNER_LIMITS_V2, maxEdges: 1 });
    expect(atOne.ok).toBe(true);
    if (atOne.ok) expect(atOne.counters.edgesRetained).toBe(1);
  });

  it('returns a closed malformed result for invalid limits and forged source graphs', () => {
    const parsed = source('{"nodes":[],"connections":{}}');
    expect(normalizeSecurityWorkflow(parsed, { ...DEFAULT_SCANNER_LIMITS_V2, maxNodes: -1 } as never)).toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
    const forged = { ...parsed, syntaxNodeCount: Number.POSITIVE_INFINITY } as unknown;
    expect(normalizeSecurityWorkflow(forged as never, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
    const forgedRef = { ...parsed, root: { ...parsed.root, ref: { ...parsed.root.ref, astNodeId: parsed.root.ref.astNodeId.toUpperCase() } } } as unknown;
    expect(normalizeSecurityWorkflow(forgedRef as never, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
  });

  it('rejects nonfinite source values, mutable graphs, and spans over the stored-span budget', () => {
    const scalar = source('1');
    const nonfinite = freezeGraph({ ...scalar, root: freezeGraph({ ...scalar.root, value: Number.POSITIVE_INFINITY }) });
    expect(normalizeSecurityWorkflow(nonfinite, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
    const mutable = { ...scalar };
    expect(normalizeSecurityWorkflow(mutable, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });

    const limits = { ...DEFAULT_SCANNER_LIMITS_V2, maxStoredSourceSpans: 1 };
    const parsed = parseSourceDocument(encoder.encode('{"nodes":[],"connections":{}}'), limits);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(normalizeSecurityWorkflow(parsed.document, limits).ok).toBe(true);
  });

  it('rejects reused AST identities and member/value ref mismatches', () => {
    const parsed = source('{"a":1,"b":2}');
    if (parsed.root.kind !== 'OBJECT') throw new Error('fixture root must be object');
    const first = parsed.root.members[0];
    const second = parsed.root.members[1];
    const reusedRef = freezeGraph({ ...second.ref, astNodeId: first.ref.astNodeId });
    const reusedValue = freezeGraph({ ...second.value, ref: reusedRef });
    const reusedMember = freezeGraph({ ...second, ref: reusedRef, value: reusedValue });
    const reusedRoot = freezeGraph({ ...parsed.root, members: freezeGraph([first, reusedMember]) });
    expect(normalizeSecurityWorkflow(freezeGraph({ ...parsed, root: reusedRoot }), DEFAULT_SCANNER_LIMITS_V2))
      .toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });

    const mismatchValue = freezeGraph({ ...second.value });
    const mismatchMember = freezeGraph({ ...second, ref: first.ref, value: mismatchValue });
    const mismatchRoot = freezeGraph({ ...parsed.root, members: freezeGraph([first, mismatchMember]) });
    expect(normalizeSecurityWorkflow(freezeGraph({ ...parsed, root: mismatchRoot }), DEFAULT_SCANNER_LIMITS_V2))
      .toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
  });

  it('rejects sparse containers before iterating beyond the member budget', () => {
    const parsed = source('[]');
    if (parsed.root.kind !== 'ARRAY') throw new Error('fixture root must be array');
    const sparse = new Array(1_000_000);
    const root = freezeGraph({ ...parsed.root, items: freezeGraph(sparse) });
    expect(normalizeSecurityWorkflow(freezeGraph({ ...parsed, root }), { ...DEFAULT_SCANNER_LIMITS_V2, maxMembersAndElements: 1 }))
      .toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
  });

  it('rejects throwing source and limit accessors without invoking them', () => {
    let sourceGetterCalled = false;
    const forgedSource = Object.freeze(Object.defineProperty({}, 'root', {
      enumerable: true,
      get() { sourceGetterCalled = true; throw new Error('must not read'); },
    }));
    expect(normalizeSecurityWorkflow(forgedSource as never, DEFAULT_SCANNER_LIMITS_V2))
      .toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
    expect(sourceGetterCalled).toBe(false);

    let limitGetterCalled = false;
    const forgedLimits = Object.defineProperty({}, 'maxNodes', {
      enumerable: true,
      get() { limitGetterCalled = true; throw new Error('must not read'); },
    });
    expect(normalizeSecurityWorkflow(source('{"nodes":[],"connections":{}}'), forgedLimits as never))
      .toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
    expect(limitGetterCalled).toBe(false);
  });

  it('rejects source spans whose line and column end precedes their start', () => {
    const parsed = source('1');
    const span = parsed.root.ref.span;
    if (!span) throw new Error('fixture span required');
    const badSpan = freezeGraph({ ...span, end: freezeGraph({ ...span.end, line: span.start.line - 1 }) });
    const badRef = freezeGraph({ ...parsed.root.ref, span: badSpan });
    const badRoot = freezeGraph({ ...parsed.root, ref: badRef });
    expect(normalizeSecurityWorkflow(freezeGraph({ ...parsed, root: badRoot }), DEFAULT_SCANNER_LIMITS_V2))
      .toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
  });

  it('rejects forged valid-looking source clones and unknown wrapper/ref keys', () => {
    const parsed = source('{"nodes":[],"connections":{}}');
    const ref = parsed.root.ref;
    const cases = [
      freezeGraph({ ...parsed.root, ref: freezeGraph({ ...ref, astNodeId: 'b'.repeat(64) }) }),
      freezeGraph({ ...parsed.root, ref: freezeGraph({ ...ref, pointer: '/dangling', occurrencePath: freezeGraph([99]) }) }),
      freezeGraph({ ...parsed.root, ref: freezeGraph({ ...ref, span: freezeGraph({ ...ref.span! }) }) }),
      freezeGraph({ ...parsed.root, ref: freezeGraph({ ...ref, extra: 'wrapper' }) }),
    ];
    for (const root of cases) {
      expect(normalizeSecurityWorkflow(freezeGraph({ ...parsed, root }), DEFAULT_SCANNER_LIMITS_V2))
        .toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
    }
    expect(normalizeSecurityWorkflow(freezeGraph({ ...parsed, extra: true }), DEFAULT_SCANNER_LIMITS_V2))
      .toMatchObject({ ok: false, code: 'MALFORMED_WORKFLOW' });
  });

  it('retains duplicate root node and connection occurrences in the normalized view', () => {
    const text = '{"nodes":[{"name":"A","type":"x"}],"nodes":[{"name":"B","type":"x"}],"connections":{"A":{"main":[[{"node":"B"}]]}},"connections":{"B":{"main":[[{"node":"A"}]]}}}';
    const result = normalizeSecurityWorkflow(source(text), DEFAULT_SCANNER_LIMITS_V2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.nodes.map((node) => node.ref.source.occurrencePath)).toEqual([[0, 0], [1, 0]]);
    expect(result.workflow.edges).toHaveLength(2);
    expect(result.workflow.ambiguities.filter((item) => item.kind === 'DUPLICATE_MEMBER')).toHaveLength(2);
  });

  it('retains numeric typeVersion as a canonical string and reports malformed values', () => {
    const numeric = normalizeSecurityWorkflow(source('{"nodes":[{"name":"A","type":"x","typeVersion":1.0}],"connections":{}}'), DEFAULT_SCANNER_LIMITS_V2);
    const fractional = normalizeSecurityWorkflow(source('{"nodes":[{"name":"A","type":"x","typeVersion":3.4}],"connections":{}}'), DEFAULT_SCANNER_LIMITS_V2);
    const malformed = normalizeSecurityWorkflow(source('{"nodes":[{"name":"A","type":"x","typeVersion":true}],"connections":{}}'), DEFAULT_SCANNER_LIMITS_V2);
    expect(numeric.ok && numeric.workflow.nodes[0].typeVersion).toBe('1.0.0');
    expect(fractional.ok && fractional.workflow.nodes[0].typeVersion).toBe('3.4.0');
    expect(malformed.ok && malformed.workflow.ambiguities.map((item) => item.kind)).toContain('MALFORMED_SECURITY_VALUE');
  });

  it('caps ambiguous-edge related refs using a deterministic existing budget', () => {
    const nodes = Array.from({ length: 8 }, (_, index) => `{"name":"B${index}","type":"x"}`).join(',');
    const text = `{"nodes":[${nodes}],"connections":{"Missing":{"main":[[{"node":"B0"}]]}}}`;
    const result = normalizeSecurityWorkflow(source(text), { ...DEFAULT_SCANNER_LIMITS_V2, maxDiagnostics: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const edgeAmbiguity = result.workflow.ambiguities.find((item) => item.kind === 'UNRESOLVED_EDGE');
    expect(edgeAmbiguity?.related.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('uses the full ambiguity ordering comparator and an exact failure union', () => {
    const result = normalizeSecurityWorkflow(source('{"nodes":[{"name":"A","type":"x","parameters":{"x":1}}],"connections":{}}'), { ...DEFAULT_SCANNER_LIMITS_V2, maxParameterLeaves: 0 });
    expect(result).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'PARAMETER_LEAF_LIMIT' });
    if (!result.ok) expect('cause' in result).toBe(true);
  });

  it('classifies expressions, code, credentials, secrets, and plain values without execution', () => {
    const text = '{"nodes":[{"name":"A","type":"x","parameters":{"expr":"={{ $json.x }}","jsCode":"eval(\\"no\\")","password":"token","providerValue":"sk-proj-AAAAAAAAAAAAAAAAAAAA","ordinary":"value"},"credentials":{"apiKey":"secret"}}],"connections":{}}';
    const result = normalizeSecurityWorkflow(source(text), DEFAULT_SCANNER_LIMITS_V2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fields = [...result.workflow.nodes[0].parameters, ...result.workflow.nodes[0].credentials];
    expect(fields.map((field) => field.classification)).toEqual(expect.arrayContaining([
      'EXPRESSION', 'CODE', 'SECRET_CANDIDATE', 'PLAIN', 'CREDENTIAL_REF',
    ]));
    expect(fields.find((field) => field.pointer.endsWith('/providerValue'))?.classification)
      .toBe('SECRET_CANDIDATE');
  });

  it('preserves numeric type versions and node execution settings', () => {
    const text = '{"nodes":[{"name":"A","type":"n8n-nodes-base.httpRequest","typeVersion":4.2,"disabled":true,"retryOnFail":true,"maxTries":3,"waitBetweenTries":50,"onError":"continueRegularOutput","alwaysOutputData":true,"parameters":{},"credentials":{"httpHeaderAuth":{"id":"cred-id"}},"settings":{"custom":true},"unknownField":"kept"}],"connections":{},"pinData":{"A":[{"x":1}]},"staticData":{"lastId":2},"triggerCount":1,"tags":["prod"],"meta":{"templateCredsSetupCompleted":true},"unknownRoot":{"kept":true}}';
    const result = normalizeSecurityWorkflow(source(text), DEFAULT_SCANNER_LIMITS_V2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.nodes[0]).toMatchObject({ typeVersion: '4.2.0', disabled: true });
    const settingPointers = result.workflow.nodes[0].settings.map((field) => field.pointer);
    expect(settingPointers).toEqual(expect.arrayContaining([
      '/nodes/0/retryOnFail', '/nodes/0/maxTries', '/nodes/0/waitBetweenTries',
      '/nodes/0/onError', '/nodes/0/alwaysOutputData', '/nodes/0/unknownField',
    ]));
    const rootPointers = result.workflow.workflowFields.map((field) => field.pointer);
    expect(rootPointers).toEqual(expect.arrayContaining([
      '/pinData', '/staticData', '/triggerCount', '/tags', '/meta', '/unknownRoot',
    ]));
  });

  it('does not resolve connection labels through explicit node IDs', () => {
    const text = '{"nodes":[{"id":"target-id","name":"Actual Name","type":"x"},{"name":"Source","type":"x"}],"connections":{"Source":{"main":[[{"node":"target-id"}]]}}}';
    const result = normalizeSecurityWorkflow(source(text), DEFAULT_SCANNER_LIMITS_V2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.edges[0]).toMatchObject({ resolution: 'UNRESOLVED' });
    expect(result.workflow.edges[0].targetNode).toBeUndefined();
  });

  it('charges malformed raw edge candidates before rejecting them', () => {
    const text = '{"nodes":[{"name":"A","type":"x"}],"connections":{"A":{"main":[[null,42]]}}}';
    const parsed = source(text);

    expect(normalizeSecurityWorkflow(parsed, { ...DEFAULT_SCANNER_LIMITS_V2, maxRawEdges: 1 }))
      .toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'RAW_EDGE_LIMIT' });
    const atLimit = normalizeSecurityWorkflow(parsed, { ...DEFAULT_SCANNER_LIMITS_V2, maxRawEdges: 2 });
    expect(atLimit.ok).toBe(true);
    if (atLimit.ok) expect(atLimit.counters.rawEdgesExamined).toBe(2);
  });

  it('measures malformed nested connection containers against the depth budget', () => {
    const parsed = source('{"nodes":[{"name":"A","type":"x"}],"connections":{"A":{"main":[[[[[[]]]]]]}}}');
    expect(normalizeSecurityWorkflow(parsed, { ...DEFAULT_SCANNER_LIMITS_V2, maxConnectionDepth: 4 }))
      .toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'CONNECTION_DEPTH_LIMIT' });
  });

  it('keeps prototype-special names as data and deeply freezes nested output', () => {
    const text = '{"__proto__":{"polluted":true},"nodes":[{"name":"A","type":"x","parameters":{"constructor":{"prototype":"data"}}}],"connections":{}}';
    const result = normalizeSecurityWorkflow(source(text), DEFAULT_SCANNER_LIMITS_V2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.workflowFields.some((field) => field.pointer === '/__proto__')).toBe(true);
    expect(Object.isFrozen(result.workflow.workflowFields)).toBe(true);
    expect(Object.isFrozen(result.workflow.nodes[0].parameters)).toBe(true);
    expect(Object.isFrozen(result.workflow.nodes[0].parameters[0].value)).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('charges node, raw-edge, accepted-edge, connection-depth, and parameter budgets inclusively', () => {
    const text = '{"nodes":[{"name":"A","type":"x","parameters":{"a":1}},{"name":"B","type":"x"}],"connections":{"A":{"main":[[{"node":"B","index":0}]]}}}';
    const parsed = source(text);
    expect(normalizeSecurityWorkflow(parsed, { ...DEFAULT_SCANNER_LIMITS_V2, maxNodes: 1 })).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'NODE_LIMIT' });
    expect(normalizeSecurityWorkflow(parsed, { ...DEFAULT_SCANNER_LIMITS_V2, maxRawEdges: 0 })).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'RAW_EDGE_LIMIT' });
    expect(normalizeSecurityWorkflow(parsed, { ...DEFAULT_SCANNER_LIMITS_V2, maxEdges: 0 })).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'EDGE_LIMIT' });
    expect(normalizeSecurityWorkflow(parsed, { ...DEFAULT_SCANNER_LIMITS_V2, maxParameterLeaves: 0 })).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'PARAMETER_LEAF_LIMIT' });
    expect(normalizeSecurityWorkflow(parsed, { ...DEFAULT_SCANNER_LIMITS_V2, maxConnectionDepth: 3 })).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'CONNECTION_DEPTH_LIMIT' });
    expect(normalizeSecurityWorkflow(parsed, { ...DEFAULT_SCANNER_LIMITS_V2, maxConnectionDepth: 4 }).ok).toBe(true);
    expect(normalizeSecurityWorkflow(parsed, { ...DEFAULT_SCANNER_LIMITS_V2, maxParameterDepth: 0 })).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'PARAMETER_DEPTH_LIMIT' });
    expect(normalizeSecurityWorkflow(parsed, { ...DEFAULT_SCANNER_LIMITS_V2, maxParameterDepth: 1 }).ok).toBe(true);
  });
});
