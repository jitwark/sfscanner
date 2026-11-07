import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { fieldFlowPathDigestV1 } from '@hub/contracts/scanner-v2-field-flow-validation';
import { createSafeFactAdmissionSnapshotV2 } from '../../admission/snapshot';
import type { SafeFactV2, SubjectV2 } from '../../capabilities/scheduler';
import { SAFE_FACT_REGISTRY_V2 } from '../../facts/safe-fact-registry';
import { validateSafeFact } from '../../facts/safe-fact-validator';
import { createNodeIdentityDigest } from '../../workflow-v2/node-edge-identity';
import {
  emitScanLocalFlowFacts, type ScanLocalFlowFactsInputV1, type ScanLocalFlowFactsV1,
} from './scan-local-flow-facts';
import { createScanLocalFlowCollector } from './scan-local-flows';
import {
  joinFieldStates, knownState, sanitizeFieldState, unknownState,
  type FieldStateV1, type SanitizerTokenV1, type ScanLocalChargeV1, type TaintAtomV1,
} from './scan-local-state';
import { runScanLocalWorklist } from './scan-local-worklist';

const subject = (ordinal: number, name?: string): SubjectV2 => {
  const source = { pointer: `/nodes/${ordinal}`, occurrencePath: [ordinal], astNodeId: 'a'.repeat(64), span: null };
  const node = { ordinal, source, identityDigest: createNodeIdentityDigest(ordinal, source),
    ...(name === undefined ? {} : { name }) };
  return { kind: 'NODE', node };
};
const ORIGIN: TaintAtomV1 = { sourceId: 'origin', field: ['body'], channel: 'INTEGRITY' };
type TransferV1 = (node: string, state: FieldStateV1, charge: ScanLocalChargeV1) => FieldStateV1;

/** The real worklist and collector: exactly one publication debit is captured, and it is collected once. */
function flow(atoms: readonly TaintAtomV1[], requested: TaintAtomV1, transfer: TransferV1) {
  const collector = createScanLocalFlowCollector({
    sources: new Map([['origin', 'a']]), requests: [{ atom: requested, sink: 'z' }],
  });
  let charge: ScanLocalChargeV1 | undefined;
  const analysis = runScanLocalWorklist({
    entry: 'a', graph: new Map([['a', ['z']], ['z', []]]), initialState: knownState(atoms),
    transfer, maxStates: 8, maxOperations: 100_000,
    publish: (publication, debit) => { charge = debit; collector.publish(publication, debit); },
  });
  const outcome = collector.collect(analysis);
  const candidate = outcome.candidates[0];
  if (outcome.candidates.length === 0 || charge === undefined) throw new Error('Fixture did not execute its sink');
  return { candidate, charge };
}
const paidCandidate = (transfer: TransferV1 = (_node, state) => state) => flow([ORIGIN], ORIGIN, transfer);

type OverridesV1 = Readonly<{
  candidate?: ScanLocalFlowFactsInputV1['candidate']; charge?: ScanLocalChargeV1;
  sourceSubject?: SubjectV2; sinkSubject?: SubjectV2; sinkClass?: string; taintLabels?: readonly string[];
  sinkFieldPath?: readonly string[]; sinkParameterPath?: string; sinkChannel?: string; edgeChannel?: string;
}>;

function emit(overrides: OverridesV1 = {}): ScanLocalFlowFactsV1 {
  const { candidate, charge } = paidCandidate();
  return emitScanLocalFlowFacts({
    candidate: overrides.candidate ?? candidate, charge: overrides.charge ?? charge,
    sourceSubject: overrides.sourceSubject ?? subject(0), sinkSubject: overrides.sinkSubject ?? subject(1),
    taintLabels: overrides.taintLabels ?? ['MODEL_OUTPUT'], sinkClass: overrides.sinkClass ?? 'COMMAND',
    sinkFieldPath: overrides.sinkFieldPath ?? ['command'], sinkParameterPath: overrides.sinkParameterPath ?? '/command',
    sinkChannel: overrides.sinkChannel ?? 'DATA', edgeChannel: overrides.edgeChannel ?? 'DATA',
    limits: DEFAULT_SCANNER_LIMITS_V2,
  });
}

const tokenFor = (sink: string, path: readonly string[], modelId = 'sf.san.v1.number'): SanitizerTokenV1 =>
  ({ modelId, sink, pathDigest: fieldFlowPathDigestV1(path) });
const withTokens = (tokens: readonly SanitizerTokenV1[]): TransferV1 =>
  (_node, state) => knownState(state.atoms, tokens);
const wire = (sink: string, path: readonly string[], modelId = 'sf.san.v1.number'): string =>
  `v1/${modelId}/${sink}/${fieldFlowPathDigestV1(path)}`;

