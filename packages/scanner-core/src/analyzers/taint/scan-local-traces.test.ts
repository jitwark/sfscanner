import { describe, expect, it } from 'vitest';
import type { SubjectV2 } from '../../capabilities/scheduler';
import { canonicalBytesV1 } from '../../result-v2/canonical-bytes';
import { createNodeIdentityDigest } from '../../workflow-v2/node-edge-identity';
import { knownState } from './scan-local-state';
import { createScanLocalTransfer, type FieldTransferModelV1 } from './scan-local-transfer';
import { runScanLocalWithWitnesses, type ScanLocalWitnessInputV1, type ScanLocalWitnessResultV1 } from './scan-local-traces';

const origin = { sourceId: 'origin', field: ['body'], channel: 'INTEGRITY' as const };
const context = { semanticSha256: 'e'.repeat(64) };
const subject = (ordinal: number, missing = false): SubjectV2 => {
  const position = (offset: number) => ({ line: 1, column: offset + 1, utf16Offset: offset, utf8ByteOffset: offset });
  const source = { pointer: `/nodes/${ordinal}`, occurrencePath: [ordinal], astNodeId: 'a'.repeat(64),
    span: missing ? null : { start: position(ordinal), end: position(ordinal + 1) } };
  return { kind: 'NODE', node: { ordinal, source, identityDigest: createNodeIdentityDigest(ordinal, source) } };
};
const run = (graph: ReadonlyMap<string, readonly string[]>, overrides: Partial<ScanLocalWitnessInputV1> = {},
  models: ReadonlyMap<string, FieldTransferModelV1> = new Map()) => {
  const nodes = [...new Set([...graph.keys(), ...[...graph.values()].flat()])].sort();
  const carriers = new Map(nodes.map((key, ordinal) => [key, { kind: 'PROPAGATION' as const, node: ordinal,
    field: '/value', port: 0, item: 0 }]));
  const reviewedModels = new Map(nodes.map((key) => [key, models.get(key) ?? { kind: 'COPY' as const }]));
  return runScanLocalWithWitnesses({ entry: 'a', graph, initialState: knownState([origin]),
    transfer: createScanLocalTransfer(reviewedModels), maxStates: 20, maxOperations: 100_000 }, {
    carriers, sources: new Map([['origin', 'a']]),
    edges: new Map([...graph].map(([from, targets]) => [from, new Map(targets.map((to, ordinal) =>
      [to, { ordinal, channel: 'DATA' as const, supported: true }]))])),
    requests: [{ atom: origin, sink: 'z', channel: 'DATA' }], subjects: new Map(nodes.map((_, i) => [i, subject(i)])),
    context, limits: { maxTraceStepsPerFinding: 100, maxEvidenceBytes: 100_000 }, maxWitnessOperations: 10_000,
    ...overrides,
  });
};
const ordinals = (result: ScanLocalWitnessResultV1) => result.witnesses[0]?.trace?.steps.map((step) =>
  step.subject.kind === 'NODE' ? step.subject.node.ordinal : -1);

