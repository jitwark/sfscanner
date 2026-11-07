import { describe, expect, it } from 'vitest';
import { createScanLocalTransfer, type FieldTransferModelV1 } from './scan-local-transfer';
import { runScanLocalWorklist } from './scan-local-worklist';
import { knownState, unknownState, type FieldStateV1 } from './scan-local-state';

const atom = { sourceId: 'origin', field: ['body', 'cmd'], channel: 'INTEGRITY' as const };
const tainted = knownState([atom]);
function transfer(model: FieldTransferModelV1 | undefined, state: FieldStateV1 = tainted) {
  const models = new Map<string, FieldTransferModelV1>(model ? [['field', model]] : []);
  return createScanLocalTransfer(models)('field', state, () => true);
}
const sanitizer = (callee: string, sink: 'HEADER' | 'SQL' | 'HTML' = 'HEADER', path: readonly string[] = ['value']): FieldTransferModelV1 => ({
  kind: 'SANITIZE', calleesOutermostFirst: [callee], binding: 'REVIEWED', sink, path,
});

describe('finite reviewed field transfer', () => {
  it('generates origin atoms while preserving incoming provenance', () => {
    const result = transfer({ kind: 'SOURCE', sourceId: 'other', field: ['query'], channel: 'CONFIDENTIALITY' });
    expect(result.knowledge).toBe('KNOWN');
    expect(result.atoms).toEqual(expect.arrayContaining([atom, { sourceId: 'other', field: ['query'], channel: 'CONFIDENTIALITY' }]));
  });


  it('keeps the reserved CONTROL channel unmodelled instead of generating a false reviewed source', () => {
    const result = transfer({ kind: 'SOURCE', sourceId: 'reserved', field: ['body'], channel: 'CONTROL' });
    expect(result).toMatchObject({ knowledge: 'UNKNOWN', atoms: [atom], unknownReasons: ['UNMODELLED_SOURCE'] });
  });
  it('distinguishes a reviewed literal from absent or dynamic models', () => {
    expect(transfer({ kind: 'EXACT_LITERAL' }, unknownState('DYNAMIC_FIELD'))).toMatchObject({ knowledge: 'KNOWN', atoms: [], unknownReasons: [] });
    expect(transfer(undefined)).toMatchObject({ knowledge: 'UNKNOWN', atoms: [atom], unknownReasons: ['UNMODELLED_TRANSFER'] });
    expect(transfer({ kind: 'UNKNOWN', reason: 'DYNAMIC_FIELD' })).toMatchObject({ knowledge: 'UNKNOWN', atoms: [atom], unknownReasons: ['DYNAMIC_FIELD'] });
  });

  it('overwrites only the selected field and preserves an independent carrier', () => {
    const models = new Map<string, FieldTransferModelV1>([
      ['entry', { kind: 'COPY' }], ['same-node/literal', { kind: 'EXACT_LITERAL' }], ['same-node/other', { kind: 'COPY' }],
    ]);
    const result = runScanLocalWorklist({
      entry: 'entry', graph: new Map([['entry', ['same-node/other', 'same-node/literal']]]),
      initialState: tainted, transfer: createScanLocalTransfer(models), maxStates: 10, maxOperations: 2000,
    });
    expect(result.status).toBe('COMPLETE');
    expect(result.states.get('same-node/literal')).toMatchObject({ knowledge: 'KNOWN', atoms: [] });
    expect(result.states.get('same-node/other')?.atoms).toEqual([atom]);
  });

  it('joins reviewed merge inputs and converges a cycle under adjacency reordering', () => {
    const models = new Map<string, FieldTransferModelV1>([
      ['root', { kind: 'COPY' }],
      ['left', { kind: 'SOURCE', sourceId: 'left', field: ['a'], channel: 'INTEGRITY' }],
      ['right', { kind: 'SOURCE', sourceId: 'right', field: ['b'], channel: 'INTEGRITY' }],
      ['sink', { kind: 'MERGE' }],
    ]);
    const run = (branches: readonly string[]) => runScanLocalWorklist({
      entry: 'root', graph: new Map([['root', branches], ['left', ['sink']], ['right', ['sink']], ['sink', ['left']]]),
      initialState: knownState(), transfer: createScanLocalTransfer(models), maxStates: 10, maxOperations: 10000,
    });
    const first = run(['left', 'right']);
    const reordered = run(['right', 'left']);
    expect(first.status).toBe('COMPLETE');
    expect(first.states.get('sink')?.atoms.map((value) => value.sourceId)).toEqual(['left', 'right']);
    expect([...reordered.states]).toEqual([...first.states]);
  });

  it.each(['DYNAMIC_FIELD', 'AMBIGUOUS_EDGE', 'UNSUPPORTED_SELECTOR'] as const)('retains wildcard provenance when %s widens the state', (reason) => {
    const wildcard = { ...atom, field: ['*'] };
    expect(transfer({ kind: 'UNKNOWN', reason }, knownState([wildcard]))).toMatchObject({ knowledge: 'UNKNOWN', atoms: [wildcard], unknownReasons: [reason] });
  });

  it('retains bounded all-item and exact-item origins when their carrier selection is ambiguous', () => {
    const models = new Map<string, FieldTransferModelV1>([
      ['root', { kind: 'COPY' }],
      ['all', { kind: 'SOURCE', sourceId: 'all-items', field: ['items', '*'], channel: 'INTEGRITY' }],
      ['exact', { kind: 'SOURCE', sourceId: 'exact-item', field: ['items', '0'], channel: 'INTEGRITY' }],
      ['selected', { kind: 'UNKNOWN', reason: 'DYNAMIC_FIELD' }],
    ]);
    const result = runScanLocalWorklist({
      entry: 'root', graph: new Map([['root', ['all', 'exact']], ['all', ['selected']], ['exact', ['selected']]]),
      initialState: knownState(), transfer: createScanLocalTransfer(models), maxStates: 10, maxOperations: 4000,
    });
    expect(result.status).toBe('COMPLETE');
    expect(result.states.get('selected')).toMatchObject({
      knowledge: 'UNKNOWN', unknownReasons: ['DYNAMIC_FIELD'],
      atoms: [
        { sourceId: 'all-items', field: ['items', '*'], channel: 'INTEGRITY' },
        { sourceId: 'exact-item', field: ['items', '0'], channel: 'INTEGRITY' },
      ],
    });
  });

  it('authorizes a HEADER token only for the exact reviewed context and path', () => {
    const first = transfer(sanitizer('encodeURIComponent'));
    const otherPath = transfer(sanitizer('encodeURIComponent', 'HEADER', ['other']));
    expect(first.atoms).toEqual([atom]);
    expect(first.sanitizedFor).toEqual([{ modelId: 'sf.san.v1.encode-uri-component', sink: 'HEADER', pathDigest: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(otherPath.sanitizedFor[0]?.pathDigest).not.toBe(first.sanitizedFor[0]?.pathDigest);
    expect(transfer(sanitizer('encodeURIComponent', 'SQL')).sanitizedFor).toEqual([]);
  });

  it('converges a cycle whose reviewed sanitizers replace each other’s tokens', () => {
    const models = new Map<string, FieldTransferModelV1>([
      ['a', sanitizer('Number', 'SQL', ['a'])],
      ['b', sanitizer('encodeURIComponent', 'HEADER', ['b'])],
    ]);
    const result = runScanLocalWorklist({
      entry: 'a', graph: new Map([['a', ['b']], ['b', ['a']]]), initialState: knownState(),
      transfer: createScanLocalTransfer(models), maxStates: 10, maxOperations: 2000,
    });
    expect(result.status).toBe('COMPLETE');
    expect(result.states.get('a')?.sanitizedFor).toEqual([expect.objectContaining({ sink: 'SQL' })]);
    expect(result.states.get('b')?.sanitizedFor).toEqual([expect.objectContaining({ sink: 'HEADER' })]);
  });

  it('revokes downstream authorization when a later unsanitized path reaches an already expanded merge', () => {
    const models = new Map<string, FieldTransferModelV1>([
      ['root', { kind: 'SOURCE', sourceId: 'origin', field: ['body'], channel: 'INTEGRITY' }],
      ['a', sanitizer('Number', 'SQL')], ['b', { kind: 'COPY' }], ['late', { kind: 'COPY' }],
      ['merge', { kind: 'MERGE' }], ['sink', { kind: 'COPY' }],
    ]);
    const result = runScanLocalWorklist({
      entry: 'root', initialState: knownState(), transfer: createScanLocalTransfer(models),
      graph: new Map([['root', ['a', 'b']], ['a', ['merge']], ['b', ['late']], ['late', ['merge']], ['merge', ['sink']]]),
      maxStates: 10, maxOperations: 4000,
    });
    expect(result.status).toBe('COMPLETE');
    expect(result.states.get('a')?.sanitizedFor).toEqual([expect.objectContaining({ sink: 'SQL' })]);
    expect(result.states.get('sink')).toMatchObject({
      atoms: [{ sourceId: 'origin', field: ['body'], channel: 'INTEGRITY' }], sanitizedFor: [],
    });
  });

  it.each(['Number', 'parseInt', 'parseFloat'])('does not grant %s authorization for a newly added HTML sink', (callee) => {
    expect(transfer(sanitizer(callee, 'SQL')).sanitizedFor).toEqual([expect.objectContaining({ sink: 'SQL' })]);
    expect(transfer(sanitizer(callee, 'HTML')).sanitizedFor).toEqual([]);
  });

  it('uses only the reviewed outermost wrapper and removes stale inner authorizations for that value', () => {
    const inner = transfer(sanitizer('Number', 'SQL'));
    const model: FieldTransferModelV1 = { kind: 'SANITIZE', calleesOutermostFirst: ['encodeURIComponent', 'Number'], binding: 'REVIEWED', sink: 'HEADER', path: ['value'] };
    const result = transfer(model, inner);
    expect(result.sanitizedFor).toEqual([expect.objectContaining({ sink: 'HEADER' })]);
    expect(result.sanitizedFor.some((token) => token.sink === 'SQL')).toBe(false);
    expect(transfer({ ...model, calleesOutermostFirst: ['unknown', 'Number'] }, inner)).toMatchObject({ knowledge: 'UNKNOWN', sanitizedFor: [] });
  });

  it.each(['SHADOWED', 'REASSIGNED'] as const)('does not authorize a %s sanitizer binding', (binding) => {
    const model: FieldTransferModelV1 = { kind: 'SANITIZE', calleesOutermostFirst: ['Number'], binding, sink: 'SQL', path: ['value'] };
    expect(transfer(model)).toMatchObject({ knowledge: 'UNKNOWN', atoms: [atom], sanitizedFor: [], unknownReasons: ['UNMODELLED_TRANSFER'] });
  });

  it('never converts unknown input into known or erases its supported atoms during sanitization', () => {
    const state: FieldStateV1 = { ...tainted, knowledge: 'UNKNOWN', unknownReasons: ['UNMODELLED_SOURCE'] };
    expect(transfer(sanitizer('encodeURIComponent'), state)).toMatchObject({ knowledge: 'UNKNOWN', atoms: [atom], unknownReasons: ['UNMODELLED_SOURCE'] });
  });

  it('records oversized source paths as UNKNOWN rather than a clean literal or admitted origin', () => {
    const result = transfer({ kind: 'SOURCE', sourceId: 'other', field: ['x'.repeat(257)], channel: 'INTEGRITY' });
    expect(result).toMatchObject({ knowledge: 'UNKNOWN', atoms: [atom], unknownReasons: ['PAYLOAD_LIMIT'] });
  });
});
