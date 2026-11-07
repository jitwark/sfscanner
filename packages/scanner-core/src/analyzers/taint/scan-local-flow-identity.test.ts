import { describe, expect, it } from 'vitest';
import {
  joinFieldStates, knownState, sanitizeFieldState, type FieldStateV1, type TaintAtomV1,
} from './scan-local-state';
import { createScanLocalFlowCollector, type ScanLocalFlowCollectorV1 } from './scan-local-flows';
import {
  getScanLocalRunToken, runScanLocalWorklist, type ScanLocalWorklistInputV1,
} from './scan-local-worklist';

const graph = (entries: Record<string, readonly string[]>) => new Map(Object.entries(entries));
const atom = (field: readonly string[] = ['body'], sourceId = 's1'): TaintAtomV1 =>
  Object.freeze({ sourceId, channel: 'CONFIDENTIALITY', field: Object.freeze([...field]) });
const identity = (_node: string, state: FieldStateV1) => state;
type WorklistInput = Omit<ScanLocalWorklistInputV1, 'publish'>;

const input = (overrides: Partial<WorklistInput> = {}): WorklistInput => ({
  entry: 'src', graph: graph({ src: ['sink'], sink: [] }), initialState: knownState([atom()]),
  transfer: identity, maxStates: 8, maxOperations: 512, ...overrides,
});
const collectorFor = (
  requests: readonly Readonly<{ atom: TaintAtomV1; sink: string }>[],
): ScanLocalFlowCollectorV1 => createScanLocalFlowCollector({ sources: new Map([['s1', 'src']]), requests });
const analyse = (collector: ScanLocalFlowCollectorV1, overrides: Partial<WorklistInput> = {}) =>
  runScanLocalWorklist({ ...input(overrides), publish: collector.publish });

describe('scan-local flow identity', () => {
  it('keeps structurally distinct field layouts apart in native dedupe, joins and tokens', () => {
    const layouts: readonly (readonly string[])[] = [['a', 'b'], ['a\u0000b'], [], ['']];
    const state = knownState(layouts.map((field) => atom(field)));
    expect(state.atoms).toHaveLength(layouts.length);
    expect(state.atoms.map((entry) => [...entry.field]))
      .toEqual(expect.arrayContaining(layouts.map((layout) => [...layout])));
    const joined = joinFieldStates(knownState([atom(['a', 'b'])]), knownState([atom(['a\u0000b'])]), () => true);
    expect(joined.status === 'JOINED' ? joined.state.atoms : []).toHaveLength(2);
    // Tokens stay publicly unchanged, but their identity is no longer a lossy join either.
    const first = sanitizeFieldState(knownState(), { modelId: 'm\u0000x', sink: 's', pathDigest: 'p' });
    const second = sanitizeFieldState(first, { modelId: 'm', sink: 'x\u0000s', pathDigest: 'p' });
    expect(second.sanitizedFor).toHaveLength(2);
  });

  it('commits a changed field layout and never matches the old layout at the sink', () => {
    const requested = ['a', 'b'];
    const actual = ['a\u0000b'];
    const transform = (node: string, state: FieldStateV1): FieldStateV1 =>
      node === 'src' ? knownState([atom(actual)]) : state;
    const stale = collectorFor([{ atom: atom(requested), sink: 'sink' }]);
    const analysis = analyse(stale, { transfer: transform });
    expect(analysis.states.get('sink')?.atoms.map((entry) => entry.field)).toEqual([actual]);
    expect([...analysis.states.values()].flatMap((entry) => entry.atoms)
      .some((entry) => entry.field.length === requested.length)).toBe(false);
    const outcome = stale.collect(analysis);
    expect(outcome.candidates).toEqual([]);
    expect(outcome).toMatchObject({ absentAtSinks: 1, unpublishedSinks: 0 });
    const fresh = collectorFor([{ atom: atom(actual), sink: 'sink' }]);
    const matched = fresh.collect(analyse(fresh, { transfer: transform }));
    expect(matched.candidates.map((candidate) => candidate.sinkNode)).toEqual(['sink']);
    expect(matched.candidates[0]!.atom.field).toEqual(actual);
  });

  it('orders collating-equal ids by code units in states and candidates', () => {
    const nfc = '\u00e9';
    const nfd = 'e\u0301';
    expect(nfc.localeCompare(nfd, 'en')).toBe(0);
    const run = (targets: readonly string[]) => {
      const collector = collectorFor([{ atom: atom(), sink: nfc }, { atom: atom(), sink: nfd }]);
      const analysis = analyse(collector, { graph: graph({ src: [...targets], [nfc]: [], [nfd]: [] }) });
      return {
        keys: [...analysis.states.keys()],
        sinks: collector.collect(analysis).candidates.map((candidate) => candidate.sinkNode),
      };
    };
    const first = run([nfc, nfd]);
    expect(first).toEqual({ keys: [nfd, 'src', nfc], sinks: [nfd, nfc] });
    expect(run([nfd, nfc])).toEqual(first);
    expect(run([nfd, nfc, nfd])).toEqual(first);
  });

  it('refuses an analysis from another run and a publication after collection', () => {
    const own = collectorFor([{ atom: atom(), sink: 'sink' }]);
    const foreign = analyse(collectorFor([{ atom: atom(), sink: 'sink' }]));
    const analysis = analyse(own);
    const outcome = own.collect(analysis);
    expect(own.collect(analysis)).toBe(outcome);
    expect(() => own.collect(foreign)).toThrow(TypeError);
    expect(() => collectorFor([{ atom: atom(), sink: 'sink' }]).collect(runScanLocalWorklist(input())))
      .toThrow(TypeError);
    expect(() => analyse(own)).toThrow(TypeError);
  });

  it('binds a limited run that stopped before its first publication', () => {
    const collector = collectorFor([{ atom: atom(), sink: 'sink' }]);
    const analysis = analyse(collector, { maxOperations: 1 });
    expect(analysis).toMatchObject({ status: 'LIMITED', queuePops: 0 });
    expect(getScanLocalRunToken(analysis)).toBeDefined();
    expect(collector.collect(analysis)).toMatchObject({
      status: 'LIMITED', composed: true, candidates: [], unpublishedSinks: 1,
    });
    expect(() => analyse(collector)).toThrow(TypeError);
  });

  it('binds the token carried by a wrapped publication and never allocates one without a hook', () => {
    const collector = collectorFor([{ atom: atom(), sink: 'sink' }]);
    const tokens = new Set<object>();
    const analysis = runScanLocalWorklist({
      ...input(),
      publish: (publication, charge) => {
        tokens.add(publication.runToken);
        collector.publish(publication, charge);
      },
    });
    expect(tokens.size).toBe(1);
    expect(getScanLocalRunToken(analysis)).toBe([...tokens][0]);
    expect(collector.collect(analysis).candidates).toHaveLength(1);
    expect(getScanLocalRunToken(runScanLocalWorklist(input()))).toBeUndefined();
  });
});
