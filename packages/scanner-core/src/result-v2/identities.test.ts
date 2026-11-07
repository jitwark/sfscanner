import { describe, expect, it } from 'vitest';
import type { SourceMemberRefV2 } from '../../../../contracts/scanner-v2-source';
import { createEdgeIdentityDigest, createNodeIdentityDigest } from '../workflow-v2/node-edge-identity';
import { canonicalSubjectIdentity, createCandidateFactId, createCandidateTraceId, createFactId, createFindingId, createTraceId } from './identities';
const digest = (letter: string): string => letter.repeat(64);
const source = (astNodeId = digest('a'), span: SourceMemberRefV2['span'] = null): SourceMemberRefV2 => ({ pointer: '/nodes/0', occurrencePath: [0], astNodeId, span });
const node = (ordinal = 0) => ({ ordinal, source: source(digest('b')), identityDigest: createNodeIdentityDigest(ordinal, source(digest('b'))) });
const context = { semanticSha256: digest('c') } as const;

const edge = () => ({ ordinal: 0, sourceNode: node(), targetNode: node(1), sourceLabel: 'main', targetLabel: 'main', connectionType: 'main', sourcePort: 0, targetPort: 0, source: source(digest('d')), resolution: 'RESOLVED' as const });

describe('result v2 identities', () => {
  it('uses exact workflow, source, node, and edge subject identities', () => {
    const workflow = { kind: 'WORKFLOW' as const };
    const sourceSubject = { kind: 'SOURCE' as const, source: source() };
    const nodeSubject = { kind: 'NODE' as const, node: node() };
    const edgeSubject = { kind: 'EDGE' as const, edge: edge() };
    expect(canonicalSubjectIdentity(workflow, context)).toBe(`WORKFLOW${context.semanticSha256}`);
    expect(canonicalSubjectIdentity(sourceSubject)).toBe(`SOURCE${sourceSubject.source.astNodeId}`);
    expect(canonicalSubjectIdentity(nodeSubject)).toBe(`NODE${nodeSubject.node.identityDigest}`);
    expect(canonicalSubjectIdentity(edgeSubject)).toBe(`EDGE${createEdgeIdentityDigest(edge())}`);
  });

  it('requires caller-provided semantic input identity for workflow subjects', () => {
    expect(() => canonicalSubjectIdentity({ kind: 'WORKFLOW' })).toThrow(TypeError);
  });

  it.each([
    { kind: 'NODE' as const, node: node() },
    { kind: 'SOURCE' as const, source: source() },
    { kind: 'EDGE' as const, edge: edge() },
  ])('shares candidate and final fact identity for $kind subjects', (subject) => {
    const input = { kind: 'workflow.summary.v1', subject, properties: { connectionCount: 1 } };
    expect(createCandidateFactId(input)).toBe(createFactId(input, context));
  });

  it('keeps candidate workflow facts unbound and rejects descriptor-backed identity reads', () => {
    const input = { kind: 'workflow.summary.v1', subject: { kind: 'WORKFLOW' as const }, properties: { connectionCount: 1 } };
    const candidate = createCandidateFactId(input);
    expect(candidate).not.toBe(createFactId(input, context));
    expect(candidate).not.toBe(createFactId(input, { semanticSha256: digest('d') }));
    expect(() => createFactId(input)).toThrow(TypeError);
    let reads = 0;
    const subject = Object.defineProperty({}, 'kind', { enumerable: true, get: () => { reads += 1; return 'WORKFLOW'; } });
    expect(() => createCandidateFactId({ ...input, subject: subject as { kind: 'WORKFLOW' } })).toThrow(TypeError);
    expect(reads).toBe(0);
  });

  it.each([
    { kind: 'NODE' as const, node: node() },
    { kind: 'SOURCE' as const, source: source() },
    { kind: 'EDGE' as const, edge: edge() },
  ])('shares canonical candidate and final trace identities for $kind subjects', (subject) => {
    const refs = [digest('f'), digest('a')];
    const input = { kind: 'INTEGRITY' as const, steps: [{ ordinal: 0, kind: 'SOURCE' as const, subject, factRefs: refs }] };
    expect(createCandidateTraceId(input)).toBe(createTraceId(input, context));
    expect(createCandidateTraceId(input)).toBe(createCandidateTraceId({ ...input, steps: [{ ...input.steps[0], factRefs: [...refs].reverse() }] }));
    expect(refs).toEqual([digest('f'), digest('a')]);
  });

  it('keeps candidate workflow traces unbound without weakening final workflow identity', () => {
    const input = { kind: 'CONFIDENTIALITY' as const, steps: [{ ordinal: 0, kind: 'SOURCE' as const, subject: { kind: 'WORKFLOW' as const }, factRefs: [] }] };
    const candidate = createCandidateTraceId(input);
    expect(candidate).not.toBe(createTraceId(input, context));
    expect(createTraceId(input, context)).not.toBe(createTraceId(input, { semanticSha256: digest('d') }));
    expect(() => createTraceId(input)).toThrow(TypeError);
    const malformed = { ...input, steps: [{ ...input.steps[0], subject: { kind: 'WORKFLOW' as const, node: node() } }] };
    expect(() => createCandidateTraceId(malformed)).toThrow(TypeError);
  });

  it('rejects accessor subjects without reading them at the candidate boundary', () => {
    let reads = 0;
    const subject = Object.defineProperty({}, 'kind', { enumerable: true, get: () => { reads += 1; return 'WORKFLOW'; } });
    const input = { kind: 'CONTROL' as const, steps: [{ ordinal: 0, kind: 'SOURCE' as const, subject: subject as { kind: 'WORKFLOW' }, factRefs: [] }] };
    expect(() => createCandidateTraceId(input)).toThrow(TypeError);
    expect(reads).toBe(0);
  });
  it('excludes spans and presentation from fact, trace, and finding IDs', () => {
    const fact = { kind: 'workflow.summary.v1', subject: { kind: 'SOURCE' as const, source: source() }, properties: { connectionCount: 1 } };
    const relocatedFact = { ...fact, subject: { kind: 'SOURCE' as const, source: source(digest('a'), { start: { line: 1, column: 1, utf16Offset: 0, utf8ByteOffset: 0 }, end: { line: 1, column: 2, utf16Offset: 1, utf8ByteOffset: 1 } }) } };
    expect(createFactId(fact, context)).toBe(createFactId(relocatedFact, context));
    const first = { kind: 'CONTROL' as const, steps: [{ ordinal: 0, kind: 'SOURCE' as const, subject: fact.subject, factRefs: [] }] };
    const relocated = { ...first, steps: [{ ...first.steps[0], subject: relocatedFact.subject }] };
    expect(createTraceId(first, context)).toBe(createTraceId(relocated, context));
    const finding = { ruleId: 'RULE', ruleRevision: '1', effect: 'REPORT_ONLY' as const, severity: 'INFO' as const, confidence: 'HIGH' as const, evidenceClass: 'CAPABILITY' as const, conclusion: 'OBSERVED' as const, applicability: 'APPLICABLE' as const, subject: fact.subject, factRefs: [digest('f')], traceRefs: [], remediationId: 'first remediation' };
    const revised = { ...finding, subject: relocatedFact.subject, remediationId: 'revised remediation' };
    expect(createFindingId(finding, context)).toBe(createFindingId(revised, context));
  });

  it('sorts reference IDs without mutating caller arrays', () => {
    const refs = [digest('b'), digest('a')];
    const input = { ruleId: 'RULE', ruleRevision: '1', evidenceClass: 'CAPABILITY' as const, conclusion: 'OBSERVED' as const, applicability: 'APPLICABLE' as const, subject: { kind: 'WORKFLOW' as const }, factRefs: refs, traceRefs: [digest('d'), digest('c')] };
    const first = createFindingId(input, context);
    expect(refs).toEqual([digest('b'), digest('a')]);
    expect(first).toBe(createFindingId({ ...input, factRefs: [...refs].reverse(), traceRefs: [...input.traceRefs].reverse() }, context));
  });

  it('uses only the frozen finding tuple fields', () => {
    const base = { ruleId: 'RULE', ruleRevision: '1', evidenceClass: 'CAPABILITY' as const, conclusion: 'OBSERVED' as const, applicability: 'APPLICABLE' as const, subject: { kind: 'WORKFLOW' as const }, factRefs: [], traceRefs: [] };
    expect(createFindingId(base, context)).toBe(createFindingId({ ...base }, context));
  });
});
