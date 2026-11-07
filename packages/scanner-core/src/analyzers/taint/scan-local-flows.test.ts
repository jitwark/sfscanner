import { describe, expect, it } from 'vitest';
import {
  SCAN_LOCAL_LIMITS_V1, knownState, type FieldStateV1, type TaintAtomV1,
} from './scan-local-state';
import {
  createScanLocalFlowCollector, type ScanLocalFlowCollectorV1, type ScanLocalFlowOutcomeV1,
} from './scan-local-flows';
import {
  runScanLocalWorklist, type ScanLocalWorklistInputV1, type ScanLocalWorklistResultV1,
} from './scan-local-worklist';

const graph = (entries: Record<string, readonly string[]>) => new Map(Object.entries(entries));
const sources = (entries: Record<string, string>) => new Map(Object.entries(entries));
const atom = (
  sourceId: string,
  channel: TaintAtomV1['channel'] = 'CONFIDENTIALITY',
  field: readonly string[] = ['body'],
): TaintAtomV1 => Object.freeze({ sourceId, channel, field: Object.freeze([...field]) });
const identity = (_node: string, state: FieldStateV1) => state;
const deepAtom = atom('poison', 'CONFIDENTIALITY',
  Array.from({ length: SCAN_LOCAL_LIMITS_V1.maxPathDepth + 1 }, (_, index) => `s${index}`));

type WorklistInput = Omit<ScanLocalWorklistInputV1, 'publish'>;
type CollectorRunV1 = Readonly<{
  analysis: ScanLocalWorklistResultV1;
  outcome: ScanLocalFlowOutcomeV1;
  transfers: readonly string[];
}>;

/** Runs the real worklist with the collector's own publication hook; nothing is analysed out of band. */
function execute(build: () => ScanLocalFlowCollectorV1, input: WorklistInput): CollectorRunV1 {
  const collector = build();
  const transfers: string[] = [];
  const analysis = runScanLocalWorklist({
    ...input,
    publish: collector.publish,
    transfer: (node, state, charge) => { transfers.push(node); return input.transfer(node, state, charge); },
  });
  return { analysis, outcome: collector.collect(analysis), transfers };
}

function firstBudget(from: number, limit: number, predicate: (budget: number) => boolean): number {
  for (let budget = from; budget <= limit; budget += 1) if (predicate(budget)) return budget;
  throw new Error(`no budget in ${from}..${limit} satisfied the predicate`);
}

