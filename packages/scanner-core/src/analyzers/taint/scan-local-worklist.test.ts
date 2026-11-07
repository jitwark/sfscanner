import { describe, expect, it } from 'vitest';
import {
  SCAN_LOCAL_LIMITS_V1, isValidFieldPath, knownState, unknownState,
  type FieldStateV1, type TaintAtomV1,
} from './scan-local-state';
import { runScanLocalWorklist } from './scan-local-worklist';

const graph = (entries: Record<string, readonly string[]>) => new Map(Object.entries(entries));
const atom = (sourceId: string): TaintAtomV1 => ({ sourceId, field: ['body'], channel: 'CONFIDENTIALITY' });
const add = (sourceId: string) => (state: FieldStateV1) => ({ ...state, atoms: [...state.atoms, atom(sourceId)] });

/** KNOWN state whose atom array counts every length/index read the worklist performs. */
const countedAtoms = (count: number) => {
  const counted = { reads: 0 };
  const array = Array.from({ length: count }, (_, index) => atom(`s${index}`));
  const atoms = new Proxy(array, {
    get(target, property, receiver) {
      if (property === 'length' || (typeof property === 'string' && /^\d+$/.test(property))) counted.reads += 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const state = Object.freeze({
    knowledge: 'KNOWN' as const, atoms, unknownReasons: [] as readonly [],
    sanitizedFor: [] as readonly [], omittedSanitizers: 0,
  });
  return { counted, state: state as unknown as FieldStateV1 };
};

describe('scan-local worklist', () => {
  it('propagates a linear flow and converges a cycle', () => {
    const linear = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'], b: ['c'], c: [] }), initialState: knownState(),
      transfer: (node, state) => node === 'a' ? add('source')(state) : state, maxStates: 10,
    });
    expect(linear.status).toBe('COMPLETE');
    expect(linear.states.get('c')?.atoms).toHaveLength(1);

    const cycle = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'], b: ['a'] }), initialState: knownState(),
      transfer: (node, state) => node === 'a' ? add('source')(state) : state, maxStates: 10,
    });
    expect(cycle.status).toBe('COMPLETE');
    expect(cycle.queuePops).toBeLessThan(10);
  });

  it('joins a diamond and is deterministic under shuffled adjacency', () => {
    const run = (adjacency: Record<string, readonly string[]>) => runScanLocalWorklist({
      entry: 'a', graph: graph(adjacency), initialState: knownState(),
      transfer: (node, state) => node === 'b' ? add('left')(state) : node === 'c' ? add('right')(state) : state,
      maxStates: 10, maxOperations: 160,
    });
    const first = run({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] });
    const second = run({ a: ['c', 'b'], c: ['d'], b: ['d'], d: [] });
    expect(first.status).toBe('COMPLETE');
    expect([...first.states.get('d')!.atoms].map(({ sourceId }) => sourceId).sort()).toEqual(['left', 'right']);
    expect(second.states.get('d')).toEqual(first.states.get('d'));
  });

  it('publishes a read-only map view and bounds a divergent self-loop', () => {
    const linear = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: [] }), initialState: knownState(),
      transfer: (_node, state) => state, maxStates: 10,
    });
    expect(() => (linear.states as Map<string, FieldStateV1>).set('x', knownState())).toThrow(TypeError);
    expect(linear.states.get('a')).toBeDefined();

    let visit = 0;
    const divergent = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'], b: ['a'] }), initialState: knownState(),
      transfer: (_node, state) => add(`s${visit++}`)(state), maxStates: 10, maxOperations: 12,
    });
    expect(divergent).toMatchObject({ status: 'LIMITED' });
    expect(divergent.omitted).toBeGreaterThan(0);
  });

  it('refuses before invoking a transfer that the operation cap cannot cover', () => {
    let transfers = 0;
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: [] }), initialState: knownState(),
      transfer: (_node, state) => { transfers += 1; return state; }, maxStates: 10, maxOperations: 5,
    });
    expect(result).toMatchObject({ status: 'LIMITED' });
    expect(result.omitted).toBeGreaterThan(0);
    expect(transfers).toBe(0);
    expect(result.states.get('a')).toEqual(knownState());
  });

  it('omits an over-depth initial atom and never publishes it', () => {
    const deep = {
      sourceId: 'deep', channel: 'CONFIDENTIALITY' as const,
      field: Array.from({ length: SCAN_LOCAL_LIMITS_V1.maxPathDepth + 1 }, (_, index) => `s${index}`),
    };
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: [] }), initialState: knownState([deep]),
      transfer: (_node, state) => state, maxStates: 10,
    });
    expect(result).toMatchObject({ status: 'LIMITED' });
    expect(result.omitted).toBeGreaterThan(0);
    expect([...result.states.values()].flatMap((state) => state.atoms)
      .some((invalid) => !isValidFieldPath(invalid.field))).toBe(false);
  });

  it('publishes only an UNKNOWN/PAYLOAD_LIMIT seed when the initial bound is unaffordable', () => {
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: [] }), initialState: knownState(Array.from({ length: 100 }, (_, index) => atom(`s${index}`))),
      transfer: (_node, state) => state, maxStates: 10, maxOperations: 4,
    });
    expect(result).toMatchObject({ status: 'LIMITED' });
    expect(result.omitted).toBeGreaterThan(0);
    expect(result.states.get('a')).toMatchObject({ knowledge: 'UNKNOWN', atoms: [], unknownReasons: ['PAYLOAD_LIMIT'] });
    expect([...result.states.values()].some((state) => state.knowledge === 'KNOWN' && state.atoms.length > 0)).toBe(false);
  });

  it('charges the initial bound and refuses a thousand-atom seed within eight operations', () => {
    const seeded = countedAtoms(1_000);
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: [] }), initialState: seeded.state,
      transfer: (_node, state) => state, maxStates: 10, maxOperations: 8,
    });
    expect(seeded.counted.reads).toBeLessThanOrEqual(8);
    expect(result).toMatchObject({ status: 'LIMITED' });
    expect(result.omitted).toBeGreaterThan(0);
    expect(result.states.get('a')).toMatchObject({ knowledge: 'UNKNOWN', atoms: [], unknownReasons: ['PAYLOAD_LIMIT'] });
  });

  it('retains prior complete state when a transfer result cannot be bounded', () => {
    const flood = Array.from({ length: 200 }, (_, index) => atom(`s${index}`));
    const initial = knownState([atom('a'), atom('b')]);
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'], b: [] }), initialState: initial,
      transfer: (node, state) => node === 'a' ? { ...state, atoms: flood } : state, maxStates: 10, maxOperations: 20,
    });
    expect(result).toMatchObject({ status: 'LIMITED' });
    expect(result.omitted).toBeGreaterThan(0);
    expect(result.states.get('a')).toEqual(initial);
    expect(result.states.has('b')).toBe(false);
  });

  it('bounds adjacency property reads after proving the adjacency phase is reached', () => {
    let reads = 0;
    const targets = new Proxy(Array.from({ length: 1_000 }, (_, index) => `n${index}`), {
      get(target, property, receiver) {
        if (property === 'length' || (typeof property === 'string' && /^\d+$/.test(property))) reads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: targets }), initialState: knownState(),
      transfer: (_node, state) => state, maxStates: 10, maxOperations: 20,
    });
    expect(result).toMatchObject({ status: 'LIMITED' });
    expect(result.omitted).toBeGreaterThan(0);
    expect(reads).toBe(1);
    expect(reads).toBeLessThan(10);
  });

  it('returns LIMITED at the state cap after committing and enqueuing', () => {
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'], b: ['c'], c: [] }), initialState: knownState(),
      transfer: () => unknownState('UNMODELLED_TRANSFER'), maxStates: 1, maxOperations: 64,
    });
    // The state cap, not an operation refusal: a's UNKNOWN state committed and b was enqueued before refusal.
    expect(result).toMatchObject({ status: 'LIMITED', queuePops: 1 });
    expect(result.states.size).toBe(1);
    expect(result.states.get('a')).toMatchObject({ knowledge: 'UNKNOWN', unknownReasons: ['UNMODELLED_TRANSFER'] });
    expect(result.omitted).toBe(2);
  });

  it('charges transfers against existing work and latches refusal despite a clean callback return', () => {
    const initial = knownState([atom('source')]);
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'], b: [] }), initialState: initial,
      transfer: (_node, _state, charge) => {
        expect(charge(32)).toBe(false);
        expect(charge(0)).toBe(false);
        return knownState();
      },
      maxStates: 10, maxOperations: 32,
    });
    expect(result.status).toBe('LIMITED');
    expect(result.states.get('a')).toEqual(initial);
    expect(result.states.has('b')).toBe(false);
    expect(result.omitted).toBeGreaterThan(0);
  });

  it('allows a paid transfer to propagate supported provenance', () => {
    const initial = knownState([atom('source')]);
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'], b: [] }), initialState: initial,
      transfer: (_node, state, charge) => {
        expect(charge(1)).toBe(true);
        return state;
      },
      maxStates: 10, maxOperations: 128,
    });
    expect(result.status).toBe('COMPLETE');
    expect(result.states.get('b')?.atoms).toEqual(initial.atoms);
    expect(result.omitted).toBe(0);
  });

  it('records only paid supported transitions and finishes after the fixed point', () => {
    const events: string[] = [];
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'] }), initialState: knownState([atom('source')]),
      transfer: (_node, state) => state, maxStates: 4, maxOperations: 512,
      observe: (event, charge) => {
        if (!charge(1)) return;
        events.push(event.kind === 'TRANSFER' ? event.node : `${event.from}->${event.to}`);
      },
      finish: (charge) => { if (charge(1)) events.push('finished'); return 0; },
    });
    expect(result.status).toBe('COMPLETE');
    expect(events).toEqual(['a', 'a->b', 'b', 'finished']);
  });

  it('latches refused witness work before propagating a clean callback return', () => {
    const initial = knownState([atom('source')]);
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'] }), initialState: initial,
      transfer: (_node, state) => state, maxStates: 4, maxOperations: 128,
      observe: (_event, charge) => { expect(charge(129)).toBe(false); expect(charge(0)).toBe(false); },
    });
    expect(result.status).toBe('LIMITED');
    expect(result.states.has('b')).toBe(false);
    expect(result.states.get('a')?.atoms).toEqual(initial.atoms);
  });

  it('respects shared external charge across multiple worklists', () => {
    let budget = 100;
    const charge = (units: number) => {
      if (units > budget) return false;
      budget -= units;
      return true;
    };
    const first = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'], b: ['c'], c: [] }), initialState: knownState(),
      transfer: (_node, state) => state, maxStates: 10, charge,
    });
    expect(first.status).toBe('COMPLETE');
    expect(budget).toBeLessThan(100);
    budget = 0;
    const second = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'], b: ['c'], c: [] }), initialState: knownState(),
      transfer: (_node, state) => state, maxStates: 10, charge,
    });
    expect(second.status).toBe('LIMITED');
  });
});
