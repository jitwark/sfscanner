import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { validateFieldFlowCoherenceV1 } from '../../../../../contracts/scanner-v2-field-flow-coherence';
import { createSafeFactAdmissionSnapshotV2 } from '../../admission/snapshot';
import type { SafeFactV2, SubjectV2 } from '../../capabilities/scheduler';
import { SAFE_FACT_REGISTRY_V2 } from '../../facts/safe-fact-registry';
import { validateSafeFact } from '../../facts/safe-fact-validator';
import { createNodeIdentityDigest } from '../../workflow-v2/node-edge-identity';
import { withFlowCoverageChargeV1 } from './flow-coverage-observation';
import type { ScanLocalFlowFactsV1 } from './scan-local-flow-facts';
import type { ScanLocalFlowCandidateV1 } from './scan-local-flows';
import { createScanLocalFlowFactEmitterV1, type ScanLocalFlowSinkSpecV1 } from './scan-local-flow-witness-facts';
import {
  SCAN_LOCAL_LIMITS_V1, knownState, unknownState,
  type FieldStateV1, type ScanLocalChargeV1, type TaintAtomV1,
} from './scan-local-state';
import { createScanLocalTransfer, type FieldTransferModelV1 } from './scan-local-transfer';
import { runScanLocalWithWitnesses, type ScanLocalWitnessInputV1, type ScanLocalWitnessResultV1 } from './scan-local-traces';
import { taintSourceLabelsFor } from './taint-sources';

const ORIGIN: TaintAtomV1 = { sourceId: 'origin', field: ['body'], channel: 'INTEGRITY' };
const DEEP: TaintAtomV1 = Object.freeze({ sourceId: 'deep', channel: 'INTEGRITY',
  field: Object.freeze(Array.from({ length: SCAN_LOCAL_LIMITS_V1.maxPathDepth + 1 }, (_, index) => `s${index}`)) });
const CONTEXT = { semanticSha256: 'e'.repeat(64) };
const SINK: ScanLocalFlowSinkSpecV1 = { sinkClass: 'COMMAND', sinkFieldPath: ['command'],
  sinkParameterPath: '/command', sinkChannel: 'TOOL', edgeChannel: 'DATA' };
type RequestV1 = ScanLocalWitnessInputV1['requests'][number];

const subject = (ordinal: number, spanless: boolean, occurrencePath?: readonly number[]): SubjectV2 => {
  const position = (offset: number) => ({ line: 1, column: offset + 1, utf16Offset: offset, utf8ByteOffset: offset });
  const source = { pointer: `/nodes/${ordinal}`, occurrencePath: occurrencePath ?? [ordinal], astNodeId: 'a'.repeat(64),
    span: spanless ? null : { start: position(ordinal), end: position(ordinal + 1) } };
  return { kind: 'NODE', node: { ordinal, source, identityDigest: createNodeIdentityDigest(ordinal, source) } };
};
const admitted = (fact: SafeFactV2): boolean => {
  const schema = SAFE_FACT_REGISTRY_V2.schemas.find((entry) => entry.kind === fact.kind);
  if (schema === undefined) throw new Error('Missing actual fact schema');
  return validateSafeFact(createSafeFactAdmissionSnapshotV2(fact), schema, DEFAULT_SCANNER_LIMITS_V2).ok;
};

type RunOptionsV1 = Readonly<{
  graph: ReadonlyMap<string, readonly string[]>;
  models?: ReadonlyMap<string, FieldTransferModelV1>;
  transfer?: (node: string, state: FieldStateV1, charge: ScanLocalChargeV1) => FieldStateV1;
  spanless?: boolean;
  occurrencePath?: readonly number[];
  sources?: ReadonlyMap<string, string>;
  initialState?: FieldStateV1;
  requests?: readonly RequestV1[];
  maxOperations?: number;
  charge?: ScanLocalChargeV1;
  maxWitnessOperations?: number;
  emitter?: boolean;
  terminalInputRead?: boolean;
  terminalChannel?: 'DATA' | 'TOOL';
  emitterSinkParameterPath?: string;
  emitterSourcePath?: 'summary' | 'provenance';
  unsupportedEdges?: boolean;
  emissions?: ScanLocalFlowFactsV1[];
}>;

