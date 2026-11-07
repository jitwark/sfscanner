import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { createSafeFactAdmissionSnapshotV2 } from '../../admission/snapshot';
import type { SafeFactV2, SubjectV2 } from '../../capabilities/scheduler';
import { SAFE_FACT_REGISTRY_V2 } from '../../facts/safe-fact-registry';
import { validateSafeFact } from '../../facts/safe-fact-validator';
import { createNodeIdentityDigest } from '../../workflow-v2/node-edge-identity';
import type { ScanLocalFlowFactsV1 } from './scan-local-flow-facts';
import { createScanLocalFlowCollector, type ScanLocalFlowCandidateV1 } from './scan-local-flows';
import {
  createScanLocalFlowFactEmitterV1, createScanLocalFlowWitnessFactCacheV1,
  materializerFactUnits, type ScanLocalFlowFactEmitterV1, type ScanLocalFlowSinkSpecV1,
  type ScanLocalFlowWitnessFactCacheV1,
} from './scan-local-flow-witness-facts';
import { knownState, type ScanLocalChargeV1, type TaintAtomV1 } from './scan-local-state';
import { createScanLocalTransfer, type FieldTransferModelV1 } from './scan-local-transfer';
import { runScanLocalWorklist } from './scan-local-worklist';

const ORIGIN: TaintAtomV1 = { sourceId: 'origin', field: ['body'], channel: 'INTEGRITY' };
const SINK: ScanLocalFlowSinkSpecV1 = { sinkClass: 'COMMAND', sinkFieldPath: ['command'],
  sinkParameterPath: '/command', sinkChannel: 'TOOL', edgeChannel: 'DATA' };
const subject = (ordinal: number, occurrencePath: readonly number[] = [ordinal]): SubjectV2 => {
  const source = { pointer: `/nodes/${ordinal}`, occurrencePath, astNodeId: 'a'.repeat(64), span: null };
  return { kind: 'NODE', node: { ordinal, source, identityDigest: createNodeIdentityDigest(ordinal, source) } };
};
const always = (): ScanLocalChargeV1 => () => true;
const admitted = (fact: SafeFactV2): boolean => {
  const schema = SAFE_FACT_REGISTRY_V2.schemas.find((entry) => entry.kind === fact.kind);
  if (schema === undefined) throw new Error('Missing actual fact schema');
  return validateSafeFact(createSafeFactAdmissionSnapshotV2(fact), schema, DEFAULT_SCANNER_LIMITS_V2).ok;
};

type RunV1 = Readonly<{
  emissions: readonly ScanLocalFlowFactsV1[];
  published: readonly ScanLocalFlowCandidateV1[];
  candidates: readonly ScanLocalFlowCandidateV1[];
  cache: ScanLocalFlowWitnessFactCacheV1;
}>;

/** The real worklist, collector and factory; only the carrier/subject view is supplied here. */
function run(graph: ReadonlyMap<string, readonly string[]>, options: Readonly<{
  models?: ReadonlyMap<string, FieldTransferModelV1>;
  occurrencePath?: readonly number[];
  emitter?: ScanLocalFlowFactEmitterV1;
}> = {}): RunV1 {
  const nodes = [...new Set([...graph.keys(), ...[...graph.values()].flat()])].sort();
  const carriers = new Map(nodes.map((node, ordinal) => [node, { kind: 'PROPAGATION' as const, node: ordinal,
    field: '/value', port: 0, item: 0 }]));
  const subjects = new Map(nodes.map((_, ordinal) => [ordinal, subject(ordinal, options.occurrencePath)]));
  const emitter = options.emitter ?? createScanLocalFlowFactEmitterV1({ carriers, subjects,
    sinks: new Map(nodes.map((node) => [node, SINK])), taintLabels: ['MODEL_OUTPUT'], limits: DEFAULT_SCANNER_LIMITS_V2 });
  const cache = createScanLocalFlowWitnessFactCacheV1();
  const emissions: ScanLocalFlowFactsV1[] = [];
  const published: ScanLocalFlowCandidateV1[] = [];
  const collector = createScanLocalFlowCollector({
    sources: new Map([['origin', 'a']]), requests: [{ atom: ORIGIN, sink: 'z' }],
    onCandidate: (candidate, charge) => {
      published.push(candidate);
      const facts = emitter(candidate, charge);
      emissions.push(facts);
      cache.record(candidate, facts, charge);
    },
  });
  const analysis = runScanLocalWorklist({ entry: 'a', graph, initialState: knownState([ORIGIN]),
    transfer: createScanLocalTransfer(new Map(nodes.map((node) => [node,
      options.models?.get(node) ?? { kind: 'COPY' as const }]))),
    maxStates: 20, maxOperations: 100_000, publish: collector.publish });
  const outcome = collector.collect(analysis);
  return { emissions, published, candidates: outcome.candidates, cache };
}

