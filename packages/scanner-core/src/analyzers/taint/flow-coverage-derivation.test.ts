import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { FIELD_FLOW_PROPERTY_TYPES_V1 } from '../../../../../contracts/scanner-v2-field-flow';
import { validateFieldFlowCoherenceV1 } from '../../../../../contracts/scanner-v2-field-flow-coherence';
import {
  readFieldFlowPropertiesV1, validateFieldFlowSubject,
} from '../../../../../contracts/scanner-v2-field-flow-validation';
import type { SafeFactV2, SubjectV2 } from '../../capabilities/scheduler';
import { createCandidateFactId } from '../../result-v2/identities';
import { createNodeIdentityDigest } from '../../workflow-v2/node-edge-identity';
import { createFlowCoverageLogV1, withFlowCoverageChargeV1 } from './flow-coverage-observation';
import {
  deriveFlowCoverageV1, type FlowCoverageCountersV1, type FlowCoverageDerivationV1,
  type FlowCoverageInputV1,
} from './flow-coverage-derivation';
import type { ScanLocalFlowCandidateV1 } from './scan-local-flows';
import type { ScanLocalFlowSinkSpecV1 } from './scan-local-flow-witness-facts';
import {
  knownState, unknownState, type FieldStateV1, type ScanLocalChargeV1, type TaintAtomV1,
} from './scan-local-state';
import { createScanLocalTransfer, type FieldTransferModelV1 } from './scan-local-transfer';
import {
  runScanLocalWithWitnesses, type ScanLocalWitnessInputV1, type ScanLocalWitnessResultV1,
} from './scan-local-traces';
import { createScanLocalFlowFactEmitterV1 } from './scan-local-flow-witness-facts';

const ORIGIN: TaintAtomV1 = { sourceId: 'origin', field: ['body'], channel: 'INTEGRITY' };
const CONTEXT = { semanticSha256: 'e'.repeat(64) };
const SINK: ScanLocalFlowSinkSpecV1 = { sinkClass: 'COMMAND', sinkFieldPath: ['command'],
  sinkParameterPath: '/command', sinkChannel: 'TOOL', edgeChannel: 'DATA' };
type RequestV1 = ScanLocalWitnessInputV1['requests'][number];

const subject = (ordinal: number, spanless: boolean): SubjectV2 => {
  const position = (offset: number) => ({ line: 1, column: offset + 1, utf16Offset: offset, utf8ByteOffset: offset });
  const source = { pointer: `/nodes/${ordinal}`, occurrencePath: [ordinal], astNodeId: 'a'.repeat(64),
    span: spanless ? null : { start: position(ordinal), end: position(ordinal + 1) } };
  return { kind: 'NODE', node: { ordinal, source, identityDigest: createNodeIdentityDigest(ordinal, source) } };
};

type RunOptionsV1 = Readonly<{
  graph: ReadonlyMap<string, readonly string[]>;
  models?: ReadonlyMap<string, FieldTransferModelV1>;
  transfer?: (node: string, state: FieldStateV1, charge: ScanLocalChargeV1) => FieldStateV1;
  spanless?: boolean;
  initialState?: FieldStateV1;
  requests?: readonly RequestV1[];
  maxOperations?: number;
  charge?: ScanLocalChargeV1;
  emitter?: boolean;
  terminalInputRead?: boolean;
  emitterSinkParameterPath?: string;
}>;

