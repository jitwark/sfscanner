import { describe, expect, it } from 'vitest';
import { knownState, type FieldStateV1, type TaintAtomV1 } from './scan-local-state';
import {
  createScanLocalFlowCollector, type ScanLocalFlowCollectorV1, type ScanLocalFlowOutcomeV1,
} from './scan-local-flows';
import {
  runScanLocalWorklist, type ScanLocalWorklistInputV1, type ScanLocalWorklistResultV1,
} from './scan-local-worklist';

const graph = (entries: Record<string, readonly string[]>) => new Map(Object.entries(entries));
const sources = (entries: Record<string, string>) => new Map(Object.entries(entries));
const atom = (sourceId: string): TaintAtomV1 =>
  Object.freeze({ sourceId, channel: 'CONFIDENTIALITY', field: Object.freeze(['body']) });
const identity = (_node: string, state: FieldStateV1) => state;

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

describe('scan-local flow collector budget', () => {
  it('prepays exactly one projection from the shared budget', () => {
    const build = () => createScanLocalFlowCollector({
      sources: sources({ s1: 'src' }), requests: [{ atom: atom('s1'), sink: 'sink' }],
    });
    const input = (budget: number): WorklistInput => ({
      entry: 'src', graph: graph({ src: ['sink'], sink: [] }), initialState: knownState([atom('s1')]),
      transfer: identity, maxStates: 8, maxOperations: budget,
    });
    const refused = firstBudget(1, 300, (budget) => !execute(build, input(budget)).outcome.composed);
    expect(execute(build, input(refused)).outcome).toMatchObject({
      status: 'LIMITED', composed: false, candidates: [], unpublishedSinks: 1, incompleteTransfers: 1,
    });
    // The composition charge is 1 + 3R for one canonical request and is paid once, before any candidate.
    const paid = firstBudget(refused, 400, (budget) => execute(build, input(budget)).outcome.composed);
    expect(paid).toBe(refused + 4);
    expect(execute(build, input(paid)).outcome).toMatchObject({
      status: 'LIMITED', composed: true, candidates: [], incompleteTransfers: 1,
    });
    const projected = firstBudget(paid, 400, (budget) => execute(build, input(budget)).outcome.candidates.length === 1);
    expect(projected).toBeGreaterThan(paid);
    expect(execute(build, input(projected)).outcome).toMatchObject({ composed: true, unpublishedSinks: 0 });
  });

  it('stops downstream execution when the shared budget refuses the publication', () => {
    const build = () => createScanLocalFlowCollector({
      sources: sources({ s1: 'src' }), requests: [{ atom: atom('s1'), sink: 'src' }],
    });
    const input = (budget: number): WorklistInput => ({
      entry: 'src', graph: graph({ src: ['downstream'], downstream: [] }), initialState: knownState([atom('s1')]),
      transfer: identity, maxStates: 8, maxOperations: budget,
    });
    const refused = firstBudget(1, 200, (budget) =>
      execute(build, input(budget)).outcome.incompleteTransfers === 1);
    const { analysis, outcome, transfers } = execute(build, input(refused));
    expect(analysis.status).toBe('LIMITED');
    expect(transfers).toEqual(['src']);
    expect(outcome).toMatchObject({
      status: 'LIMITED', composed: false, candidates: [], unpublishedSinks: 1, incompleteTransfers: 1,
    });
    const executed = execute(build, input(512));
    expect(executed.transfers).toEqual(['src', 'downstream']);
    expect(executed.outcome.candidates).toHaveLength(1);
  });

  it.each([
    { requested: ['a', 'b'], actual: ['a\u0000b'] },
    { requested: [], actual: [''] },
  ])('does not publish a different field layout after paid support lookup: $requested', ({ requested, actual }) => {
    const build = () => createScanLocalFlowCollector({
      sources: sources({ s1: 'src' }), requests: [{ atom: { ...atom('s1'), field: requested }, sink: 'sink' }],
    });
    const { analysis, outcome } = execute(build, {
      entry: 'src', graph: graph({ src: ['sink'], sink: [] }),
      initialState: knownState([{ ...atom('s1'), field: actual }]),
      transfer: identity, maxStates: 8, maxOperations: 512,
    });
    expect(analysis.states.get('sink')?.atoms.map((entry) => entry.field)).toEqual([actual]);
    expect(outcome.candidates).toEqual([]);
    expect(outcome.absentAtSinks).toBe(1);
  });
});