describe('scan-local flow collector', () => {
  it('never publishes a queued sink that was never executed', () => {
    const build = () => createScanLocalFlowCollector({
      sources: sources({ s1: 'src' }), requests: [{ atom: atom('s1'), sink: 'sink' }],
    });
    const input = (budget: number): WorklistInput => ({
      entry: 'src', graph: graph({ src: ['sink'], sink: [] }), initialState: knownState([atom('s1')]),
      transfer: identity, maxStates: 8, maxOperations: budget,
    });
    // The first budget that commits the pending enqueue and stops before the sink is popped.
    const budget = firstBudget(1, 200, (candidate) => {
      const { analysis } = execute(build, input(candidate));
      return analysis.states.has('sink') && analysis.queuePops === 1;
    });
    const { analysis, outcome, transfers } = execute(build, input(budget));
    expect(analysis.status).toBe('LIMITED');
    expect(transfers).toEqual(['src']);
    // The pending join is visible, but only an executed TRANSFER output is sink authority.
    expect(analysis.states.get('sink')?.atoms).toEqual([atom('s1')]);
    expect(outcome).toMatchObject({
      status: 'LIMITED', composed: true, candidates: [], unpublishedSinks: 1, absentAtSinks: 0, incompleteTransfers: 0,
    });
    expect(outcome.fields).toBe(analysis.states);
  });

  it('publishes an unchanged first transfer, which commit-only publication would miss', () => {
    const build = () => createScanLocalFlowCollector({
      sources: sources({ s1: 'src' }), requests: [{ atom: atom('s1'), sink: 'sink' }],
    });
    const { analysis, outcome } = execute(build, {
      entry: 'src', graph: graph({ src: ['sink'], sink: [] }), initialState: knownState([atom('s1')]),
      transfer: identity, maxStates: 8, maxOperations: 512,
    });
    expect(analysis.status).toBe('COMPLETE');
    expect(outcome).toMatchObject({ status: 'COMPLETE', composed: true, unpublishedSinks: 0, absentAtSinks: 0 });
    expect(outcome.candidates).toHaveLength(1);
    const candidate = outcome.candidates[0]!;
    expect(candidate).toMatchObject({ sourceNode: 'src', sinkNode: 'sink', omittedAtoms: 0, omittedTokens: 0 });
    expect(candidate.sinkState).toEqual(analysis.states.get('sink'));
  });

  it('keeps the executed transfer support when a later pending enqueue adds atoms', () => {
    const build = () => createScanLocalFlowCollector({
      sources: sources({ s1: 'src' }), requests: [{ atom: atom('s1'), sink: 'b_sink' }],
    });
    const input = (budget: number): WorklistInput => ({
      entry: 'a_src', graph: graph({ a_src: ['b_sink', 'c_more'], b_sink: [], c_more: ['b_sink'] }),
      initialState: knownState([atom('s1')]),
      transfer: (node, state) => node === 'c_more' ? knownState([...state.atoms, atom('s2')]) : state,
      maxStates: 8, maxOperations: budget,
    });
    const budget = firstBudget(1, 400, (candidate) =>
      execute(build, input(candidate)).analysis.states.get('b_sink')?.atoms.length === 2);
    const { analysis, outcome } = execute(build, input(budget));
    expect(analysis.queuePops).toBe(3);
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome).toMatchObject({ status: 'LIMITED', unpublishedSinks: 0, absentAtSinks: 0 });
    // The pending join holds s1+s2; the candidate keeps the executed TRANSFER output it really saw.
    expect(outcome.candidates[0]!.sinkState.atoms).toEqual([atom('s1')]);
    expect(outcome.candidates[0]!.sinkState).not.toEqual(analysis.states.get('b_sink'));
  });

  it('removes prior support when the sink is re-executed and the transfer kills the atom', () => {
    const build = () => createScanLocalFlowCollector({
      sources: sources({ s1: 'src' }), requests: [{ atom: atom('s1'), sink: 'sink' }],
    });
    let sinkTransfers = 0;
    const { analysis, outcome } = execute(build, {
      entry: 'src', graph: graph({ src: ['sink', 'zz'], sink: [], zz: ['sink'] }),
      initialState: knownState([atom('s1')]),
      transfer: (node, state) => node === 'zz' ? knownState([...state.atoms, atom('s2')])
        : node === 'sink' && sinkTransfers++ > 0 ? knownState() : state,
      maxStates: 8, maxOperations: 512,
    });
    expect(analysis.queuePops).toBe(4);
    expect(analysis.states.get('sink')?.atoms).toEqual([]);
    expect(outcome).toMatchObject({ status: 'COMPLETE', candidates: [], unpublishedSinks: 0, absentAtSinks: 1 });
  });

  it('never reuses stale support when a newer generation is incomplete', () => {
    const build = () => createScanLocalFlowCollector({
      sources: sources({ s1: 'src' }), requests: [{ atom: atom('s1'), sink: 'sink' }],
    });
    const input = (budget: number): WorklistInput => ({
      entry: 'src', graph: graph({ src: ['sink', 'zz'], sink: [], zz: ['sink'] }),
      initialState: knownState([atom('s1')]),
      transfer: (node, state) => node === 'zz' ? knownState([...state.atoms, atom('s2')]) : state,
      maxStates: 8, maxOperations: budget,
    });
    const supported = firstBudget(1, 400, (candidate) =>
      execute(build, input(candidate)).outcome.candidates.length === 1);
    // The first refused generation after support exists: the second sink pop through the zz fan-in.
    const refused = firstBudget(supported, 400, (candidate) =>
      execute(build, input(candidate)).outcome.incompleteTransfers === 1);
    expect(refused).toBeGreaterThan(supported);
    const before = execute(build, input(refused - 1)).outcome;
    expect(before.incompleteTransfers).toBe(0);
    expect(before.candidates).toHaveLength(1);
    const { analysis, outcome } = execute(build, input(refused));
    expect(analysis.status).toBe('LIMITED');
    expect(analysis.queuePops).toBe(4);
    expect(outcome).toMatchObject({
      status: 'LIMITED', candidates: [], unpublishedSinks: 1, absentAtSinks: 0, incompleteTransfers: 1,
    });
  });

  it('retains a valid atom in an UNKNOWN executed sink with exact omissions', () => {
    const build = () => createScanLocalFlowCollector({
      sources: sources({ s1: 'src' }), requests: [{ atom: atom('s1'), sink: 'sink' }],
    });
    const { analysis, outcome } = execute(build, {
      entry: 'src', graph: graph({ src: ['sink'], sink: [] }), initialState: knownState([atom('s1')]),
      transfer: (node, state) => node === 'sink' ? knownState([...state.atoms, deepAtom]) : state,
      maxStates: 8, maxOperations: 512,
    });
    expect(analysis.status).toBe('LIMITED');
    expect(outcome.candidates).toHaveLength(1);
    const candidate = outcome.candidates[0]!;
    expect(candidate.sinkState.knowledge).toBe('UNKNOWN');
    expect(candidate.sinkState.unknownReasons).toContain('PAYLOAD_LIMIT');
    expect(candidate.sinkState.atoms).toEqual([atom('s1')]);
    expect(candidate.sinkState.sanitizedFor).toEqual([]);
    expect(candidate).toMatchObject({ omittedAtoms: 1, omittedTokens: 0 });
    expect(outcome.omittedAtomsByKind).toEqual({ seed: 0, transfer: 1, enqueue: 0 });
  });

  it('keeps seed and enqueue omissions out of sink support', () => {
    const build = () => createScanLocalFlowCollector({
      sources: sources({ s1: 'src' }), requests: [{ atom: atom('s1'), sink: 'sink' }],
    });
    const { outcome } = execute(build, {
      entry: 'src', graph: graph({ src: ['sink'], sink: [] }),
      initialState: knownState([atom('s1'), deepAtom]),
      transfer: identity, maxStates: 8, maxOperations: 512,
    });
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0]!.omittedAtoms).toBe(0);
    expect(outcome.omittedAtomsByKind).toEqual({ seed: 1, transfer: 0, enqueue: 0 });
    expect(outcome.omittedTokensByKind).toEqual({ seed: 0, transfer: 0, enqueue: 0 });
    expect(outcome.omittedAtoms).toBe(1);
  });

  it('never supports a same-node sink from the seed alone', () => {
    const build = () => createScanLocalFlowCollector({
      sources: sources({ s1: 'src' }), requests: [{ atom: atom('s1'), sink: 'src' }],
    });
    const seedOnly = execute(build, {
      entry: 'src', graph: graph({ src: [] }), initialState: knownState([atom('s1')]),
      transfer: identity, maxStates: 4, maxOperations: 5,
    });
    expect(seedOnly.analysis.queuePops).toBe(0);
    expect(seedOnly.outcome.candidates).toEqual([]);
    expect(seedOnly.outcome.unpublishedSinks).toBe(1);
    const executed = execute(build, {
      entry: 'src', graph: graph({ src: [] }), initialState: knownState([atom('s1')]),
      transfer: identity, maxStates: 4, maxOperations: 512,
    });
    expect(executed.outcome.candidates).toHaveLength(1);
    expect(executed.outcome.candidates[0]).toMatchObject({ sourceNode: 'src', sinkNode: 'src' });
  });

  it('canonicalizes requests once: dedupe, ordinal order and distinct channels', () => {
    const requests = [
      { atom: atom('s2', 'INTEGRITY'), sink: 'sink' },
      { atom: atom('s1', 'CONFIDENTIALITY'), sink: 'sink' },
      { atom: atom('s1', 'CONFIDENTIALITY'), sink: 'sink' },
      { atom: atom('s1', 'INTEGRITY'), sink: 'sink' },
      { atom: atom('s1', 'CONTROL'), sink: 'sink' },
      { atom: atom('s1', 'CONFIDENTIALITY', ['a'.repeat(SCAN_LOCAL_LIMITS_V1.maxSegmentBytes + 1)]), sink: 'sink' },
      { atom: atom('unmapped', 'CONFIDENTIALITY'), sink: 'sink' },
    ];
    const build = (list: readonly { atom: TaintAtomV1; sink: string }[]) => () =>
      createScanLocalFlowCollector({ sources: sources({ s1: 'src', s2: 'src' }), requests: list });
    const input: WorklistInput = {
      entry: 'src', graph: graph({ src: ['sink'], sink: [] }),
      initialState: knownState([atom('s1', 'CONFIDENTIALITY'), atom('s1', 'INTEGRITY'), atom('s2', 'INTEGRITY')]),
      transfer: identity, maxStates: 8, maxOperations: 800,
    };
    const canonical = (list: readonly { atom: TaintAtomV1; sink: string }[]) => {
      const { outcome } = execute(build(list), input);
      return {
        seen: outcome.candidates.map((candidate) => [candidate.atom.channel, candidate.atom.sourceId, candidate.sinkNode]),
        invalidRequests: outcome.invalidRequests,
        unmappedSources: outcome.unmappedSources,
      };
    };
    const first = canonical(requests);
    expect(first.seen).toEqual([
      ['CONFIDENTIALITY', 's1', 'sink'],
      ['INTEGRITY', 's1', 'sink'],
      ['INTEGRITY', 's2', 'sink'],
    ]);
    expect(first).toMatchObject({ invalidRequests: 2, unmappedSources: 1 });
    const shuffled = [requests[4]!, requests[2]!, requests[6]!, requests[1]!, requests[5]!, requests[3]!, requests[0]!];
    expect(canonical(shuffled)).toEqual(first);
  });

  it('reports status LIMITED when requests contain unmapped sources', () => {
    const build = () => createScanLocalFlowCollector({
      sources: new Map(),
      requests: [{ atom: atom('missing-origin'), sink: 'sink' }],
    });
    const input: WorklistInput = {
      entry: 'src', graph: graph({ src: ['sink'], sink: [] }),
      initialState: knownState([atom('missing-origin')]),
      transfer: identity, maxStates: 8, maxOperations: 800,
    };
    const { analysis, outcome } = execute(build, input);
    expect(analysis.status).toBe('COMPLETE');
    expect(outcome.unmappedSources).toBe(1);
    expect(outcome.status).toBe('LIMITED');
  });

  it('reports status LIMITED when requested sinks are unreachable and unpublished', () => {
    const build = () => createScanLocalFlowCollector({
      sources: sources({ s1: 'src' }),
      requests: [{ atom: atom('s1'), sink: 'sink' }],
    });
    const input: WorklistInput = {
      entry: 'src', graph: graph({ src: [], sink: [] }),
      initialState: knownState([atom('s1')]),
      transfer: identity, maxStates: 8, maxOperations: 800,
    };
    const { analysis, outcome } = execute(build, input);
    expect(analysis.status).toBe('COMPLETE');
    expect(outcome.unpublishedSinks).toBe(1);
    expect(outcome.status).toBe('LIMITED');
  });

  it('reports status LIMITED when requests are invalid', () => {
    const build = () => createScanLocalFlowCollector({
      sources: sources({ s1: 'src' }),
      requests: [{ atom: atom('s1'), sink: '' }],
    });
    const input: WorklistInput = {
      entry: 'src', graph: graph({ src: [] }),
      initialState: knownState([atom('s1')]),
      transfer: identity, maxStates: 8, maxOperations: 800,
    };
    const { analysis, outcome } = execute(build, input);
    expect(analysis.status).toBe('COMPLETE');
    expect(outcome.invalidRequests).toBe(1);
    expect(outcome.status).toBe('LIMITED');
  });
});