/** The actual runner, collector, emitter, cache and materializer; only graph data is compact. */
function run(options: RunOptionsV1): ScanLocalWitnessResultV1 {
  const nodes = [...new Set([...options.graph.keys(), ...[...options.graph.values()].flat()])].sort();
  const carriers = new Map(nodes.map((node, ordinal) => [node, { kind: 'PROPAGATION' as const, node: ordinal,
    field: options.terminalInputRead === true && node === 'z' ? '/command' : '/value', port: 0, item: 0 }]));
  const subjects = new Map(nodes.map((_, ordinal) => [ordinal, subject(ordinal, options.spanless === true)]));
  const emitFlow = createScanLocalFlowFactEmitterV1({ carriers, subjects,
    sinks: new Map(nodes.map((node) => [node, {
      ...SINK, sinkParameterPath: options.emitterSinkParameterPath ?? SINK.sinkParameterPath,
    }])), taintLabels: ['MODEL_OUTPUT'], limits: DEFAULT_SCANNER_LIMITS_V2 });
  const requests: readonly RequestV1[] = options.requests ?? [{ atom: ORIGIN, sink: 'z', channel: 'DATA',
    ...(options.terminalInputRead === true ? { terminalInputRead: { channel: 'DATA', path: ORIGIN.field,
      sinkParameterPath: '/command', carrier: carriers.get('z')! } } : {}) }];
  return runScanLocalWithWitnesses({
    entry: 'a', graph: options.graph, initialState: options.initialState ?? knownState([ORIGIN]),
    transfer: options.transfer ?? createScanLocalTransfer(new Map(nodes.map((node) => [node,
      options.models?.get(node) ?? { kind: 'COPY' as const }]))),
    maxStates: 20, maxOperations: options.maxOperations ?? 100_000,
    ...(options.charge === undefined ? {} : { charge: options.charge }),
  }, {
    carriers, sources: new Map([['origin', 'a']]),
    edges: new Map([...options.graph].map(([from, targets]) => [from, new Map(targets.map((to, ordinal) =>
      [to, { ordinal, channel: 'DATA' as const, supported: true }]))])),
    requests, subjects, context: CONTEXT,
    limits: { maxTraceStepsPerFinding: 100, maxEvidenceBytes: 100_000 },
    maxWitnessOperations: 10_000,
    ...(options.emitter === false ? {} : { emitFlow }),
  });
}

function counters(result: ScanLocalWitnessResultV1): FlowCoverageCountersV1 {
  return Object.freeze({ analysisStatus: result.analysis.status, flowsStatus: result.flows.status,
    analysisOmitted: result.analysis.omitted, invalidRequests: result.flows.invalidRequests,
    unmappedSources: result.flows.unmappedSources, unpublishedSinks: result.flows.unpublishedSinks,
    incompleteTransfers: result.flows.incompleteTransfers, omittedRequests: result.omittedRequests,
    witnessUnavailable: result.witnessUnavailable, omittedTraceSteps: result.omittedTraceSteps,
    suppressedRequests: result.suppressedRequests });
}

function terminalInput(result: ScanLocalWitnessResultV1, facts = result.facts,
  count = counters(result)): FlowCoverageInputV1 {
  return { kind: 'TERMINAL', snapshot: result.flowCoverage, facts, counters: count };
}

function deriveStored(input: FlowCoverageInputV1, snapshot = (input as Extract<FlowCoverageInputV1,
  { kind: 'TERMINAL' }>).snapshot): FlowCoverageDerivationV1 {
  const handoff = withFlowCoverageChargeV1(snapshot, (charge) => deriveFlowCoverageV1(input, charge));
  if (!handoff.ok) throw new Error(`Expected stored charge, received ${handoff.reason}`);
  return handoff.value;
}

const COVERAGE_KEYS = Object.keys(FIELD_FLOW_PROPERTY_TYPES_V1['dataflow.coverage.v1']).sort();
const zeroStatus: Readonly<Record<string, 'COMPLETE' | 'LIMITED' | 'FAILED'>> = Object.freeze({
  NOT_APPLICABLE: 'COMPLETE', MODEL_UNKNOWN: 'FAILED', PRE_FIELD_LIMITED: 'LIMITED',
  UNAVAILABLE_BEFORE_FIELDS: 'FAILED',
});