/** The real runner, transfer, emitter, worklist and materializer: no part of the slice is simulated. */
function run(options: RunOptionsV1): ScanLocalWitnessResultV1 {
  const { graph } = options;
  const nodes = [...new Set([...graph.keys(), ...[...graph.values()].flat()])].sort();
  const carriers = new Map(nodes.map((node, ordinal) => [node, { kind: 'PROPAGATION' as const, node: ordinal,
    field: options.terminalInputRead === true && node === 'z' ? '/command' : '/value', port: 0, item: 0 }]));
  const subjects = new Map(nodes.map((_, ordinal) =>
    [ordinal, subject(ordinal, options.spanless === true, options.occurrencePath)]));
  const base = createScanLocalFlowFactEmitterV1({ carriers, subjects,
    sinks: new Map(nodes.map((node) => [node, { ...SINK,
      sinkParameterPath: options.emitterSinkParameterPath ?? SINK.sinkParameterPath }])), taintLabels: ['MODEL_OUTPUT'],
    limits: DEFAULT_SCANNER_LIMITS_V2 });
  const emissions = options.emissions;
  const emitFlow = emissions === undefined && options.emitterSourcePath === undefined ? base
    : (candidate: ScanLocalFlowCandidateV1, charge: ScanLocalChargeV1) => {
      const facts = base(candidate, charge);
      const forged = facts.status === 'EMITTED' && options.emitterSourcePath === 'summary'
        ? Object.freeze({ ...facts, summary: Object.freeze({ ...facts.summary,
          properties: Object.freeze({ ...facts.summary.properties, sourceFieldPath: Object.freeze(['forged']) }) }) })
        : facts.status === 'EMITTED' && options.emitterSourcePath === 'provenance'
          ? Object.freeze({ ...facts, provenance: Object.freeze({ ...facts.provenance,
            properties: Object.freeze({ ...facts.provenance.properties, sourceFieldPath: Object.freeze(['forged']) }) }) })
          : facts;
      emissions?.push(forged);
      return forged;
    };
  const requests: readonly RequestV1[] = options.requests ?? [{ atom: ORIGIN, sink: 'z', channel: 'DATA',
    ...(options.terminalInputRead === true ? { terminalInputRead: { channel: 'DATA', path: ORIGIN.field,
      sinkParameterPath: '/command', carrier: carriers.get('z')! } } : {}) }];
  return runScanLocalWithWitnesses({
    entry: 'a', graph, initialState: options.initialState ?? knownState([ORIGIN]),
    transfer: options.transfer ?? createScanLocalTransfer(new Map(nodes.map((node) => [node,
      options.models?.get(node) ?? { kind: 'COPY' as const }]))),
    maxStates: 20, maxOperations: options.maxOperations ?? 100_000,
    ...(options.charge === undefined ? {} : { charge: options.charge }),
  }, {
    carriers, sources: options.sources ?? new Map([['origin', 'a']]),
    edges: new Map([...graph].map(([from, targets]) => [from, new Map(targets.map((to, ordinal) =>
      [to, { ordinal, channel: 'DATA' as const, supported: options.unsupportedEdges !== true }]))])),
    requests: requests.map((request) => ({ ...request, channel: options.terminalChannel ?? request.channel,
      ...(request.terminalInputRead === undefined ? {} : { terminalInputRead: { ...request.terminalInputRead,
        channel: options.terminalChannel ?? request.terminalInputRead.channel } }) })),
    subjects, context: CONTEXT, limits: { maxTraceStepsPerFinding: 100, maxEvidenceBytes: 100_000 },
    maxWitnessOperations: options.maxWitnessOperations ?? 10_000,
    ...(options.emitter === false ? {} : { emitFlow }),
  });
}

