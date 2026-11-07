import { describe, expect, it } from 'vitest';
import type { SubjectV2 } from '../../capabilities/scheduler';
import { createNodeIdentityDigest } from '../../workflow-v2/node-edge-identity';
import {
  SCAN_LOCAL_LIMITS_V1, knownState, type FieldStateV1, type ScanLocalChargeV1, type TaintAtomV1,
} from './scan-local-state';
import { createScanLocalTransfer, type FieldTransferModelV1 } from './scan-local-transfer';
import { runScanLocalWithWitnesses, type ScanLocalWitnessInputV1,
  type ScanLocalWitnessResultV1 } from './scan-local-traces';

const origin = { sourceId: 'origin', field: ['body'], channel: 'INTEGRITY' as const };
const extra: TaintAtomV1 = Object.freeze({ sourceId: 'extra', field: Object.freeze(['body']), channel: 'INTEGRITY' });
const deepAtom: TaintAtomV1 = Object.freeze({
  sourceId: 'deep', channel: 'INTEGRITY',
  field: Object.freeze(Array.from({ length: SCAN_LOCAL_LIMITS_V1.maxPathDepth + 1 }, (_, index) => `s${index}`)),
});
const context = { semanticSha256: 'e'.repeat(64) };
const subject = (ordinal: number): SubjectV2 => {
  const position = (offset: number) => ({ line: 1, column: offset + 1, utf16Offset: offset, utf8ByteOffset: offset });
  const source = { pointer: `/nodes/${ordinal}`, occurrencePath: [ordinal], astNodeId: 'a'.repeat(64),
    span: { start: position(ordinal), end: position(ordinal + 1) } };
  return { kind: 'NODE', node: { ordinal, source, identityDigest: createNodeIdentityDigest(ordinal, source) } };
};

type Transfer = (node: string, state: FieldStateV1, charge: ScanLocalChargeV1) => FieldStateV1;
type RunOptions = Readonly<{
  witness?: Partial<ScanLocalWitnessInputV1>;
  models?: ReadonlyMap<string, FieldTransferModelV1>;
  transfer?: Transfer;
  maxOperations?: number;
}>;

/** Runs the real runner: one worklist invocation, the collector's own publication hook, no second pass. */
const run = (graph: ReadonlyMap<string, readonly string[]>, options: RunOptions = {}) => {
  const nodes = [...new Set([...graph.keys(), ...[...graph.values()].flat()])].sort();
  const carriers = new Map(nodes.map((key, ordinal) => [key, { kind: 'PROPAGATION' as const, node: ordinal,
    field: '/value', port: 0, item: 0 }]));
  const models = options.models ?? new Map<string, FieldTransferModelV1>();
  const reviewed = new Map(nodes.map((key) => [key, models.get(key) ?? { kind: 'COPY' as const }]));
  return runScanLocalWithWitnesses({
    entry: 'a', graph, initialState: knownState([origin]),
    transfer: options.transfer ?? createScanLocalTransfer(reviewed),
    maxStates: 20, maxOperations: options.maxOperations ?? 100_000,
  }, {
    carriers, sources: new Map([['origin', 'a']]),
    edges: new Map([...graph].map(([from, targets]) => [from, new Map(targets.map((to, ordinal) =>
      [to, { ordinal, channel: 'DATA' as const, supported: true }]))])),
    requests: [{ atom: origin, sink: 'z', channel: 'DATA' }], subjects: new Map(nodes.map((_, index) => [index, subject(index)])),
    context, limits: { maxTraceStepsPerFinding: 100, maxEvidenceBytes: 100_000 }, maxWitnessOperations: 10_000,
    ...options.witness,
  });
};

