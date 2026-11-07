import { describe, expect, it } from 'vitest';
import {
  SCAN_LOCAL_LIMITS_V1, knownState, type TaintAtomV1,
} from './scan-local-state';
import { runScanLocalWorklist, type ScanLocalPublishV1 } from './scan-local-worklist';

const graph = (entries: Record<string, readonly string[]>) => new Map(Object.entries(entries));
const atom = (sourceId: string): TaintAtomV1 => ({ sourceId, field: ['body'], channel: 'CONFIDENTIALITY' });

describe('scan-local worklist publication', () => {
  it('publishes SEED, executed TRANSFER and ENQUEUE values before they are committed', () => {
    const published: string[] = [];
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'] }), initialState: knownState([atom('source')]),
      transfer: (_node, state) => state, maxStates: 4, maxOperations: 512,
      publish: (publication, charge) => {
        expect(charge(1)).toBe(true);
        published.push(`${publication.kind} ${publication.node}`);
      },
    });
    expect(result.status).toBe('COMPLETE');
    expect(published).toEqual(['SEED a', 'TRANSFER a', 'ENQUEUE b', 'TRANSFER b']);
  });

  it('carries the exact bound omissions of each publication', () => {
    const published: string[] = [];
    const deep = {
      sourceId: 'deep', channel: 'CONFIDENTIALITY' as const,
      field: Array.from({ length: SCAN_LOCAL_LIMITS_V1.maxPathDepth + 1 }, (_, index) => `s${index}`),
    };
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'], b: [] }), initialState: knownState([atom('source'), deep]),
      transfer: (_node, state) => state, maxStates: 4, maxOperations: 512,
      publish: (publication) => published.push(
        `${publication.kind} ${publication.node} ${publication.omittedAtoms}/${publication.omittedTokens}`),
    });
    expect(published).toEqual(['SEED a 1/0', 'TRANSFER a 0/0', 'ENQUEUE b 0/0', 'TRANSFER b 0/0']);
    expect(result.status).toBe('LIMITED');
    expect(result.states.get('a')).toMatchObject({ knowledge: 'UNKNOWN', unknownReasons: ['PAYLOAD_LIMIT'] });
  });

  it('refuses a SEED publication before committing the seed', () => {
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: [] }), initialState: knownState([atom('source')]),
      transfer: (_node, state) => state, maxStates: 4, maxOperations: 64,
      publish: (_publication, charge) => { charge(64); },
    });
    expect(result.status).toBe('LIMITED');
    expect(result.queuePops).toBe(0);
    expect(result.states.get('a')).toMatchObject({ knowledge: 'UNKNOWN', atoms: [], unknownReasons: ['PAYLOAD_LIMIT'] });
  });

  it('refuses a TRANSFER publication before the witness, commit and propagation', () => {
    const events: string[] = [];
    const initial = knownState([atom('source')]);
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'], b: [] }), initialState: initial,
      transfer: (node, state) => node === 'a' ? knownState() : state,
      maxStates: 4, maxOperations: 128,
      publish: (publication, charge) => { if (publication.kind === 'TRANSFER') charge(128); },
      observe: (event) => { events.push(event.kind); },
    });
    expect(result.status).toBe('LIMITED');
    expect(result.states.get('a')).toEqual(initial);
    expect(result.states.has('b')).toBe(false);
    expect(events).toEqual([]);
  });

  it('refuses an ENQUEUE publication without committing or queueing the target', () => {
    const result = runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'], b: [] }), initialState: knownState([atom('source')]),
      transfer: (_node, state) => state, maxStates: 4, maxOperations: 256,
      publish: (publication, charge) => { if (publication.kind === 'ENQUEUE') charge(256); },
    });
    expect(result.status).toBe('LIMITED');
    expect(result.states.has('b')).toBe(false);
    expect(result.states.get('a')?.atoms).toHaveLength(1);
  });

  it('leaves admitted states and results unchanged when a publication hook accepts', () => {
    const run = (publish?: ScanLocalPublishV1) => runScanLocalWorklist({
      entry: 'a', graph: graph({ a: ['b'], b: ['a'] }), initialState: knownState([atom('source')]),
      transfer: (_node, state) => state, maxStates: 4, maxOperations: 512,
      ...(publish === undefined ? {} : { publish }),
    });
    const without = run();
    const withHook = run(() => {});
    expect(without).toMatchObject({ status: 'COMPLETE', omitted: 0 });
    expect(withHook.status).toBe('COMPLETE');
    expect([...withHook.states.entries()]).toEqual([...without.states.entries()]);
  });
});