describe('connected canonical flow facts and witnesses', () => {
  it('materializes a trace whose endpoints resolve to the emitted canonical facts', () => {
    const labels = taintSourceLabelsFor('n8n-nodes-base.webhook');
    expect(labels).toEqual(['WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER']);
    expect(Object.isFrozen(labels)).toBe(true);
    expect([taintSourceLabelsFor('n8n-nodes-base.manualTrigger'), taintSourceLabelsFor('unknown.node')]).toEqual([undefined, undefined]);
    const result = run({ graph: new Map([['a', ['m']], ['m', ['z']]]) });
    expect(result.analysis.status).toBe('COMPLETE');
    expect(result.witnesses[0]?.status).toBe('COMPLETE');
    const trace = result.witnesses[0]!.trace!;
    expect(trace.steps.map((step) => step.kind)).toEqual(['SOURCE', 'PROPAGATION', 'SINK']);
    const [provenance, summary] = result.facts;
    if (provenance === undefined || summary === undefined) throw new Error('Expected both canonical facts');
    expect(provenance.kind).toBe('dataflow.provenance.v1');
    expect(summary.kind).toBe('dataflow.summary.v3');
    expect(summary.properties.sourceProvenanceFactId).toBe(provenance.factId);
    expect(admitted(provenance) && admitted(summary)).toBe(true);
    expect(trace.steps[0]!.factRefs).toContain(provenance.factId);
    expect(trace.steps[1]!.factRefs).toEqual([]);
    expect(trace.steps[2]!.factRefs).toContain(summary.factId);
    expect(result).toMatchObject({ omittedRequests: 0, witnessUnavailable: 0, omittedTraceSteps: 0, suppressedRequests: 0 });
  });

  it('resolves both endpoint roles of a same-node flow to both canonical facts', () => {
    const result = run({ graph: new Map([['a', []]]),
      requests: [{ atom: ORIGIN, sink: 'a', channel: 'DATA' }] });
    const trace = result.witnesses[0]!.trace!;
    expect(trace.steps.map((step) => step.kind)).toEqual(['SOURCE', 'SINK']);
    const refs = result.facts.map((fact) => fact.factId).sort();
    expect(refs).toHaveLength(2);
    expect(trace.steps[0]!.factRefs).toEqual(refs);
    expect(trace.steps[1]!.factRefs).toEqual(refs);
  });
  it('uses the paid sink input read when its transfer output is UNKNOWN', () => {
    const emissions: ScanLocalFlowFactsV1[] = [];
    const result = run({ graph: new Map([['a', ['z']]]), emissions, terminalInputRead: true,
      transfer: (node) => node === 'z' ? unknownState('UNMODELLED_TRANSFER') : knownState([ORIGIN]) });
    expect(result.analysis.states.get('z')).toMatchObject({ knowledge: 'UNKNOWN', atoms: [],
      unknownReasons: ['UNMODELLED_TRANSFER'] });
    expect(result.flows.candidates[0]).toMatchObject({ observation: 'TERMINAL_INPUT_READ', sinkState: { knowledge: 'KNOWN', atoms: [ORIGIN] } });
    expect(result.facts).toHaveLength(2);
    const summary = result.facts[1]!;
    expect(summary.properties).toMatchObject({ knowledge: 'KNOWN', sinkParameterPath: '/command', sourceProvenanceFactId: result.facts[0]?.factId });
    expect(admitted(summary)).toBe(true);
    expect(result.witnesses[0]?.trace?.steps.map((step) => step.factRefs)).toEqual([[result.facts[0]?.factId], [result.facts[1]?.factId]]);
    expect(emissions).toHaveLength(1);
    expect(result.witnesses[0]?.status).toBe('COMPLETE');
    expect(result.witnesses[0]?.trace?.steps.map((step) => step.kind)).toEqual(['SOURCE', 'SINK']);
    expect(result).toMatchObject({ witnessUnavailable: 0, omittedTraceSteps: 0, omittedRequests: 0 });
    expect(result.flowCoverage.status).toBe('OBSERVED');
    if (result.flowCoverage.status !== 'OBSERVED') throw new Error('Expected observed flow coverage');
    expect(result.flowCoverage.rows).toHaveLength(1);
    expect(result.flowCoverage.rows[0]?.candidate).toBe(result.flows.candidates[0]);
    expect(result.flowCoverage.rows[0]?.emission).toBe(emissions[0]);
    expect(withFlowCoverageChargeV1(result.flowCoverage, (charge) => charge(0)))
      .toEqual({ ok: true, value: true });
  });
  it('materializes a terminal read without facts when no emitter is configured', () => {
    const result = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true, emitter: false });
    expect(result.flows.candidates).toMatchObject([{ observation: 'TERMINAL_INPUT_READ' }]);
    expect(result.facts).toEqual([]);
    expect(result.witnesses[0]).toMatchObject({ status: 'COMPLETE' });
    expect(result.witnesses[0]?.trace?.steps.map((step) => step.kind)).toEqual(['SOURCE', 'SINK']);
    expect(result).toMatchObject({ witnessUnavailable: 0, omittedTraceSteps: 0, omittedRequests: 0 });
  });
  it('rejects an emitted summary outside the observed terminal path while retaining a matching control', () => {
    const graph = new Map([['a', ['z']]]);
    const matched = run({ graph, terminalInputRead: true });
    expect(matched.facts[1]?.properties).toMatchObject({ knowledge: 'KNOWN', sinkParameterPath: '/command' });
    expect(matched.witnesses[0]?.status).toBe('COMPLETE');

    const emissions: ScanLocalFlowFactsV1[] = [];
    const mismatched = run({ graph, terminalInputRead: true, emitterSinkParameterPath: '/parameters/cmd', emissions });
    expect(emissions[0]).toMatchObject({ status: 'EMITTED', summary: { properties: {
      knowledge: 'KNOWN', sinkParameterPath: '/parameters/cmd', edgeChannel: 'DATA',
    } } });
    expect(mismatched.flows.candidates).toHaveLength(1);
    expect(mismatched.facts).toEqual([]);
    expect(mismatched.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 0 });
    expect(mismatched).toMatchObject({ analysis: { status: 'LIMITED' }, witnessUnavailable: 1,
      omittedTraceSteps: 0, omittedRequests: 0, suppressedRequests: 0 });
  });
  it('rejects forged summary and provenance source paths against the observed terminal read', () => {
    for (const emitterSourcePath of ['summary', 'provenance'] as const) {
      const emissions: ScanLocalFlowFactsV1[] = [];
      const result = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true,
        emitterSourcePath, emissions });
      expect(emissions[0]).toMatchObject({ status: 'EMITTED', summary: { properties: { knowledge: 'KNOWN' } } });
      expect(result.flows.candidates).toHaveLength(1);
      expect(result.facts).toEqual([]);
      expect(result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 0 });
      expect(result).toMatchObject({ analysis: { status: 'LIMITED' }, witnessUnavailable: 1,
        omittedTraceSteps: 0, omittedRequests: 0, suppressedRequests: 0 });
    }
  });
  it('keeps a matching-path terminal fact unassociated when witness admission is refused', () => {
    const graph = new Map([['a', ['z']]]);
    const matched = run({ graph, terminalInputRead: true, maxOperations: 100_000,
      maxWitnessOperations: 10_000 });
    expect(matched.facts.map((fact) => fact.kind)).toEqual([
      'dataflow.provenance.v1', 'dataflow.summary.v3',
    ]);
    expect(matched.witnesses[0]).toMatchObject({ status: 'COMPLETE' });

    const emissions: ScanLocalFlowFactsV1[] = [];
    const result = run({ graph, terminalInputRead: true, maxOperations: 10_000,
      maxWitnessOperations: 10_000, emissions });
    expect(result.flows.candidates).toHaveLength(1);
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({ status: 'EMITTED', summary: { properties: {
      knowledge: 'KNOWN', sinkParameterPath: '/command', edgeChannel: 'DATA',
    } } });
    expect(result.analysis.status).toBe('LIMITED');
    expect(result.analysis.omitted).toBeGreaterThan(0);
    expect(result.facts).toEqual([]);
    expect(result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 0 });
    expect(result).toMatchObject({ witnessUnavailable: 1, omittedTraceSteps: 0,
      omittedRequests: 0, suppressedRequests: 0 });
  });
  it('withholds a terminal trace when either fact debit refuses', () => {
    const graph = new Map([['a', ['z']]]);
    const bounded = (budget: number) => {
      let paid = 0, refused = 0;
      return { paid: () => paid, refused: () => refused, result: run({ graph, terminalInputRead: true, charge: (units) => {
        if (units > budget - paid) { refused = units; return false; }
        paid += units;
        return true;
      } }) };
    };
    const materializerDebit = bounded(25_012);
    expect(materializerDebit.paid()).toBe(12_473);
    expect(materializerDebit.refused()).toBe(12_541);
    expect(materializerDebit.result.flows.candidates).toHaveLength(1);
    expect(materializerDebit.result.facts).toEqual([]);
    expect(materializerDebit.result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 0 });
    expect(materializerDebit.result).toMatchObject({ analysis: { status: 'LIMITED' }, witnessUnavailable: 1,
      omittedTraceSteps: 0, omittedRequests: 0, suppressedRequests: 0 });
    expect(materializerDebit.result.flowCoverage).toEqual({ status: 'REFUSED', reason: 'BUDGET_EXHAUSTED' });

    const cacheDebit = bounded(25_014);
    expect(cacheDebit.paid()).toBe(25_014);
    expect(cacheDebit.refused()).toBe(26);
    expect(cacheDebit.result.flows.candidates).toHaveLength(1);
    expect(cacheDebit.result.facts).toEqual([]);
    expect(cacheDebit.result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 0 });
    expect(cacheDebit.result).toMatchObject({ analysis: { status: 'LIMITED' }, witnessUnavailable: 1,
      omittedTraceSteps: 0, omittedRequests: 0, suppressedRequests: 0 });
    expect(cacheDebit.result.flowCoverage).toEqual({ status: 'REFUSED', reason: 'BUDGET_EXHAUSTED' });
  });
  it('returns a post-collection telemetry refusal without rewriting a complete terminal run', () => {
    const graph = new Map([['a', ['z']]]);
    let total = 0;
    const complete = run({ graph, terminalInputRead: true,
      charge: (units) => { total += units; return true; } });
    expect(complete.analysis.status).toBe('COMPLETE');
    expect(complete.flowCoverage.status).toBe('OBSERVED');

    let paid = 0;
    const refused = run({ graph, terminalInputRead: true, charge: (units) => {
      if (units > total - 1 - paid) return false;
      paid += units;
      return true;
    } });
    expect(refused.analysis.status).toBe('COMPLETE');
    expect(refused.flows.candidates).toHaveLength(1);
    expect(refused.witnesses[0]?.status).toBe('COMPLETE');
    expect(refused.facts).toHaveLength(2);
    expect(refused.flowCoverage).toEqual({ status: 'REFUSED', reason: 'BUDGET_EXHAUSTED' });
  });
  it('does not treat an unscoped terminal suppression as a completed sanitizer decision', () => {
    const emissions: ScanLocalFlowFactsV1[] = [];
    const result = run({ graph: new Map([['a', ['m']], ['m', ['z']]]), terminalInputRead: true,
      emitterSinkParameterPath: '/parameters/cmd', emissions,
      models: new Map([['m', { kind: 'SANITIZE', calleesOutermostFirst: ['Number'], binding: 'REVIEWED',
        sink: 'COMMAND', path: ['command'] }]]) });
    expect(emissions[0]?.status).toBe('SUPPRESSED');
    expect(result.flows.candidates).toHaveLength(1);
    expect(result.facts).toEqual([]);
    expect(result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 0 });
    expect(result).toMatchObject({ analysis: { status: 'LIMITED' }, suppressedRequests: 0,
      witnessUnavailable: 1, omittedTraceSteps: 0, omittedRequests: 0 });
    expect(result.flowCoverage.status).toBe('OBSERVED');
    if (result.flowCoverage.status !== 'OBSERVED') throw new Error('Expected observed flow coverage');
    expect(result.flowCoverage.rows[0]?.candidate).toBe(result.flows.candidates[0]);
    expect(result.flowCoverage.rows[0]?.emission.status).toBe('SUPPRESSED');
  });
  it('keeps an UNKNOWN terminal summary unavailable even when its observed scope matches', () => {
    const emissions: ScanLocalFlowFactsV1[] = [];
    const invalidSanitizer = { modelId: 'unreviewed', sink: 'COMMAND', pathDigest: 'not-a-digest' };
    const result = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true, emissions,
      initialState: knownState([ORIGIN], [invalidSanitizer]) });
    expect(emissions[0]).toMatchObject({ status: 'EMITTED', summary: { properties: {
      knowledge: 'UNKNOWN', sinkParameterPath: '/command', edgeChannel: 'DATA',
    } } });
    expect(result.facts).toEqual([]);
    expect(result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 0 });
    expect(result).toMatchObject({ analysis: { status: 'LIMITED' }, suppressedRequests: 0,
      witnessUnavailable: 1, omittedTraceSteps: 0, omittedRequests: 0 });
    expect(result.flowCoverage.status).toBe('OBSERVED');
    if (result.flowCoverage.status !== 'OBSERVED') throw new Error('Expected observed flow coverage');
    expect(result.flowCoverage.rows[0]?.candidate).toBe(result.flows.candidates[0]);
    expect(result.flowCoverage.rows[0]?.emission).toMatchObject({
      status: 'EMITTED', summary: { properties: { knowledge: 'UNKNOWN' } },
    });
  });
  it('refuses unpaid, stale, absent, wrong-channel, and unsupported input reads', () => {
    const direct = new Map([['a', ['z']]]);
    const unpaid = run({ graph: direct, terminalInputRead: true, maxOperations: 1 });
    expect(unpaid).toMatchObject({ analysis: { status: 'LIMITED' }, flows: { candidates: [] }, witnesses: [],
      omittedRequests: 1, omittedTraceSteps: 0 });
    const absent = run({ graph: direct, terminalInputRead: true,
      transfer: (node) => node === 'a' ? knownState() : unknownState('UNMODELLED_TRANSFER') });
    expect(absent.flows.candidates).toEqual([]);
    expect(absent.facts).toEqual([]);
    expect(absent.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 0 });
    const wrongChannel = run({ graph: direct, terminalInputRead: true, terminalChannel: 'TOOL' });
    expect(wrongChannel.flows.candidates).toEqual([]);
    expect(wrongChannel.facts).toEqual([]);
    expect(wrongChannel.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 0 });
    const unsupported = run({ graph: direct, terminalInputRead: true, unsupportedEdges: true });
    expect(unsupported.flows.candidates).toEqual([]);
    expect(unsupported.facts).toEqual([]);
    expect(unsupported.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 0 });
    const stale = run({ graph: new Map([['a', ['z', 'zz']], ['zz', ['z']]]), terminalInputRead: true,
      models: new Map([['zz', { kind: 'UNKNOWN', reason: 'UNMODELLED_TRANSFER' }]]) });
    expect(stale.flows.candidates).toEqual([]);
    expect(stale.facts).toEqual([]);
    expect(stale.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 0 });
  });

  it('stops the terminal read at the sink and does not propagate its output downstream', () => {
    const result = run({ graph: new Map([['a', ['z']], ['z', ['d']]]), terminalInputRead: true,
      transfer: (node, state) => node === 'z' ? unknownState('UNMODELLED_TRANSFER')
        : node === 'a' ? knownState([ORIGIN]) : state });
    expect(result.flows.candidates).toMatchObject([{ sinkNode: 'z', observation: 'TERMINAL_INPUT_READ',
      sinkState: { knowledge: 'KNOWN', atoms: [ORIGIN] } }]);
    expect(result.analysis.states.get('z')).toMatchObject({ knowledge: 'UNKNOWN', atoms: [] });
    expect(result.analysis.states.get('d')).toMatchObject({ knowledge: 'UNKNOWN', atoms: [] });
    expect(result.witnesses[0]?.trace?.steps.map((step) => step.kind)).toEqual(['SOURCE', 'SINK']);
  });
  it('retains spanless valid NODE facts even though the materializer cannot resolve them', () => {
    const result = run({ graph: new Map([['a', ['z']]]), spanless: true });
    expect(result.facts).toHaveLength(2);
    expect(admitted(result.facts[1]!)).toBe(true);
    // Missing endpoint spans produce two measured materializer omissions, not pre-gate counts.
    expect(result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 2 });
    expect(result).toMatchObject({ witnessUnavailable: 0, omittedTraceSteps: 2, omittedRequests: 0 });
  });
  it('retains a terminal fact association through measured spanless omission', () => {
    const result = run({ graph: new Map([['a', ['z']]]), terminalInputRead: true, spanless: true });
    expect(result.flows.candidates).toMatchObject([{ observation: 'TERMINAL_INPUT_READ' }]);
    expect(result.facts).toHaveLength(2);
    expect(result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 2 });
    expect(result).toMatchObject({ witnessUnavailable: 0, omittedTraceSteps: 2, omittedRequests: 0 });
  });

  it('treats an exact scoped KNOWN sanitizer as suppression, not a missing witness', () => {
    const emissions: ScanLocalFlowFactsV1[] = [];
    const result = run({ graph: new Map([['a', ['z']]]), emissions,
      models: new Map([['z', { kind: 'SANITIZE', calleesOutermostFirst: ['Number'], binding: 'REVIEWED',
        sink: 'COMMAND', path: ['command'] }]]) });
    expect(emissions[0]?.status).toBe('SUPPRESSED');
    expect(result.witnesses).toEqual([]);
    // The validated provenance survives as unreferenced origin evidence; no summary is claimed.
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.kind).toBe('dataflow.provenance.v1');
    expect(admitted(result.facts[0]!)).toBe(true);
    expect(result).toMatchObject({ suppressedRequests: 1, witnessUnavailable: 0, omittedTraceSteps: 0,
      omittedRequests: 0 });
    expect(result.analysis.status).toBe('COMPLETE');
  });

  it('projects one canonical provenance for one origin across two sinks', () => {
    const requests: readonly RequestV1[] = [
      { atom: ORIGIN, sink: 'z1', channel: 'DATA' },
      { atom: ORIGIN, sink: 'z2', channel: 'DATA' },
    ];
    const result = run({ graph: new Map([['a', ['z1', 'z2']]]), requests });
    expect(result.facts.map((fact) => fact.kind)).toEqual([
      'dataflow.provenance.v1', 'dataflow.summary.v3', 'dataflow.summary.v3',
    ]);
    const ids = result.facts.map((fact) => fact.factId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(validateFieldFlowCoherenceV1(result.facts)).toBe(true);
    expect(result.witnesses.map((witness) => witness.status)).toEqual(['COMPLETE', 'COMPLETE']);
    expect(result).toMatchObject({ omittedRequests: 0, suppressedRequests: 0 });
  });

  it('refuses at the real publication when the run cannot prepay the actual facts', () => {
    const emissions: ScanLocalFlowFactsV1[] = [];
    const result = run({ graph: new Map([['a', ['z']], ['z', []]]), maxOperations: 100, emissions,
      occurrencePath: Array.from({ length: 8 }, (_, index) => index) });
    expect(emissions).toEqual([{ status: 'OMITTED', reason: 'BUDGET_EXHAUSTED' }]);
    expect(result.analysis.status).toBe('LIMITED');
    expect(result.flows).toMatchObject({ candidates: [], unpublishedSinks: 1, incompleteTransfers: 1 });
    expect(result.witnesses).toEqual([]);
    expect(result.facts).toEqual([]);
    expect(result).toMatchObject({ omittedRequests: 1, witnessUnavailable: 0, omittedTraceSteps: 0 });
  });

  it('refuses an unmapped or empty source request at the witness gate with no fabricated omission', () => {
    const unnamed: TaintAtomV1 = { sourceId: '', field: ['body'], channel: 'INTEGRITY' };
    const result = run({ graph: new Map([['a', ['z']]]), emitter: false,
      initialState: knownState([unnamed]), sources: new Map([['', 'a']]),
      requests: [{ atom: unnamed, sink: 'z', channel: 'DATA' }] });
    expect(result.flows).toMatchObject({ invalidRequests: 1, candidates: [] });
    expect(result.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 0 });
    expect(result).toMatchObject({ witnessUnavailable: 1, omittedTraceSteps: 0, omittedRequests: 0 });
    expect(result.analysis.status).toBe('LIMITED');
    const emptySource = run({ graph: new Map([['a', ['z']]]), emitter: false,
      sources: new Map([['origin', '']]), requests: [{ atom: ORIGIN, sink: 'z', channel: 'DATA' }] });
    expect(emptySource.flows).toMatchObject({ unmappedSources: 1, candidates: [] });
    expect(emptySource.witnesses[0]).toMatchObject({ status: 'UNKNOWN', trace: null, omitted: 0 });
    expect(emptySource).toMatchObject({ witnessUnavailable: 1, omittedTraceSteps: 0 });
    expect(emptySource.analysis.status).toBe('LIMITED');
  });
});