function admitted(fact: SafeFactV2): boolean {
  const schema = SAFE_FACT_REGISTRY_V2.schemas.find((entry) => entry.kind === fact.kind);
  if (schema === undefined) throw new Error('Missing actual fact schema');
  return validateSafeFact(createSafeFactAdmissionSnapshotV2(fact), schema, DEFAULT_SCANNER_LIMITS_V2).ok;
}
function emitted(result: ScanLocalFlowFactsV1) {
  if (result.status !== 'EMITTED') throw new Error(`Expected emitted facts, received ${result.status}`);
  return result;
}

describe('paid scan-local canonical flow facts', () => {
  it('publishes a bound provenance and sink summary accepted by actual fact admission', () => {
    const result = emitted(emit());
    expect(result.summary.properties.sourceProvenanceFactId).toBe(result.provenance.factId);
    expect(result.provenance.properties.sourceFieldPath).toEqual(['body']);
    expect(result.summary.properties.sinkFieldPath).toEqual(['command']);
    expect(result.provenance.subject).toMatchObject({ kind: 'NODE', node: { ordinal: 0 } });
    expect(result.summary.subject).toMatchObject({ kind: 'NODE', node: { ordinal: 1 } });
    expect(result.summary.properties).toMatchObject({
      knowledge: 'KNOWN', taintChannel: 'INTEGRITY', omittedAtoms: 0, omittedSanitizers: 0, sanitizedFor: [],
    });
    expect(admitted(result.provenance)).toBe(true);
    expect(admitted(result.summary)).toBe(true);
  });

  it.each([
    { sinkClass: 'COMMAND', label: 'TOOL_RESULT', sinkChannel: 'DATA', edgeChannel: 'MODEL' },
    { sinkClass: 'CODE', label: 'MODEL_OUTPUT', sinkChannel: 'TOOL', edgeChannel: 'ERROR' },
    { sinkClass: 'SQL', label: 'RETRIEVED_CONTEXT', sinkChannel: 'CONTEXT', edgeChannel: 'DATA' },
  ])('emits an admitted $sinkClass flow with independent channels', ({ sinkClass, label, sinkChannel, edgeChannel }) => {
    const result = emitted(emit({
      sinkClass, taintLabels: [label], sinkChannel, edgeChannel, sinkFieldPath: ['query'], sinkParameterPath: '/query',
    }));
    expect(result.summary.properties).toMatchObject({
      sinkClass, sinkChannel, edgeChannel, taintChannel: 'INTEGRITY', taintLabels: [label], sourceFieldPath: ['body'],
      sinkFieldPath: ['query'],
    });
    expect(admitted(result.provenance) && admitted(result.summary)).toBe(true);
  });

  it('refuses a candidate whose atom is absent from its published sink state', () => {
    const { candidate } = paidCandidate();
    expect(emit({ candidate: { ...candidate, sinkState: knownState([]) } }))
      .toEqual({ status: 'OMITTED', reason: 'UNSUPPORTED_ATOM' });
  });

  it('refuses a reserved CONTROL atom even when its state supports it', () => {
    const control: TaintAtomV1 = { sourceId: 'origin', field: ['body'], channel: 'CONTROL' };
    const { candidate } = paidCandidate();
    expect(emit({ candidate: { ...candidate, atom: control, sinkState: knownState([control]) } }))
      .toEqual({ status: 'OMITTED', reason: 'UNSUPPORTED_ATOM' });
  });

  it('refuses unsafe subjects and paths without echoing any of them', () => {
    const refused = [emit({ sourceSubject: subject(0, 'sk-live-abcdef123456') }),
      emit({ sourceSubject: subject(0, 'C:\\Users\\owner') }),
      emit({ sourceSubject: subject(0, '\u200B') }),
      emit({ sinkFieldPath: ['/etc/passwd'], sinkParameterPath: '/etc/passwd' })];
    expect(refused.map((result) => result.status === 'OMITTED' && result.reason)).toEqual([
      'FORBIDDEN_CONTENT', 'FORBIDDEN_CONTENT', 'FORBIDDEN_CONTENT', 'INVALID_PROPERTY',
    ]);
    for (const result of refused) expect(JSON.stringify(result)).not.toMatch(/sk-live|Users|passwd/);
    expect(emit({ sourceSubject: subject(0, 'Knoten ✓ – Befehl') }).status).toBe('EMITTED');
  });

  it('suppresses a KNOWN flow sanitized for this exact sink class and path', () => {
    const result = emit({ ...paidCandidate(withTokens([tokenFor('COMMAND', ['command'])])) });
    if (result.status !== 'SUPPRESSED') throw new Error(`Expected suppression, received ${result.status}`);
    expect(result.invalidTokens).toBe(0);
    expect(result.omittedSanitizers).toBe(0);
    expect(admitted(result.provenance)).toBe(true);
  });

  it('keeps emitting an UNKNOWN flow whose sanitizer token matches', () => {
    const token = tokenFor('COMMAND', ['command']);
    const unknown: TransferV1 = (_node, state, charge) => {
      const joined = joinFieldStates(knownState(state.atoms, [token]), unknownState('AMBIGUOUS_EDGE'), charge);
      if (joined.status !== 'JOINED') throw new Error('Fixture join was refused');
      return sanitizeFieldState(joined.state, token);
    };
    const result = emitted(emit({ ...paidCandidate(unknown) }));
    expect(result.summary.properties).toMatchObject({
      knowledge: 'UNKNOWN', unknownReasons: ['AMBIGUOUS_EDGE'], omittedAtoms: 0, omittedSanitizers: 0,
      sanitizedFor: [wire('COMMAND', ['command'])],
    });
    expect(admitted(result.summary)).toBe(true);
  });

  it('never suppresses on a sibling path or a sibling sink class', () => {
    const siblingPath = emit({ ...paidCandidate(withTokens([tokenFor('COMMAND', ['other'])])) });
    expect(siblingPath).toMatchObject({ status: 'EMITTED', invalidTokens: 1, omittedSanitizers: 1 });
    expect(emitted(siblingPath).summary.properties).toMatchObject({
      knowledge: 'UNKNOWN', unknownReasons: ['PAYLOAD_LIMIT'], omittedSanitizers: 1, sanitizedFor: [],
    });
    const siblingClass = emitted(emit({ ...paidCandidate(withTokens([tokenFor('SQL', ['command'])])) }));
    expect(siblingClass).toMatchObject({ invalidTokens: 0, omittedSanitizers: 0 });
    expect(siblingClass.summary.properties).toMatchObject({
      knowledge: 'KNOWN', sanitizedFor: [wire('SQL', ['command'])],
    });
    expect(admitted(siblingClass.summary)).toBe(true);
  });

  it('counts an invalid token before filtering and widens knowledge with exact omissions', () => {
    const tokens = [tokenFor('SQL', ['command']), tokenFor('SQL', ['command'], 'sf.san.v1.unreviewed')];
    const result = emitted(emit({ ...paidCandidate(withTokens(tokens)) }));
    expect(result).toMatchObject({ invalidTokens: 1, omittedSanitizers: 1 });
    expect(result.summary.properties).toMatchObject({
      knowledge: 'UNKNOWN', unknownReasons: ['PAYLOAD_LIMIT'], omittedAtoms: 0, omittedSanitizers: 1,
      sanitizedFor: [wire('SQL', ['command'])],
    });
    expect(admitted(result.summary)).toBe(true);
  });

  it('reports bound token omissions once without double counting', () => {
    const tokens = ['SQL', 'COMMAND', 'SSRF', 'HEADER', 'PATH', 'CODE', 'PROMPT'].flatMap((sink) =>
      ['number', 'parse-int', 'parse-float'].map((model) => tokenFor(sink, ['command'], `sf.san.v1.${model}`)));
    const { candidate, charge } = paidCandidate(withTokens(tokens));
    expect(candidate.omittedTokens).toBe(tokens.length - 16);
    const result = emitted(emit({ candidate, charge }));
    expect(result).toMatchObject({ invalidTokens: 0 });
    expect(result.summary.properties).toMatchObject({
      knowledge: 'UNKNOWN', unknownReasons: ['PAYLOAD_LIMIT'], omittedSanitizers: tokens.length - 16,
    });
    expect((result.summary.properties.sanitizedFor as readonly string[]).length).toBe(16);
    expect(admitted(result.summary)).toBe(true);
  });

  it('reports bound atom omissions instead of claiming a clean KNOWN flow', () => {
    const fillers = Array.from({ length: 64 }, (_, index): TaintAtomV1 =>
      ({ sourceId: `zz${index}`, field: ['body'], channel: 'INTEGRITY' }));
    const extra: TaintAtomV1 = { sourceId: 'zzz-extra', field: ['body'], channel: 'INTEGRITY' };
    // The executed transfer re-adds a 65th atom, so the published sink state must drop one.
    const result = emitted(emit({
      ...flow([ORIGIN, ...fillers], ORIGIN, (_node, state) => knownState([...state.atoms, extra])),
    }));
    expect(result.summary.properties).toMatchObject({
      knowledge: 'UNKNOWN', unknownReasons: ['PAYLOAD_LIMIT'], omittedAtoms: 1, omittedSanitizers: 0,
    });
    expect(admitted(result.summary)).toBe(true);
  });

  it('refuses before any guarded work when the run cannot prepay', () => {
    expect(emit({ charge: () => false })).toEqual({ status: 'OMITTED', reason: 'BUDGET_EXHAUSTED' });
    expect(emit({ charge: () => false, sourceSubject: subject(0, 'sk-live-abcdef123456') }))
      .toEqual({ status: 'OMITTED', reason: 'BUDGET_EXHAUSTED' });
  });

  it('is deterministic for repeated identical inputs', () => {
    const first = emitted(emit({ charge: () => true }));
    const second = emitted(emit({ charge: () => true }));
    expect(second).toEqual(first);
    expect(second.summary.factId).toBe(first.summary.factId);
  });
});