describe('scan-local runner field flows', () => {
  it('returns the collected flow candidate beside the supported canonical witness', () => {
    const result = run(new Map([['a', ['m']], ['m', ['z']]]));
    expect(result.analysis.status).toBe('COMPLETE');
    expect(result.witnesses[0]?.status).toBe('COMPLETE');
    expect(result).toMatchObject({ omittedRequests: 0, witnessUnavailable: 0, omittedTraceSteps: 0 });
    expect(result.flows).toMatchObject({ status: 'COMPLETE', composed: true, candidates: [expect.objectContaining({
      atom: origin, sourceNode: 'a', sinkNode: 'z', omittedAtoms: 0, omittedTokens: 0,
    })] });
    expect(result.flows.fields).toBe(result.analysis.states);
    // Exactly the executed TRANSFER output of this run is sink authority, never the seed or a join.
    expect(result.flows.candidates[0]?.sinkState).toBe(result.analysis.states.get('z'));
  });

  it('yields no candidate and no witness through an exact literal overwrite', () => {
    const result = run(new Map([['a', ['m']], ['m', ['z']]]),
      { models: new Map([['m', { kind: 'EXACT_LITERAL' as const }]]) });
    expect(result.analysis.states.get('z')?.atoms).toEqual([]);
    expect(result.flows.candidates).toEqual([]);
    expect(result.flows).toMatchObject({ absentAtSinks: 1, unpublishedSinks: 0, incompleteTransfers: 0 });
    expect(result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null });
    expect(result).toMatchObject({ witnessUnavailable: 1, omittedTraceSteps: 0, omittedRequests: 0 });
  });

  it('retains an UNKNOWN-sink candidate without inventing a trace or a step omission', () => {
    const result = run(new Map([['a', ['z']]]), {
      transfer: (node, state) => node === 'z' ? knownState([...state.atoms, deepAtom]) : state,
    });
    expect(result.flows.candidates).toHaveLength(1);
    const candidate = result.flows.candidates[0]!;
    expect(candidate.sinkState).toMatchObject({ knowledge: 'UNKNOWN', atoms: [origin], unknownReasons: ['PAYLOAD_LIMIT'] });
    expect(candidate).toMatchObject({ omittedAtoms: 1, omittedTokens: 0 });
    expect(result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null });
    expect(result).toMatchObject({ witnessUnavailable: 1, omittedTraceSteps: 0, omittedRequests: 0 });
  });

  it('keeps only the executed candidate when an early limit skips the finish hook', () => {
    const graph = new Map([['a', ['z', 'zz']], ['z', []], ['zz', ['z']]]);
    const transfer: Transfer = (node, state) => node === 'zz' ? knownState([...state.atoms, extra]) : state;
    const build = (maxOperations: number) => run(graph, { transfer, maxOperations });
    const stopsAfterThePendingJoin = (result: ScanLocalWitnessResultV1) =>
      result.witnesses.length === 0 && result.analysis.states.get('z')?.atoms.length === 2
      && result.flows.candidates.length === 1 && result.flows.candidates[0]!.sinkState.atoms.length === 1;
    let budget = 0;
    for (let candidate = 1; candidate <= 400; candidate += 1) {
      if (stopsAfterThePendingJoin(build(candidate))) { budget = candidate; break; }
    }
    expect(budget).toBeGreaterThan(0);
    const result = build(budget);
    expect(result.analysis).toMatchObject({ status: 'LIMITED', queuePops: 3 });
    // The queued join really holds both atoms, but it was never executed as a TRANSFER.
    expect(result.analysis.states.get('z')?.atoms).toEqual([extra, origin]);
    expect(result.flows.candidates[0]?.sinkState.atoms).toEqual([origin]);
    expect(result.flows.candidates[0]?.sinkState).not.toBe(result.analysis.states.get('z'));
    // No finish hook ran, so nothing was materialized and the requests stay honestly unprocessed.
    expect(result.witnesses).toEqual([]);
    expect(result).toMatchObject({ omittedRequests: 1, witnessUnavailable: 0, omittedTraceSteps: 0 });
  });

  it('reports real step omissions only when the existing materializer was actually charged', () => {
    const result = run(new Map([['a', ['z']]]),
      { witness: { limits: { maxTraceStepsPerFinding: 1, maxEvidenceBytes: 100_000 } } });
    expect(result.witnesses[0]).toMatchObject({ status: 'LIMIT_EXCEEDED', trace: null, omitted: 2 });
    expect(result).toMatchObject({ witnessUnavailable: 0, omittedTraceSteps: 2, omittedRequests: 0 });
    // A witness-only cap never erases the paid field-flow authority.
    expect(result.flows.candidates).toHaveLength(1);
  });

  it('does not share collectors between two scans', () => {
    const first = run(new Map([['a', ['z']]]));
    const second = run(new Map([['a', ['z']]]), { maxOperations: 1 });
    expect(first.flows.candidates).toHaveLength(1);
    expect(first.witnesses[0]?.status).toBe('COMPLETE');
    expect(second.analysis.status).toBe('LIMITED');
    expect(second.flows).toMatchObject({ status: 'LIMITED', candidates: [], unpublishedSinks: 1 });
    expect(second.witnesses).toEqual([]);
    expect(second).toMatchObject({ omittedRequests: 1, witnessUnavailable: 0, omittedTraceSteps: 0 });
    expect(second.flows).not.toBe(first.flows);
    expect(first.flows.candidates).toHaveLength(1);
    expect(first.witnesses[0]?.status).toBe('COMPLETE');
  });
});