describe('pure charged flow coverage derivation', () => {
  it.each(Object.entries(zeroStatus))('projects %s without invented endpoints or rows', (kind, status) => {
    let units = 0;
    const result = deriveFlowCoverageV1({ kind } as FlowCoverageInputV1, (cost) => { units += cost; return true; });
    expect(units).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.properties).sort()).toEqual(COVERAGE_KEYS);
    expect(result.properties).toMatchObject({ capabilityId: 'taint-integrity', coverageStatus: status,
      fieldsExamined: 0, knownFields: 0, knownEmptyFields: 0, unknownFields: 0, positiveFields: 0,
      emittedFlows: 0, suppressedFlows: 0, omittedAtoms: 0, omittedSanitizers: 0,
      unknownReasons: [], taintChannels: [], sinkChannels: [], edgeChannels: [],
      unmappedSources: 0, unmappedSinks: 0, unmappedPaths: 0, redactedPaths: 0,
      invalidTokens: 0, witnessUnavailable: 0, omittedTraceSteps: 0 });
  });

  it('derives the actual KNOWN publication as 2/2/0/0/2 with exact provenance and channels', () => {
    const actual = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true });
    expect(actual.flowCoverage.status).toBe('OBSERVED');
    expect(actual.facts.map((fact) => fact.kind)).toEqual(['dataflow.provenance.v1', 'dataflow.summary.v3']);
    const result = deriveStored(terminalInput(actual));
    if (!result.ok) throw new Error(`Expected coverage derivation, received ${result.reason}`);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.properties).sort()).toEqual(COVERAGE_KEYS);
    expect(result.properties).toMatchObject({ capabilityId: 'taint-integrity', coverageStatus: 'COMPLETE',
      fieldsExamined: 2, knownFields: 2, knownEmptyFields: 0, unknownFields: 0, positiveFields: 2,
      emittedFlows: 1, suppressedFlows: 0, omittedAtoms: 0, omittedSanitizers: 0,
      unknownReasons: [], taintChannels: ['INTEGRITY'], sinkChannels: ['TOOL'], edgeChannels: ['DATA'],
      unmappedSources: 0, unmappedSinks: 0, unmappedPaths: 0, redactedPaths: 0,
      invalidTokens: 0, witnessUnavailable: 0, omittedTraceSteps: 0 });
    const coverage = { kind: 'dataflow.coverage.v1' as const, subject: { kind: 'WORKFLOW' as const },
      properties: result.properties };
    const retained: SafeFactV2 = Object.freeze({ ...coverage, factId: createCandidateFactId(coverage) });
    expect(readFieldFlowPropertiesV1(retained.kind, retained.properties)).toEqual(result.properties);
    expect(validateFieldFlowSubject(retained.kind, retained.subject, retained.properties)).toBe(true);
    expect(validateFieldFlowCoherenceV1([...actual.facts, retained], 'taint-integrity')).toBe(true);
  });

  it('keeps a raw UNKNOWN terminal emission limited with zero accepted endpoints and its real counters', () => {
    const invalidSanitizer = { modelId: 'unreviewed', sink: 'COMMAND', pathDigest: 'not-a-digest' };
    const actual = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true,
      initialState: knownState([ORIGIN], [invalidSanitizer]) });
    expect(actual.facts).toEqual([]);
    if (actual.flowCoverage.status !== 'OBSERVED') throw new Error('Expected raw terminal observation');
    const emission = actual.flowCoverage.rows[0]!.emission;
    expect(emission).toMatchObject({ status: 'EMITTED', summary: { properties: { knowledge: 'UNKNOWN' } } });
    const result = deriveStored(terminalInput(actual));
    expect(result).toEqual({ ok: true, properties: expect.objectContaining({
      coverageStatus: 'LIMITED', fieldsExamined: 0, knownFields: 0, unknownFields: 0, positiveFields: 0,
      emittedFlows: 0, suppressedFlows: 0, unknownReasons: [], taintChannels: [], sinkChannels: [], edgeChannels: [],
      omittedAtoms: actual.flows.candidates[0]!.omittedAtoms,
      omittedSanitizers: emission.status === 'EMITTED' ? emission.omittedSanitizers : -1,
      invalidTokens: emission.status === 'EMITTED' ? emission.invalidTokens : -1,
      witnessUnavailable: actual.witnessUnavailable,
    }) });
  });

  it('keeps a raw SUPPRESSED terminal emission limited without accepting suppression', () => {
    const actual = run({ graph: new Map([['a', ['m']], ['m', ['z']]]), terminalInputRead: true,
      emitterSinkParameterPath: '/parameters/cmd', models: new Map([['m', { kind: 'SANITIZE',
        calleesOutermostFirst: ['Number'], binding: 'REVIEWED', sink: 'COMMAND', path: ['command'] }]]) });
    if (actual.flowCoverage.status !== 'OBSERVED') throw new Error('Expected raw terminal observation');
    expect(actual.flowCoverage.rows[0]!.emission.status).toBe('SUPPRESSED');
    const result = deriveStored(terminalInput(actual));
    expect(result).toMatchObject({ ok: true, properties: { coverageStatus: 'LIMITED', fieldsExamined: 0,
      emittedFlows: 0, suppressedFlows: 0, unknownReasons: [], taintChannels: [], sinkChannels: [], edgeChannels: [],
      witnessUnavailable: actual.witnessUnavailable } });
  });

  it('treats a final EMITTED observation without retained facts as a limited draft', () => {
    const actual = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true });
    const result = deriveStored(terminalInput(actual, []));
    expect(result).toMatchObject({ ok: true, properties: { coverageStatus: 'LIMITED', fieldsExamined: 0,
      knownFields: 0, unknownFields: 0, positiveFields: 0, emittedFlows: 0, suppressedFlows: 0,
      unknownReasons: [], taintChannels: [], sinkChannels: [], edgeChannels: [] } });
  });

  it('refuses a charged empty observation instead of claiming known-empty fields', () => {
    const actual = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true, emitter: false });
    expect(actual.flowCoverage).toMatchObject({ status: 'OBSERVED', rows: [] });
    expect(deriveStored(terminalInput(actual))).toEqual({ ok: false, reason: 'UNSUPPORTED_OBSERVATION' });
  });

  it('returns TELEMETRY_UNAVAILABLE for the real late-cache refusal', () => {
    let paid = 0;
    const charge: ScanLocalChargeV1 = (units) => {
      if (units > 25_014 - paid) return false;
      paid += units;
      return true;
    };
    const actual = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true, charge });
    expect(actual.flowCoverage).toEqual({ status: 'REFUSED', reason: 'BUDGET_EXHAUSTED' });
    expect(actual.flows.candidates).toHaveLength(1);
    expect(actual.facts).toEqual([]);
    expect(deriveFlowCoverageV1(terminalInput(actual), charge))
      .toEqual({ ok: false, reason: 'TELEMETRY_UNAVAILABLE' });
  });

  it('returns TELEMETRY_UNAVAILABLE for a snapshot without a captured charge', () => {
    const snapshot = createFlowCoverageLogV1().snapshot([]);
    expect(snapshot).toEqual({ status: 'REFUSED', reason: 'NO_CHARGE' });
    const valid: FlowCoverageCountersV1 = { analysisStatus: 'COMPLETE', flowsStatus: 'COMPLETE', analysisOmitted: 0,
      invalidRequests: 0, unmappedSources: 0, unpublishedSinks: 0, incompleteTransfers: 0, omittedRequests: 0,
      witnessUnavailable: 0, omittedTraceSteps: 0, suppressedRequests: 0 };
    expect(deriveFlowCoverageV1({ kind: 'TERMINAL', snapshot, facts: [], counters: valid }, () => true))
      .toEqual({ ok: false, reason: 'TELEMETRY_UNAVAILABLE' });
  });

  it('rejects a foreign same-shaped charge and returns TELEMETRY_UNAVAILABLE', () => {
    const actual = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true });
    let touched = false;
    const forged: ScanLocalChargeV1 = () => { touched = true; return true; };
    expect(deriveFlowCoverageV1(terminalInput(actual), forged))
      .toEqual({ ok: false, reason: 'TELEMETRY_UNAVAILABLE' });
    expect(touched).toBe(false);
  });

  it('maps an observed late debit refusal to BUDGET_EXHAUSTED without retrying the charge', () => {
    let refuse = false, calls = 0;
    const charge: ScanLocalChargeV1 = () => { calls += 1; return !refuse; };
    const actual = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true, charge });
    expect(actual.flowCoverage.status).toBe('OBSERVED');
    refuse = true;
    const before = calls;
    expect(deriveStored(terminalInput(actual)))
      .toEqual({ ok: false, reason: 'BUDGET_EXHAUSTED' });
    expect(calls).toBe(before + 1);
  });

  it('rejects invalid counters, accessors, missing keys and extra keys before fact traversal', () => {
    const actual = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true });
    const valid = counters(actual);
    const invalidValues: readonly unknown[] = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity];
    for (const value of invalidValues) {
      expect(deriveStored(terminalInput(actual, actual.facts,
        { ...valid, analysisOmitted: value } as FlowCoverageCountersV1)))
        .toEqual({ ok: false, reason: 'INVALID_COUNTER' });
    }
    expect(deriveStored(terminalInput(actual, actual.facts,
      { ...valid, analysisStatus: 'DONE' } as unknown as FlowCoverageCountersV1)))
      .toEqual({ ok: false, reason: 'INVALID_COUNTER' });
    const missing: Record<string, unknown> = { ...valid };
    delete missing.invalidRequests;
    expect(deriveStored(terminalInput(actual, actual.facts,
      missing as unknown as FlowCoverageCountersV1)))
      .toEqual({ ok: false, reason: 'INVALID_COUNTER' });
    expect(deriveStored(terminalInput(actual, actual.facts,
      { ...valid, extra: 0 } as unknown as FlowCoverageCountersV1)))
      .toEqual({ ok: false, reason: 'INVALID_COUNTER' });
    let touched = false;
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, 'analysisStatus', { enumerable: true,
      get() { touched = true; return 'COMPLETE'; } });
    expect(deriveStored(terminalInput(actual, actual.facts,
      accessor as unknown as FlowCoverageCountersV1)))
      .toEqual({ ok: false, reason: 'INVALID_COUNTER' });
    expect(touched).toBe(false);
  });

  it('charges before reading the terminal input descriptor', () => {
    let capped = false, remaining = Number.POSITIVE_INFINITY;
    const charge: ScanLocalChargeV1 = (units) => {
      if (!capped) return true;
      if (units > remaining) return false;
      remaining -= units;
      return true;
    };
    const actual = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true, charge });
    capped = true; remaining = 0;
    let descriptors = 0;
    const proxied = new Proxy(terminalInput(actual), {
      getOwnPropertyDescriptor(target, key) { descriptors += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
    });
    expect(deriveStored(proxied)).toEqual({ ok: false, reason: 'BUDGET_EXHAUSTED' });
    expect(descriptors).toBe(0);
  });

  it('stops a nested counter walk immediately when its string debit closes the latch', () => {
    let armed = false, remaining = Number.POSITIVE_INFINITY, laterDescriptors = 0;
    const charge: ScanLocalChargeV1 = (units) => {
      if (!armed) return true;
      if (units > remaining) return false;
      remaining -= units; return true;
    };
    const actual = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true, charge });
    const source = counters(actual);
    const guarded = new Proxy(source, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'analysisStatus' && armed) remaining = 0;
        if (key === 'flowsStatus' && armed) laterDescriptors += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    armed = true;
    expect(deriveStored(terminalInput(actual, actual.facts, guarded)))
      .toEqual({ ok: false, reason: 'BUDGET_EXHAUSTED' });
    expect(laterDescriptors).toBe(0);
  });

  it('rejects an excessive retained-fact length before walking any element', () => {
    const actual = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true });
    let elementReads = 0;
    const oversized = new Proxy(new Array<SafeFactV2>(20_001), {
      getOwnPropertyDescriptor(target, key) {
        if (key !== 'length') elementReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(deriveStored(terminalInput(actual, oversized)))
      .toEqual({ ok: false, reason: 'INCOHERENT_EVIDENCE' });
    expect(elementReads).toBe(0);
  });

  it('refuses a retained-fact key walk only after its proportional debit', () => {
    let armed = false, callsAfterArm = 0, keyWalks = 0;
    const charge: ScanLocalChargeV1 = () => {
      if (!armed) return true;
      callsAfterArm += 1;
      return callsAfterArm === 1;
    };
    const actual = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true, charge });
    const facts = new Proxy([...actual.facts], {
      ownKeys(target) { keyWalks += 1; return Reflect.ownKeys(target); },
    });
    const guarded = new Proxy(terminalInput(actual, facts), {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'facts') armed = true;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(deriveStored(guarded)).toEqual({ ok: false, reason: 'BUDGET_EXHAUSTED' });
    expect(keyWalks).toBe(0);
  });

  it('retains supported endpoints through a measured trace omission', () => {
    const actual = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true, spanless: true });
    expect(actual.omittedTraceSteps).toBe(2);
    const result = deriveStored(terminalInput(actual));
    expect(result).toMatchObject({ ok: true, properties: { coverageStatus: 'LIMITED', fieldsExamined: 2,
      knownFields: 2, unknownFields: 0, positiveFields: 2, emittedFlows: 1,
      omittedTraceSteps: 2 } });
  });

  it('uses historical counters only to degrade a supported final publication', () => {
    const actual = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true });
    const result = deriveStored(terminalInput(actual, actual.facts,
      { ...counters(actual), suppressedRequests: 1 }));
    expect(result).toMatchObject({ ok: true, properties: { coverageStatus: 'LIMITED', fieldsExamined: 2,
      knownFields: 2, unknownFields: 0, positiveFields: 2, emittedFlows: 1, suppressedFlows: 0 } });
  });

  it('rejects a retained summary without its final emitted terminal row', () => {
    const actual = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true });
    const summary = actual.facts[1]!;
    const extraSummary: SafeFactV2 = Object.freeze({ ...summary,
      properties: Object.freeze({ ...summary.properties, sinkParameterPath: '/other' }) });
    expect(deriveStored(terminalInput(actual, [...actual.facts, extraSummary])))
      .toEqual({ ok: false, reason: 'INCOHERENT_EVIDENCE' });
  });

  it('rejects duplicate terminal candidate identity as incoherent', () => {
    const charge: ScanLocalChargeV1 = () => true;
    const log = createFlowCoverageLogV1(); log.captureCharge(charge);
    const candidate = Object.freeze({ atom: ORIGIN, sourceNode: 'a', sinkNode: 'z',
      sinkState: knownState([ORIGIN]), observation: 'TERMINAL_INPUT_READ', terminalInputRead: { channel: 'DATA' as const,
        path: ORIGIN.field, sinkParameterPath: '/command', carrier: { kind: 'PROPAGATION', node: 1,
          field: '/command', port: 0, item: 0 } }, omittedAtoms: 0, omittedTokens: 0 } satisfies ScanLocalFlowCandidateV1);
    const emit = log.wrapEmitter(() => ({ status: 'OMITTED', reason: 'UNSUPPORTED_ATOM' }));
    emit(candidate, charge); emit(candidate, charge);
    const snapshot = log.snapshot([candidate]);
    const valid: FlowCoverageCountersV1 = { analysisStatus: 'COMPLETE', flowsStatus: 'COMPLETE', analysisOmitted: 0,
      invalidRequests: 0, unmappedSources: 0, unpublishedSinks: 0, incompleteTransfers: 0, omittedRequests: 0,
      witnessUnavailable: 0, omittedTraceSteps: 0, suppressedRequests: 0 };
    expect(deriveFlowCoverageV1({ kind: 'TERMINAL', snapshot, facts: [], counters: valid }, charge))
      .toEqual({ ok: false, reason: 'INCOHERENT_EVIDENCE' });
  });
});