describe('supported scan-local canonical witnesses', () => {
  it('materializes a source-to-sink witness rather than merely reachable node names', () => {
    const result = run(new Map([['a', ['m']], ['m', ['z']]]));
    expect(result.analysis.status).toBe('COMPLETE');
    expect(result.witnesses[0]?.status).toBe('COMPLETE');
    expect(ordinals(result)).toEqual([0, 1, 2]);
    expect(result.witnesses[0]?.trace?.steps.map((step) => step.kind)).toEqual(['SOURCE', 'PROPAGATION', 'SINK']);
  });

  it('delegates tied cyclic paths to the existing deterministic shortest selector', () => {
    const first = run(new Map([['a', ['c', 'b']], ['c', ['z', 'a']], ['b', ['z']]]));
    const reordered = run(new Map([['b', ['z']], ['c', ['a', 'z']], ['a', ['b', 'c']]]));
    expect(ordinals(first)).toEqual([0, 1, 3]);
    expect(first.witnesses[0]?.trace).toEqual(reordered.witnesses[0]?.trace);
  });

  it('does not manufacture a witness through an exact literal overwrite', () => {
    const result = run(new Map([['a', ['m']], ['m', ['z']]]), {}, new Map([['m', { kind: 'EXACT_LITERAL' }]]));
    expect(result.analysis.states.get('z')?.atoms).toEqual([]);
    // A pre-gate refusal reports no measured steps: only the exact counters below are meaningful.
    expect(result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null });
    expect(result).toMatchObject({ witnessUnavailable: 1, omittedTraceSteps: 0 });
  });

  it('keeps unknown configured edges out of supported traces', () => {
    const result = run(new Map([['a', ['z']]]), { edges: new Map([['a', new Map([
      ['z', { ordinal: 0, channel: 'DATA', supported: false }],
    ])]]) });
    expect(result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null });
    expect(result).toMatchObject({ witnessUnavailable: 1, omittedTraceSteps: 0 });
    expect(result.analysis.status).toBe('LIMITED');
  });

  it('does not relabel a tool edge as a main-data witness', () => {
    const edges: ScanLocalWitnessInputV1['edges'] = new Map([['a', new Map([
      ['z', { ordinal: 0, channel: 'TOOL', supported: true }],
    ])]]);
    const graph = new Map([['a', ['z']]]);
    const mismatched = run(graph, { edges });
    expect(mismatched.witnesses[0]?.trace).toBeNull();
    expect(mismatched).toMatchObject({ witnessUnavailable: 1, omittedTraceSteps: 0 });
    const tool = run(graph, { edges, requests: [{ atom: origin, sink: 'z', channel: 'TOOL' }] });
    expect(ordinals(tool)).toEqual([0, 1]);
    expect(tool.witnesses[0]?.trace?.kind).toBe('INTEGRITY');
    expect(JSON.stringify(tool.witnesses)).not.toContain('TOOL');
  });

  it('retains counted missing-span evidence without a partial trace', () => {
    const result = run(new Map([['a', ['z']]]), { subjects: new Map([[0, subject(0)], [1, subject(1, true)]]) });
    // The existing materializer really ran here, so its omission is a measured step count.
    expect(result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 1 });
    expect(result).toMatchObject({ witnessUnavailable: 0, omittedTraceSteps: 1 });
    expect(result.analysis.status).toBe('LIMITED');
  });

  it('uses the existing step cap at the boundary and cap plus one', () => {
    const graph = new Map([['a', ['z']]]);
    expect(ordinals(run(graph, { limits: { maxTraceStepsPerFinding: 2, maxEvidenceBytes: 100_000 } }))).toEqual([0, 1]);
    expect(run(graph, { limits: { maxTraceStepsPerFinding: 1, maxEvidenceBytes: 100_000 } }).witnesses[0])
      .toMatchObject({ status: 'LIMIT_EXCEEDED', trace: null, omitted: 2 });
  });

  it('does not serialize carrier-path canaries into the closed trace representation', () => {
    const carriers = new Map(['a', 'z'].map((key, node) => [key,
      { kind: 'PROPAGATION' as const, node, field: '/SECRET_CANARY_7331', port: 0, item: 0 }]));
    const result = run(new Map([['a', ['z']]]), { carriers });
    expect(ordinals(result)).toEqual([0, 1]);
    expect(JSON.stringify(result.witnesses)).not.toContain('SECRET_CANARY_7331');
  });

  it('does not turn dynamic field uncertainty into a complete supported witness', () => {
    const result = run(new Map([['a', ['m']], ['m', ['z']]]), {}, new Map([['m', { kind: 'UNKNOWN', reason: 'DYNAMIC_FIELD' }]]));
    expect(result.analysis.states.get('z')).toMatchObject({ knowledge: 'UNKNOWN', atoms: [origin] });
    expect(result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null });
    expect(result).toMatchObject({ witnessUnavailable: 1, omittedTraceSteps: 0 });
  });

  it('excludes a literal-cleared shorter branch while retaining another supported origin path', () => {
    const result = run(new Map([['a', ['m', 'b']], ['m', ['z']], ['b', ['z']]]), {},
      new Map([['m', { kind: 'EXACT_LITERAL' }]]));
    expect(ordinals(result)).toEqual([0, 1, 3]);
  });

  it('applies the existing evidence byte boundary without a second serializer', () => {
    const graph = new Map([['a', ['z']]]);
    const complete = run(graph).witnesses[0]!;
    expect(complete.status).toBe('COMPLETE');
    const bytes = canonicalBytesV1(complete.trace).byteLength;
    expect(run(graph, { limits: { maxTraceStepsPerFinding: 2, maxEvidenceBytes: bytes } }).witnesses[0]?.status).toBe('COMPLETE');
    expect(run(graph, { limits: { maxTraceStepsPerFinding: 2, maxEvidenceBytes: bytes - 1 } }).witnesses[0])
      .toMatchObject({ status: 'LIMIT_EXCEEDED', trace: null, omitted: 2 });
  });

  it('reserves selector work from the same worklist allowance before materialization', () => {
    const result = run(new Map([['a', ['z']]]), { maxWitnessOperations: 100_001 });
    expect(result.analysis.status).toBe('LIMITED');
    expect(result.analysis.states.get('z')?.atoms).toEqual([origin]);
    expect(result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null });
    expect(result).toMatchObject({ witnessUnavailable: 1, omittedTraceSteps: 0 });
  });

  it('counts selector exhaustion without dropping supported field provenance', () => {
    const result = run(new Map([['a', ['z']]]), { maxWitnessOperations: 1 });
    expect(result.analysis.status).toBe('LIMITED');
    expect(result.analysis.states.get('z')?.atoms).toEqual([origin]);
    expect(result.witnesses[0]).toMatchObject({ status: 'GRAPH_WORK_LIMIT_EXCEEDED', trace: null, omitted: 2 });
    expect(result).toMatchObject({ witnessUnavailable: 0, omittedTraceSteps: 2 });
  });

  it('selects the shorter supported path before the stable tie-break', () => {
    const result = run(new Map([['a', ['b', 'c']], ['b', ['d']], ['d', ['z']], ['c', ['z']]]));
    expect(ordinals(result)).toEqual([0, 2, 4]);
  });

  it('retains both endpoint roles for same-node source and sink evidence', () => {
    const result = run(new Map([['a', []]]), { requests: [{ atom: origin, sink: 'a', channel: 'DATA' }] });
    expect(ordinals(result)).toEqual([0, 0]);
    expect(result.witnesses[0]?.trace?.steps.map((step) => step.kind)).toEqual(['SOURCE', 'SINK']);
  });

  it('refuses aliases the existing predecessor format cannot distinguish by port', () => {
    const carriers = new Map(['a', 'z'].map((key, port) => [key,
      { kind: 'PROPAGATION' as const, node: 0, field: '/value', port, item: 0 }]));
    const result = run(new Map([['a', ['z']]]), { carriers });
    expect(result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null });
    expect(result).toMatchObject({ witnessUnavailable: 1, omittedTraceSteps: 0 });
  });

  it('counts unprocessed requests after a refused shared-budget reservation', () => {
    const request = { atom: origin, sink: 'z', channel: 'DATA' as const };
    const result = run(new Map([['a', ['z']]]), { maxWitnessOperations: 100_001,
      requests: [request, { ...request, channel: 'TOOL' }] });
    expect(result.analysis.status).toBe('LIMITED');
    expect(result.omittedRequests).toBe(1);
    expect(result.witnesses).toEqual([expect.objectContaining({ status: 'UNKNOWN', trace: null })]);
    expect(result).toMatchObject({ witnessUnavailable: 1, omittedTraceSteps: 0 });
  });

  it('refuses summary evidence when request channel does not match reviewed sink edge channel', () => {
    const req1 = { atom: origin, sink: 'z', channel: 'DATA' as const };
    const req2 = { atom: origin, sink: 'z', channel: 'TOOL' as const };
    const result = run(new Map([['a', ['z']]]), { requests: [req1, req2] });
    expect(result.witnesses.length).toBe(2);
    expect(result.witnesses[0]?.status).toBe('COMPLETE');
    expect(result.witnesses[1]?.status).toBe('UNKNOWN');
    expect(result.witnessUnavailable).toBe(1);
  });
});
