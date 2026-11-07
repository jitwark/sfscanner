import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import fieldFlowVectors from '../../../../docs/superpowers/plans/2026-10-21-scanner-deepseek/Q04-FIELD-FACT-VECTORS.json';
import { canonicalizeJson } from '../canonical-json';
import { createSafeFactAdmissionSnapshotV2 } from '../admission/snapshot';
import type { SafeFactV2 } from '../capabilities/scheduler';
import { createNodeIdentityDigest, encodeIdentityTuple } from '../workflow-v2/node-edge-identity';
import { SAFE_FACT_REGISTRY_V2 } from './safe-fact-registry';
import { canonicalSafeFactSubjectIdentity, validateSafeFact, type SafeFactRejectionReasonV2 } from './safe-fact-validator';
const digest = (letter = 'a') => letter.repeat(64);
const ref = (letter = 'a') => ({ pointer: '', occurrencePath: [], astNodeId: digest(letter), span: null });
const workflow = { kind: 'WORKFLOW' as const };
const source = { kind: 'SOURCE' as const, source: ref('b') };
const node = { kind: 'NODE' as const, node: { ordinal: 0, source: ref('c'), identityDigest: createNodeIdentityDigest(0, ref('c')) } };
const identity = (parts: readonly string[]) => bytesToHex(sha256(new TextEncoder().encode(encodeIdentityTuple(parts))));
const subjectIdentity = (value: typeof workflow | typeof source | typeof node) => value.kind === 'WORKFLOW' ? 'WORKFLOW' : value.kind === 'SOURCE' ? `SOURCE${value.source.astNodeId}` : `NODE${value.node.identityDigest}`;
function properties(kind: string): Record<string, unknown> {
  const values: Record<string, Record<string, unknown>> = {
    'workflow.summary.v1': { connectionCount: 0 },
    'workflow.structure.v1': { total: 1, executable: 1, disabled: 0, inert: 0, unresolved: 0, vertices: 1, edges: 0, unresolvedEdges: 0, parallelEdgeCount: 0, weakComponents: 1, structuralCycleRank: 0 },
    'workflow.dependencies.v1': { totalNodes: 1, reviewedNodes: 1, assumedNodes: 0, unknownNodes: 0, credentialReferences: 0, requiredCredentialSlots: 0, configuredCredentialSlots: 0, missingCredentialSlots: 0, unknownCredentialSlots: 0, environmentReferences: 0, redactedIdentifiers: 0, omittedIdentifiers: 0 },
    'workflow.effects.v1': { totalNodes: 1, reviewedNodes: 1, assumedNodes: 0, unknownNodes: 0, effectCounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], disabledEffectNodes: 0 },
    'workflow.function.v1': { basicPurpose: 'safe', triggerDescription: 'manual', dataFlowSummary: 'none', businessCategory: 'GENERAL_AUTOMATION', confidence: 'HIGH' },
    'workflow.risk-summary.v1': { topRisks: [], dataExposure: 'none', complexityDrivers: [] },
    'workflow.fingerprint.v1': { value: digest('e') },
    'integration.v1': { service: 'service', usage: 'uses', nodeTypes: ['n8n-nodes-base.httpRequest'], nodeCount: 1, riskNotes: [] },
    'node.capability.v2': { nodeType: 'n8n-nodes-base.code', nodePackage: 'n8n-nodes-base', namespaceClass: 'OFFICIAL_BASE', capabilities: ['CUSTOM_CODE'], toolCount: 0, contextCount: 0 },
    'node.configuration.v2': { observation: 'AUTH_HEADER', header: null, literalValue: false },
    'code.indicator.v2': { language: 'JAVASCRIPT', indicator: 'EVAL', start: 0, end: 1, parseState: 'VERIFIED' },
    'dataflow.summary.v2': { flowKind: 'TAINT_SINK', sink: 'COMMAND', propertyPathComplete: true, humanGatePresent: false, humanGateDominates: false, taintLabels: ['WEBHOOK_BODY'] },
    'destination.v2': { parameterPath: '/url', scheme: 'HTTPS', hostname: 'example.com', authorityState: 'KNOWN', valueMode: 'LITERAL' },
    'destination.v3': { parameterPath: '/url', scheme: 'HTTPS', hostname: 'example.com', authorityState: 'KNOWN', valueMode: 'LITERAL', reason: 'NONE', omitted: 0, inventoryStatus: 'COMPLETE' },
    'destination.coverage.v1': { inventoryStatus: 'COMPLETE', nodesExamined: 1, pathsConfigured: 1, recordsEmitted: 1, errors: 0, omitted: 0, errorCodes: [] },
    'ingress.v2': { authentication: null, authenticationState: 'MISSING', legacyAuthenticated: false },
    'advisory.evaluation.v1': {
      evaluationState: 'NOT_REQUESTED', evaluationReason: 'NONE', targetDigest: digest('a'), sourceId: null,
      pinDigest: null, coverageDigest: null, rightsReceiptDigest: null, provenanceReceiptDigest: null,
      boundsDigest: null, admissionReceiptDigest: null, pinnedSnapshotSha256: null, snapshotSha256: null,
      capturedAt: null, admittedAt: null, evaluatedAt: null, catalogueVersion: null, catalogueDigest: null,
      coverageClaimed: false, packagesRequested: 0, packagesCovered: 0, packageRowsOmitted: 0,
      recordsExamined: 0, recordsApplicable: 0, recordsNotApplicable: 0, recordsUnknown: 0, omissionReasons: [],
    },
    'advisory.package-coverage.v1': { packageName: 'example', packageVersion: '1.2.3', coverageState: 'UNKNOWN', coverageReason: 'SNAPSHOT_UNAVAILABLE' },
    'advisory.applicability.v3': { advisoryId: 'ADVISORY-1', packageName: 'example', installedVersion: '1.2.3', reviewState: 'ADMITTED', applicability: 'UNKNOWN', rowReason: 'TARGET_VERSION_UNKNOWN', matchedPrerequisites: [], unknownPrerequisites: ['packageVersion'] },
  };
  return values[kind];
}
function subject(kind: string) { return ['node.capability.v2', 'ingress.v2'].includes(kind) ? node : ['node.configuration.v2', 'code.indicator.v2', 'dataflow.summary.v2', 'destination.v2', 'destination.v3'].includes(kind) ? source : workflow; }
function admitted(value: SafeFactV2): SafeFactV2 {
  return createSafeFactAdmissionSnapshotV2(value);
}
function rawFact(kind: string, overrides: Record<string, unknown> = {}): SafeFactV2 {
  const fieldFlow = fieldFlowVectors.facts.find((entry) => entry.kind === kind);
  if (fieldFlow) {
    const properties: Record<string, unknown> = { ...fieldFlow.properties, ...overrides };
    const value = { ...fieldFlow, properties } as SafeFactV2;
    return { ...value, factId: identity(['secureflow-fact-id-v2', kind, canonicalSafeFactSubjectIdentity(value.subject), canonicalizeJson(value.properties)]) };
  }
  const factProperties = { ...properties(kind), ...overrides };
  if (kind === 'node.configuration.v2' && factProperties.observation === 'SECRET_INDICATOR') {
    delete factProperties.header;
    delete factProperties.literalValue;
  }
  const value = { kind, subject: subject(kind), properties: factProperties };
  const admittedProperties = { ...value.properties };
  if (kind === 'code.indicator.v2' && typeof admittedProperties.member !== 'string') delete admittedProperties.member;
  return {
    factId: identity(['secureflow-fact-id-v2', kind, subjectIdentity(value.subject), canonicalizeJson(admittedProperties)]),
    ...value,
  } as SafeFactV2;
}
function fact(kind: string, overrides: Record<string, unknown> = {}): SafeFactV2 {
  return admitted(rawFact(kind, overrides));
}
function codeFactWithMember(member: unknown): SafeFactV2 {
  const base = fact('code.indicator.v2');
  const properties = { ...base.properties, member };
  const admittedProperties = { ...properties };
  let oversized = false;
  if (typeof member === 'string') { let bytes = 0; for (let index = 0; index < member.length; index += 1) { const code = member.charCodeAt(index); bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code >= 0xd800 && code <= 0xdbff ? 4 : 3; if (code >= 0xd800 && code <= 0xdbff) index += 1; } oversized = bytes > 4_096; }
  if (typeof member !== 'string' || oversized || member.includes('\0') || !oversized && /(?:https?|ftp):\/\//i.test(member) || !oversized && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(member)) delete admittedProperties.member;
  return admitted({
    ...base,
    factId: identity(['secureflow-fact-id-v2', base.kind, subjectIdentity(base.subject as typeof source), canonicalizeJson(admittedProperties)]),
    properties,
  } as SafeFactV2);
}
function withFact(base: SafeFactV2, changes: Partial<SafeFactV2>): SafeFactV2 {
  return admitted({ ...base, ...changes } as SafeFactV2);
}
function edgeSubject(sourceLabel: string) { return { kind: 'EDGE' as const, edge: { ordinal: 0, sourceLabel, connectionType: 'main', sourcePort: 0, targetPort: 0, source: ref('d'), resolution: 'RESOLVED' as const } }; }
describe('safe fact admission', () => {
  it('admits canonical field-flow facts through the branded boundary before rekeying', () => {
    for (const vector of fieldFlowVectors.facts) {
      const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === vector.kind)!;
      expect(validateSafeFact(fact(vector.kind), schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    }
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'dataflow.summary.v3')!;
    expect(validateSafeFact(fact(schema.kind, { taintChannel: 'INTEGRITY', taintLabels: ['MODEL_OUTPUT', 'TOOL_RESULT'], sourceFieldPath: ['return'], sinkParameterPath: '/a~1b' }), schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
  });

  it('rejects unsafe and incoherent field-flow properties even with a matching canonical hash', () => {
    const kind = 'dataflow.summary.v3';
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find((entry) => entry.kind === kind)!;
    for (const overrides of [
      { sourceFieldPath: ['safe', 'secret=CANARY', 'sibling'] }, { sinkParameterPath: '/safe/~2' },
      { taintChannel: 'CONTROL' }, { taintLabels: ['UNREVIEWED'] }, { knowledge: 'UNKNOWN' },
      { omittedAtoms: 1 }, { sourceNodeDigest: 'A'.repeat(64) }, { emittedFlows: 1 },
    ]) expect(validateSafeFact(fact(kind, overrides), schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false });
    const provenanceKind = 'dataflow.provenance.v1';
    const provenanceSchema = SAFE_FACT_REGISTRY_V2.schemas.find((entry) => entry.kind === provenanceKind)!;
    expect(validateSafeFact(fact(provenanceKind, { sourceNodeOrdinal: 1 }), provenanceSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false });
    expect(validateSafeFact(fact(provenanceKind, { sourceNodeDigest: digest('a') }), provenanceSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false });
  });

  it('requires maxSourceWork in the closed safe-fact limits snapshot', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.summary.v1')!;
    const limits = { ...DEFAULT_SCANNER_LIMITS_V2 } as Record<string, unknown>;
    delete limits.maxSourceWork;
    expect(validateSafeFact(fact(schema.kind), schema, limits as never)).toMatchObject({
      ok: false, reason: 'UNSAFE_INPUT',
    });
    expect(validateSafeFact(fact(schema.kind), schema, {
      ...DEFAULT_SCANNER_LIMITS_V2, maxSourceWork: 0,
    })).toMatchObject({ ok: true });
  });
  it('rejects unbranded facts before reading any candidate property', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.summary.v1')!;
    let reads = 0;
    const candidate = new Proxy(fact(schema.kind), {
      get: () => { reads += 1; throw new Error('candidate read'); },
      getOwnPropertyDescriptor: () => { reads += 1; throw new Error('descriptor read'); },
      ownKeys: () => { reads += 1; throw new Error('ownKeys read'); },
      getPrototypeOf: () => { reads += 1; throw new Error('prototype read'); },
    });
    expect(validateSafeFact(candidate, schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({
      ok: false, reason: 'UNSAFE_INPUT',
    });
    expect(reads).toBe(0);
  });
  it('admits every initial registry kind and returns a deeply frozen snapshot', () => {
    for (const schema of SAFE_FACT_REGISTRY_V2.schemas) {
      const result = validateSafeFact(fact(schema.kind), schema, DEFAULT_SCANNER_LIMITS_V2);
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.fact)).toBe(true);
        expect(Object.isFrozen(result.fact.subject)).toBe(true);
        expect(Object.isFrozen(result.fact.properties)).toBe(true);
      }
    }
  });
  it('keeps destination v2 admitted while destination v3 holds its reason, count, and hostname bounds', () => {
    expect(SAFE_FACT_REGISTRY_V2.schemas.map(({ kind }) => kind)).toEqual(expect.arrayContaining(['destination.v3', 'destination.coverage.v1']));
    const legacy = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'destination.v2')!;
    expect(validateSafeFact(fact(legacy.kind), legacy, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'destination.v3')!;
    expect(validateSafeFact(fact(schema.kind), schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    for (const overrides of [{ reason: 'SECRET' }, { omitted: -1 }, { hostname: 'https://secret.example' }]) {
      expect(validateSafeFact(fact(schema.kind, overrides), schema, DEFAULT_SCANNER_LIMITS_V2), JSON.stringify(overrides)).toMatchObject({ ok: false, reason: 'INVALID_PROPERTY' });
    }
  });
  it('admits only known destination coverage error codes', () => {
    expect(SAFE_FACT_REGISTRY_V2.schemas.map(({ kind }) => kind)).toContain('destination.coverage.v1');
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'destination.coverage.v1')!;
    expect(validateSafeFact(fact(schema.kind), schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    const codes = ['MISSING_SEMANTICS', 'MISSING_PATH', 'MALFORMED_PATH', 'LIMIT_EXCEEDED', 'UNSAFE_INPUT'];
    expect(validateSafeFact(fact(schema.kind, { errorCodes: codes }), schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    for (const errorCodes of [['failed while reading workflow configuration'], ['https://secret.example']]) {
      expect(validateSafeFact(fact(schema.kind, { errorCodes }), schema, DEFAULT_SCANNER_LIMITS_V2), JSON.stringify(errorCodes)).toMatchObject({ ok: false, reason: 'INVALID_PROPERTY' });
    }
  });
  it('rejects unknown kinds, properties, enum values, wrong subjects, and forbidden content', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.function.v1')!;
    const cases: Array<[unknown, SafeFactRejectionReasonV2]> = [
      [fact('missing.kind'), 'UNKNOWN_FACT_KIND'],
      [fact(schema.kind, { extra: 'x' }), 'UNKNOWN_PROPERTY'],
      [fact(schema.kind, { confidence: 'MAYBE' }), 'INVALID_PROPERTY'],
      [withFact(fact(schema.kind), { subject: source }), 'INVALID_SUBJECT'],
      [fact(schema.kind, { basicPurpose: 'https://secret.example/token' }), 'FORBIDDEN_CONTENT'],
    ];
    for (const [candidate, reason] of cases) expect(validateSafeFact(candidate, schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason });
  });
  it('admits dataflow summaries only for source and node subjects', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'dataflow.summary.v2')!;
    expect(validateSafeFact(fact(schema.kind), schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    const workflowFact = fact(schema.kind);
    const subjectValue = { kind: 'WORKFLOW' as const };
    const candidate = withFact(workflowFact, {
      subject: subjectValue,
      factId: identity(['secureflow-fact-id-v2', schema.kind, 'WORKFLOW', canonicalizeJson(workflowFact.properties)]),
    });
    expect(validateSafeFact(candidate, schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'INVALID_SUBJECT' });
  });
  it('uses every edge identity field in the canonical subject identity', () => {
    const first = edgeSubject('main');
    const second = edgeSubject('alternate');
    expect(canonicalSafeFactSubjectIdentity(first)).toBe(`EDGE${identity(['secureflow-edge-ref-v2', '0', 'NONE', 'main', 'NONE', 'NONE', 'main', '0', '0', digest('d'), 'RESOLVED'])}`);
    expect(canonicalSafeFactSubjectIdentity(first)).not.toBe(canonicalSafeFactSubjectIdentity(second));
  });
  it('rejects a forged canonical fact id', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.summary.v1')!;
    expect(validateSafeFact(withFact(fact(schema.kind), { factId: digest('f') }), schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'INVALID_PROPERTY' });
  });
  it('rejects malformed graph shapes without invoking accessors or echoing input', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.summary.v1')!;
    let invoked = false;
    const accessor = { ...fact(schema.kind) } as Record<string, unknown>;
    Object.defineProperty(accessor, 'properties', { enumerable: true, get: () => { invoked = true; throw new Error('secret'); } });
    const sparse = { ...fact(schema.kind), properties: { connectionCount: new Array(1) } };
    const cyclic = rawFact(schema.kind); (cyclic.properties as Record<string, unknown>).cycle = cyclic;
    const schemaGetter = { ...schema }; Object.defineProperty(schemaGetter, 'kind', { enumerable: true, get: () => { invoked = true; throw new Error('schema'); } });
    for (const candidate of [accessor, sparse, cyclic, Object.create({ ...fact(schema.kind) })]) {
      const result = validateSafeFact(candidate, schema, DEFAULT_SCANNER_LIMITS_V2);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('secret');
    }
    expect(validateSafeFact(fact(schema.kind), schemaGetter, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'REGISTRY_MISMATCH' });
    expect(invoked).toBe(false);
  });
  it('rejects symbol keys and cyclic data without invoking getters', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.summary.v1')!;
    let invoked = false;
    const symbolInput = { ...fact(schema.kind), [Symbol('secret')]: 'not admitted' };
    const nonEnumerable = rawFact(schema.kind); Object.defineProperty(nonEnumerable.properties, 'unknown', { enumerable: false, value: 'secret' });
    const cyclicList: unknown[] = [];
    cyclicList.push(cyclicList);
    const cyclic = rawFact('workflow.risk-summary.v1');
    (cyclic.properties as Record<string, unknown>).topRisks = cyclicList;
    const getter = rawFact(schema.kind);
    Object.defineProperty(getter.properties, 'connectionCount', { enumerable: false, get: () => { invoked = true; throw new Error('getter'); } });
    expect(validateSafeFact(symbolInput, schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
    expect(validateSafeFact(nonEnumerable, schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
    expect(validateSafeFact(cyclic, SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.risk-summary.v1')!, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false });
    expect(validateSafeFact(getter, schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
    expect(invoked).toBe(false);
  });
  it('enforces byte, pointer, fingerprint, integer, and list boundaries', () => {
    const summary = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.summary.v1')!;
    expect(validateSafeFact(fact(summary.kind, { connectionCount: Number.MAX_SAFE_INTEGER + 1 }), summary, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'INVALID_PROPERTY' });
    const fingerprint = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.fingerprint.v1')!;
    expect(validateSafeFact(fact(fingerprint.kind, { value: 'A'.repeat(64) }), fingerprint, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'INVALID_PROPERTY' });
    const risk = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.risk-summary.v1')!;
    expect(validateSafeFact(fact(risk.kind, { topRisks: ['a', 'b', 'c', 'd'] }), risk, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' });
    expect(validateSafeFact(fact(risk.kind, { dataExposure: 'x\0y' }), risk, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
  });
  it('bounds UTF-8 measurement before encoding an over-limit string', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.function.v1')!;
    const candidate = fact(schema.kind, { basicPurpose: 'x'.repeat(schema.maxStringBytes + 1) }); const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: InstanceType<typeof TextEncoder>, input = '') { if (input.length > schema.maxStringBytes) throw new Error('unbounded encode'); return new Uint8Array(input.length); });
    try { expect(validateSafeFact(candidate, schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' }); } finally { encode.mockRestore(); }
    const includes = vi.spyOn(String.prototype, 'includes').mockImplementation(() => { throw new Error('unbounded NUL scan'); }); try { expect(validateSafeFact(candidate, schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'LIMIT_EXCEEDED' }); } finally { includes.mockRestore(); }
    const large = fact(schema.kind, { basicPurpose: 'a'.repeat(2_000), triggerDescription: 'b'.repeat(2_000), dataFlowSummary: 'c'.repeat(2_000) }); const boundedEncode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: InstanceType<typeof TextEncoder>, input = '') { if (input.length > 4_096) throw new Error('unbounded encode'); return new Uint8Array(input.length); }); try { expect(validateSafeFact(large, schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true }); } finally { boundedEncode.mockRestore(); }
  });
  it('omits an unsafe optional code member while retaining the fact', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'code.indicator.v2')!;
    const result = validateSafeFact(fact(schema.kind, { member: { leaked: 'source' } }), schema, DEFAULT_SCANNER_LIMITS_V2);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.fact.properties).not.toHaveProperty('member');
  });
  it('omits URL, NUL, and over-limit optional code members independently', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'code.indicator.v2')!;
    for (const member of ['https://secret.example/member', 'safe\0member', 'x'.repeat(schema.maxStringBytes + 1)]) {
      const result = validateSafeFact(codeFactWithMember(member), schema, DEFAULT_SCANNER_LIMITS_V2);
      expect(result).toMatchObject({ ok: true });
      if (result.ok) expect(result.fact.properties).not.toHaveProperty('member');
    }
  });
  it('rejects zero-length and reversed code spans', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'code.indicator.v2')!;
    for (const overrides of [{ start: 0, end: 0 }, { start: 2, end: 1 }]) {
      expect(validateSafeFact(fact(schema.kind, overrides), schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'INVALID_PROPERTY' });
    }
  });
  it('admits dataflow summaries only for source and node subjects', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'dataflow.summary.v2')!;
    expect(validateSafeFact(fact(schema.kind), schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    const workflowFact = fact(schema.kind);
    const subjectValue = { kind: 'WORKFLOW' as const };
    const candidate = withFact(workflowFact, {
      subject: subjectValue,
      factId: identity(['secureflow-fact-id-v2', schema.kind, 'WORKFLOW', canonicalizeJson(workflowFact.properties)]),
    });
    expect(validateSafeFact(candidate, schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'INVALID_SUBJECT' });
  });
  it('uses every edge identity field in the canonical subject identity', () => {
    const first = edgeSubject('main');
    const second = edgeSubject('alternate');
    expect(canonicalSafeFactSubjectIdentity(first)).toBe(`EDGE${identity(['secureflow-edge-ref-v2', '0', 'NONE', 'main', 'NONE', 'NONE', 'main', '0', '0', digest('d'), 'RESOLVED'])}`);
    expect(canonicalSafeFactSubjectIdentity(first)).not.toBe(canonicalSafeFactSubjectIdentity(second));
  });
  it('rejects a forged canonical fact id', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.summary.v1')!;
    expect(validateSafeFact(withFact(fact(schema.kind), { factId: digest('f') }), schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'INVALID_PROPERTY' });
  });
  it('uses closed enum sets per fact kind', () => {
    const code = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'code.indicator.v2')!;
    expect(validateSafeFact(fact(code.kind, { indicator: 'SENSITIVE_KEY' }), code, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'INVALID_PROPERTY' });
    const configuration = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'node.configuration.v2')!;
    expect(validateSafeFact(fact(configuration.kind, { observation: 'SECRET_INDICATOR', parameterPath: '/key', secretKind: 'token', indicator: 'SENSITIVE_KEY', hasLiteralValue: false }), configuration, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    const ingress = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'ingress.v2')!;
    const normalized = fact(ingress.kind, { authentication: null, authenticationState: 'UNKNOWN', legacyAuthenticated: false });
    const malformed = withFact(normalized, { properties: { ...normalized.properties, authentication: 'Authorization:secret', authenticationState: 'AUTHENTICATED', legacyAuthenticated: true } });
    const result = validateSafeFact(malformed, ingress, DEFAULT_SCANNER_LIMITS_V2);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.fact.properties).toEqual(normalized.properties);
  });
  it('rejects hostile proxy ownKeys without invoking the trap', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.summary.v1')!;
    let accessed = false; let ownKeysCalls = 0;
    const hostile = new Proxy({}, { ownKeys: () => { ownKeysCalls += 1; return Array.from({ length: 100_000 }, (_, index) => `k${index}`); }, getOwnPropertyDescriptor: () => { accessed = true; return undefined; } });
    const result = validateSafeFact(hostile, schema, DEFAULT_SCANNER_LIMITS_V2);
    expect(result).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' }); expect(accessed).toBe(false); expect(ownKeysCalls).toBe(0);
  });
  it('admits a valid fact without consulting Reflect.ownKeys', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.summary.v1')!;
    const ownKeys = vi.spyOn(Reflect, 'ownKeys').mockImplementation(() => { throw new Error('Reflect.ownKeys must not run'); });
    try { expect(validateSafeFact(fact(schema.kind), schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true }); } finally { ownKeys.mockRestore(); }
  });
  it('rejects a revoked Proxy without invoking its handler', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.summary.v1')!;
    let invoked = false;
    const { proxy: hostile, revoke } = Proxy.revocable(fact(schema.kind), { get: () => { invoked = true; throw new Error('get'); }, getPrototypeOf: () => { invoked = true; throw new Error('prototype'); }, ownKeys: () => { invoked = true; throw new Error('ownKeys'); }, getOwnPropertyDescriptor: () => { invoked = true; throw new Error('descriptor'); } });
    revoke();
    expect(validateSafeFact(hostile, schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' }); expect(invoked).toBe(false);
  });
  it('rejects secret, source, path, and surrogate content in their direct fields', () => {
    const cases: Array<[unknown, string]> = [[fact('node.configuration.v2', { observation: 'AUTH_HEADER', header: 'Authorization: secret', literalValue: true }), 'node.configuration.v2'], [fact('code.indicator.v2', { member: "require('/etc/passwd')" }), 'code.indicator.v2'], [fact('dataflow.summary.v2', { referenceRoot: "const secret = '/etc/passwd'" }), 'dataflow.summary.v2'], [fact('dataflow.summary.v2', { sourceNodeName: "const secret = '/etc/passwd'" }), 'dataflow.summary.v2'], [fact('workflow.function.v1', { basicPurpose: '\ud800' }), 'workflow.function.v1'], [fact('workflow.function.v1', { basicPurpose: 'sk-live-raw-token-value' }), 'workflow.function.v1'], [fact('workflow.risk-summary.v1', { dataExposure: 'API key: sk-live-secret' }), 'workflow.risk-summary.v1'], [fact('workflow.risk-summary.v1', { dataExposure: 'source snippet' }), 'workflow.risk-summary.v1'], [fact('integration.v1', { service: '../secret' }), 'integration.v1'], [fact('integration.v1', { service: 'API key' }), 'integration.v1'], [fact('integration.v1', { nodeTypes: ['https://evil.example/node'] }), 'integration.v1'], [fact('integration.v1', { nodeTypes: ['source snippet'] }), 'integration.v1']];
    const nodeSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'node.capability.v2')!;
    const named = fact(nodeSchema.kind); const namedSubject = named.subject; if (namedSubject.kind !== 'NODE') throw new Error('node capability fact must use a node subject'); cases.push([withFact(named, { subject: { ...namedSubject, node: { ...namedSubject.node, name: 'const secret = token' } } }), nodeSchema.kind], [withFact(named, { subject: { ...namedSubject, node: { ...namedSubject.node, explicitId: '/etc/passwd' } } }), nodeSchema.kind]); const validNode = withFact(named, { subject: { ...namedSubject, node: { ...namedSubject.node, explicitId: 'node-1', name: 'Data Source' } } }); const validNodeResult = validateSafeFact(validNode, nodeSchema, DEFAULT_SCANNER_LIMITS_V2); expect(validNodeResult).toMatchObject({ ok: true }); if (validNodeResult.ok && validNodeResult.fact.subject.kind === 'NODE') expect(validNodeResult.fact.subject.node).toMatchObject({ explicitId: 'node-1', name: 'Data Source' });
    const taintSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'dataflow.summary.v2')!; const taint = fact(taintSchema.kind, { sourceNodeId: 'w' }); expect(validateSafeFact(taint, taintSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    for (const [candidate, kind] of cases) { const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind: value }) => value === kind)!; const result = validateSafeFact(candidate, schema, DEFAULT_SCANNER_LIMITS_V2); expect(result).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' }); }
  });
  it('rejects token-shaped metadata and does not depend on structured cloning', () => {
    const nodeSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'node.capability.v2')!;
    expect(validateSafeFact(fact(nodeSchema.kind, { nodePackage: 'sk-live-raw-token' }), nodeSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
    const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementation(() => { throw new Error('structured clone must not run'); });
    try { expect(validateSafeFact(fact('workflow.summary.v1'), SAFE_FACT_REGISTRY_V2.schemas[0], DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true }); } finally { clone.mockRestore(); }
  });
  it('admits every visible Unicode class in display names and refuses only invisible text', () => {
    const nodeSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'node.capability.v2')!;
    const named = fact(nodeSchema.kind); const namedSubject = named.subject;
    if (namedSubject.kind !== 'NODE') throw new Error('node capability fact must use a node subject');
    // A display name is text the user chose, so every visible class is admissible: symbols and emoji
    // (So/Sc/Sm), combining marks (Mn/Mc) as used by decomposed accents, Devanagari and Arabic
    // harakat, emoji sequences joined by ZWJ, astral letters, and the punctuation a real label
    // carries. Only the invisible classes stay refused.
    const withName = (name: string) => validateSafeFact(withFact(named, { subject: { ...namedSubject, node: { ...namedSubject.node, name } } }), nodeSchema, DEFAULT_SCANNER_LIMITS_V2);
    const admitted = ['🙂', 'Send e-mail ✉️', '👨‍👩‍👧‍👦 family', 'e\u0301tude', 'काम', 'مَرْحَبًا', '[dev] task #1 – done', 'Café Ürün Raporu', '𝐀𝐬𝐭𝐫𝐚𝐥 letters', '報告書', 'שלום', 'مرحبا بالعالم', '€ 100 © 2026 °C', 'x'];
    for (const name of admitted) expect(withName(name), name).toMatchObject({ ok: true });
    const refused = ['a\u200Bb', 'a\u202Eb', 'a\u200Fb', 'a\u2066b\u2069', 'a\nb', 'a\tb', 'a\uE000b', 'a\u0378b', 'a\uD800b', '\u200D\u200D', '', 'const secret = token', '/etc/passwd', 'https://example.com/x', "require('/etc/passwd')", 'DROP TABLE users'];
    for (const name of refused) expect(withName(name), JSON.stringify(name)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
  });
  it('applies one display-name policy to node names, source names, source labels, and services', () => {
    const nodeSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'node.capability.v2')!;
    const named = fact(nodeSchema.kind); const namedSubject = named.subject;
    if (namedSubject.kind !== 'NODE') throw new Error('node capability fact must use a node subject');
    const dataflowSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'dataflow.summary.v2')!;
    const integrationSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'integration.v1')!;
    expect(validateSafeFact(withFact(named, { subject: { ...namedSubject, node: { ...namedSubject.node, explicitId: '🙂-1' } } }), nodeSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    expect(validateSafeFact(fact(dataflowSchema.kind, { sourceNodeName: '🙂 Alert', sourceNodeId: 'h1' }), dataflowSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    expect(validateSafeFact(fact(dataflowSchema.kind, { sourceNodeName: 'a\u202Eb' }), dataflowSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
    expect(validateSafeFact(fact(integrationSchema.kind, { service: '送信 🙂' }), integrationSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    expect(validateSafeFact(fact(integrationSchema.kind, { service: 'a\u200Bb' }), integrationSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
  });
  it('rejects cycles in subject graphs without throwing', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'node.capability.v2')!;
    const cyclic = fact(schema.kind);
    const subject = { kind: 'NODE' as const, node: { ordinal: 0, source: ref('c'), identityDigest: createNodeIdentityDigest(0, ref('c')) } } as Record<string, unknown>;
    (subject.node as Record<string, unknown>).source = subject;
    const result = validateSafeFact({ ...cyclic, subject }, schema, DEFAULT_SCANNER_LIMITS_V2);
    expect(result).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
  });
  it('rejects credential-shaped metadata, members, and advisory or SQL prose', () => {
    const nodeSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'node.capability.v2')!;
    expect(validateSafeFact(fact(nodeSchema.kind, { nodePackage: 'AKIAIOSFODNN7EXAMPLE' }), nodeSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
    const codeSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'code.indicator.v2')!;
    expect(validateSafeFact(codeFactWithMember('sk_live_token'), codeSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
    const functionSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.function.v1')!;
    expect(validateSafeFact(fact(functionSchema.kind, { basicPurpose: 'DROP TABLE users' }), functionSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
    const advisorySchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'advisory.applicability.v3')!;
    expect(validateSafeFact(fact(advisorySchema.kind, { advisoryId: 'advisory prose' }), advisorySchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false });
  });
  it('rejects auth-shaped, SecureFlow-token-shaped, code-like, and advisory URL/range text while keeping benign prose', () => {
    const functionSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.function.v1')!;
    for (const basicPurpose of ['Bearer token: raw-value', 'Basic auth: raw-value', 'process.env.API_KEY', 'console.log()', 'foo.bar()']) {
      expect(validateSafeFact(fact(functionSchema.kind, { basicPurpose }), functionSchema, DEFAULT_SCANNER_LIMITS_V2), basicPurpose).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
    }
    expect(validateSafeFact(fact(functionSchema.kind, { basicPurpose: 'Describes token handling for operators' }), functionSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });
    const nodeSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'node.capability.v2')!;
    expect(validateSafeFact(fact(nodeSchema.kind, { nodePackage: 'secureflow-token' }), nodeSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
    const advisorySchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'advisory.applicability.v3')!;
    for (const advisoryId of ['https://security.example/advisory']) {
      expect(validateSafeFact(fact(advisorySchema.kind, { advisoryId }), advisorySchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false });
    }
  });
  it('rejects identifier-shaped provider tokens and prefixed credential assignments without rejecting ordinary identifiers', () => {
    const nodeSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'node.capability.v2')!;
    const jwtLike = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl';
    const googleKey = `AIza${'A'.repeat(35)}`;
    const openAiKey = `sk-proj-${'A'.repeat(20)}`;
    expect(validateSafeFact(fact(nodeSchema.kind, { nodeType: jwtLike }), nodeSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
    expect(validateSafeFact(fact(nodeSchema.kind, { nodePackage: openAiKey }), nodeSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
    const integrationSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'integration.v1')!;
    expect(validateSafeFact(fact(integrationSchema.kind, { nodeTypes: [jwtLike] }), integrationSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });

    const codeSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'code.indicator.v2')!;
    expect(validateSafeFact(codeFactWithMember(googleKey), codeSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
    expect(validateSafeFact(fact(codeSchema.kind, { member: 'clientSecret' }), codeSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: true });

    const functionSchema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.function.v1')!;
    for (const basicPurpose of ['client_secret: raw-value', 'clientSecret: raw-value']) {
      expect(validateSafeFact(fact(functionSchema.kind, { basicPurpose }), functionSchema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'FORBIDDEN_CONTENT' });
    }
  });
  it('omits an oversized source-like member without scanning the oversized value', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'code.indicator.v2')!;
    const result = validateSafeFact(codeFactWithMember(`require${'x'.repeat(schema.maxStringBytes + 1)}`), schema, DEFAULT_SCANNER_LIMITS_V2);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.fact.properties).not.toHaveProperty('member');
  });
  it('does not scan an oversized code member after the byte limit fails', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'code.indicator.v2')!;
    const hostile = `require${'é'.repeat(Math.floor((schema.maxStringBytes - 'require'.length) / 2) + 1)}`;
    let scanned = false;
    const originalTest = RegExp.prototype.test;
    const test = vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, input: string) {
      if (input === hostile) { scanned = true; throw new Error('oversized member was scanned'); }
      return originalTest.call(this, input);
    });
    try {
      const result = validateSafeFact(codeFactWithMember(hostile), schema, DEFAULT_SCANNER_LIMITS_V2);
      expect(result).toMatchObject({ ok: true });
      expect(scanned).toBe(false);
      if (result.ok) expect(result.fact.properties).not.toHaveProperty('member');
    } finally {
      test.mockRestore();
    }
  });
  it('rejects forwarding proxies over non-plain records before value or own-key traps', () => {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find(({ kind }) => kind === 'workflow.summary.v1')!;
    let trapCalls = 0;
    const target = new Date(0);
    const forwarding = new Proxy(target, {
      get: () => { trapCalls += 1; throw new Error('value trap'); },
      ownKeys: () => { trapCalls += 1; return Array.from({ length: 100_000 }, (_, index) => `k${index}`); },
    });
    expect(validateSafeFact(forwarding, schema, DEFAULT_SCANNER_LIMITS_V2)).toMatchObject({ ok: false, reason: 'UNSAFE_INPUT' });
    expect(trapCalls).toBe(0);
  });
});