describe('paid witness fact emission', () => {
  it('emits admitted provenance and summary for the executed sink generation', () => {
    const { emissions, candidates, cache } = run(new Map([['a', ['z']], ['z', []]]));
    expect(emissions).toHaveLength(1);
    const facts = emissions[0]!;
    if (facts.status !== 'EMITTED') throw new Error(`Expected emitted facts, received ${facts.status}`);
    expect(admitted(facts.provenance) && admitted(facts.summary)).toBe(true);
    expect(facts.summary.properties).toMatchObject({
      taintChannel: 'INTEGRITY', sinkChannel: 'TOOL', edgeChannel: 'DATA', knowledge: 'KNOWN',
    });
    const actual = candidates[0]!;
    expect(cache.resolve(ORIGIN, 'z', actual.sinkState, always())).toBe(facts);
    expect(cache.project(candidates)).toEqual([facts.provenance, facts.summary]);
  });

  it('never resolves a superseded generation and projects only the collected candidate', () => {
    const graph = new Map([['a', ['m', 'z']], ['m', ['n']], ['n', ['z']], ['z', []]]);
    const { emissions, published, candidates, cache } = run(graph, {
      models: new Map([['n', { kind: 'SOURCE', sourceId: 'extra', field: ['body'], channel: 'INTEGRITY' }]]),
    });
    expect(published).toHaveLength(2);
    expect(published[0]).not.toBe(published[1]);
    expect(candidates).toEqual([published[1]]);
    const final = emissions[1]!;
    if (final.status !== 'EMITTED') throw new Error(`Expected emitted facts, received ${final.status}`);
    // The cache is keyed by the actual candidate/sink state, so a stale generation cannot answer.
    expect(cache.resolve(ORIGIN, 'z', published[0]!.sinkState, always())).toBeUndefined();
    expect(cache.resolve(ORIGIN, 'z', candidates[0]!.sinkState, always())).toBe(final);
    expect(cache.project(candidates)).toEqual([final.provenance, final.summary]);
    expect(cache.project(published)).toEqual([final.provenance, final.summary]);
  });

  it('records nothing when the run cannot prepay the cache key and projection slot', () => {
    const { emissions, candidates } = run(new Map([['a', ['z']], ['z', []]]));
    expect(emissions).toHaveLength(1);
    const fresh = createScanLocalFlowWitnessFactCacheV1();
    fresh.record(candidates[0]!, emissions[0]!, () => false);
    expect(fresh.project(candidates)).toEqual([]);
    expect(fresh.resolve(ORIGIN, 'z', candidates[0]!.sinkState, always())).toBeUndefined();
  });

  it('refuses an endpoint with no runner carrier or no reviewed sink without factory work', () => {
    const nodes = ['a', 'z'] as const;
    const carriers = new Map(nodes.map((node, ordinal) => [node, { kind: 'PROPAGATION' as const, node: ordinal,
      field: '/value', port: 0, item: 0 }]));
    const subjects = new Map(nodes.map((_, ordinal) => [ordinal, subject(ordinal)]));
    const candidate: ScanLocalFlowCandidateV1 = Object.freeze({ atom: ORIGIN, sourceNode: 'a', sinkNode: 'z',
      sinkState: knownState([ORIGIN]), observation: 'TRANSFER_OUTPUT', omittedAtoms: 0, omittedTokens: 0 });
    let paid = 0;
    const charge: ScanLocalChargeV1 = (units) => { paid += units; return true; };
    const noSubject = createScanLocalFlowFactEmitterV1({ carriers: new Map(), subjects, sinks: new Map([['z', SINK]]),
      taintLabels: ['MODEL_OUTPUT'], limits: DEFAULT_SCANNER_LIMITS_V2 });
    expect(noSubject(candidate, charge)).toEqual({ status: 'OMITTED', reason: 'INVALID_SUBJECT' });
    expect(paid).toBe(2);
    const noSink = createScanLocalFlowFactEmitterV1({ carriers, subjects, sinks: new Map(),
      taintLabels: ['MODEL_OUTPUT'], limits: DEFAULT_SCANNER_LIMITS_V2 });
    expect(noSink(candidate, charge)).toEqual({ status: 'OMITTED', reason: 'INVALID_PROPERTY' });
    expect(paid).toBe(4);
  });

  it('prepays the materializer fact work proportionally to the actual payload', () => {
    const small = run(new Map([['a', ['z']], ['z', []]]));
    const large = run(new Map([['a', ['z']], ['z', []]]), { occurrencePath: Array.from({ length: 64 }, (_, i) => i) });
    const smallFacts = small.cache.project(small.candidates);
    const largeFacts = large.cache.project(large.candidates);
    expect(materializerFactUnits(smallFacts)).toBeGreaterThan(2);
    expect(materializerFactUnits(largeFacts)).toBeGreaterThan(materializerFactUnits(smallFacts));
    expect(materializerFactUnits(smallFacts)).toBeLessThan(100_000);
  });
});
