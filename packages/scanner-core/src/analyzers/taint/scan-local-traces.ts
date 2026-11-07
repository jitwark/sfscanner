import type { SafeFactV2 } from '../../capabilities/scheduler';
import type { MaterializationStep } from '../taint-v2/trace-helpers';
import { materializeTraceV2, type MaterializeTraceInputV2, type MaterializeTraceResultV2 } from '../taint-v2/traces';
import type { TaintTraceStepV2 } from '../taint-v2/transfer';
import {
  createScanLocalFlowWitnessFactCacheV1, materializerFactUnits, type ScanLocalFlowFactEmitterV1,
} from './scan-local-flow-witness-facts';
import {
  createScanLocalFlowCollector, hasScanLocalAtom, isAdmissibleScanLocalCarrier,
  isAdmissibleScanLocalFlowRequest, isUniqueScanLocalCarrier, isValidScanLocalInputRead,
  type ScanLocalFlowCandidateV1, type ScanLocalFlowOutcomeV1, type ScanLocalTerminalInputReadV1,
  type ScanLocalWitnessChannelV1,
} from './scan-local-flows';
import { isKnownTerminalEmissionBoundToRead, recordAdmittedTerminalEmission } from './scan-local-terminal-binding';
import { createFlowCoverageLogV1, type FlowCoverageSnapshotV1 } from './flow-coverage-observation';
import type { FieldStateV1, ScanLocalChargeV1, TaintAtomV1 } from './scan-local-state';
import { runScanLocalWorklist, type ScanLocalPublishV1,
  type ScanLocalWitnessEventV1, type ScanLocalWorklistInputV1,
  type ScanLocalWorklistResultV1 } from './scan-local-worklist';

type WitnessChannel = ScanLocalWitnessChannelV1;
type WitnessEdge = Readonly<{ ordinal: number; channel: WitnessChannel; supported: boolean }>;
type WitnessRequest = Readonly<{ atom: TaintAtomV1; sink: string; channel: WitnessChannel;
  terminalInputRead?: ScanLocalTerminalInputReadV1 }>;
export type ScanLocalWitnessInputV1 = Readonly<{
  carriers: ReadonlyMap<string, TaintTraceStepV2>;
  sources: ReadonlyMap<string, string>;
  edges: ReadonlyMap<string, ReadonlyMap<string, WitnessEdge>>;
  requests: readonly WitnessRequest[];
  subjects: MaterializeTraceInputV2['subjects'];
  context: MaterializeTraceInputV2['context'];
  limits: MaterializeTraceInputV2['limits'];
  maxWitnessOperations: number;
  /** Optional canonical emission for each supported candidate, charged from that same publication. */
  emitFlow?: ScanLocalFlowFactEmitterV1;
}>;
export type ScanLocalWitnessResultV1 = Readonly<{
  analysis: ScanLocalWorklistResultV1;
  /** Additive: the field-flow outcome collected from the same publication-enabled run. */
  flows: ScanLocalFlowOutcomeV1;
  flowCoverage: FlowCoverageSnapshotV1;
  /** Canonical facts of the collected final candidates; empty when no emitter is configured. */
  facts: readonly SafeFactV2[];
  witnesses: readonly MaterializeTraceResultV2[];
  /** Requests = records + suppressions + omissions. */
  omittedRequests: number;
  witnessUnavailable: number;
  /** Only real materializer omissions. */
  omittedTraceSteps: number;
  /** Scoped KNOWN sanitizer suppressions counted per request. */
  suppressedRequests: number;
}>;
type Transfer = Readonly<{ input: FieldStateV1; output: FieldStateV1; runToken: object }>;
type Propagation = Readonly<{ from: string; to: string; output: FieldStateV1 }>;
type WitnessAttempt = Readonly<{ result: MaterializeTraceResultV2; measured: boolean;
  emission?: ReturnType<ScanLocalFlowFactEmitterV1> }>;
type WorklistInput = Omit<ScanLocalWorklistInputV1, 'observe' | 'publish' | 'finish'>;
/** A pre-gate refusal reports no materialized steps, so it contributes no fabricated omission. */
const gate = (): WitnessAttempt => Object.freeze({ measured: false,
  result: Object.freeze({ status: 'UNKNOWN', trace: null, omitted: 0 }) });

/** Internal reviewed carrier/edge IR only. No model authority, facts or public admission is established here. */
export function runScanLocalWithWitnesses(input: WorklistInput, witness: ScanLocalWitnessInputV1): ScanLocalWitnessResultV1 {
  if (!Number.isSafeInteger(witness.maxWitnessOperations) || witness.maxWitnessOperations < 1) {
    throw new TypeError('maxWitnessOperations must be a positive safe integer');
  }
  const transfers = new Map<string, Transfer>();
  const propagations = new Map<string, Map<string, Propagation>>();
  const terminalReadSinks = new Set(witness.requests.filter((request) => request.terminalInputRead !== undefined)
    .map((request) => request.sink));
  const terminalCandidates: ScanLocalFlowCandidateV1[] = [];
  let runToken: object | undefined;
  let pendingTransfer: Parameters<ScanLocalPublishV1>[0] | undefined;
  const witnesses: MaterializeTraceResultV2[] = [];
  let witnessUnavailable = 0;
  let omittedTraceSteps = 0;
  let suppressedRequests = 0;
  const coverageLog = createFlowCoverageLogV1();
  const factCache = createScanLocalFlowWitnessFactCacheV1(); const emitFlow = witness.emitFlow === undefined ? undefined : coverageLog.wrapEmitter(witness.emitFlow);
  const onCandidate = emitFlow === undefined ? undefined
    : (candidate: ScanLocalFlowCandidateV1, charge: ScanLocalChargeV1) => {
      factCache.record(candidate, emitFlow(candidate, charge), charge);
    };
  const flowCollector = createScanLocalFlowCollector({ sources: witness.sources,
    requests: witness.requests.filter((request) => request.terminalInputRead === undefined),
    ...(onCandidate === undefined ? {} : { onCandidate }) });
  const publish: ScanLocalPublishV1 = (publication, charge) => {
    coverageLog.captureCharge(charge); flowCollector.publish(publication, charge);
    if (runToken === undefined) runToken = publication.runToken;
    if (publication.kind === 'TRANSFER') {
      pendingTransfer = publication;
      if (terminalReadSinks.has(publication.node)) transfers.delete(publication.node);
    }
  };
  const observe = (event: ScanLocalWitnessEventV1, charge: ScanLocalChargeV1) => {
    coverageLog.captureCharge(charge); if (!charge(1)) return;
    if (event.kind === 'TRANSFER') {
      const publication = pendingTransfer;
      pendingTransfer = undefined;
      if (publication?.node === event.node && publication.state === event.output && publication.runToken === runToken) {
        transfers.set(event.node, Object.freeze({ input: event.input, output: event.output, runToken: publication.runToken }));
      }
    } else {
      const targets = propagations.get(event.from) ?? new Map<string, Propagation>();
      targets.set(event.to, Object.freeze({ from: event.from, to: event.to, output: event.output }));
      propagations.set(event.from, targets);
    }
  };
  const finish = (charge: ScanLocalChargeV1) => {
    coverageLog.captureCharge(charge); let omitted = 0;
    for (let index = 0; index < witness.requests.length; index += 1) {
      if (!charge(1)) return omitted + witness.requests.length - index;
      const request = witness.requests[index]!;
      const transfer = transfers.get(request.sink);
      let emission: ReturnType<ScanLocalFlowFactEmitterV1> | undefined, terminalCandidate: ScanLocalFlowCandidateV1 | undefined;
      let attempt: WitnessAttempt;
      if (request.terminalInputRead === undefined) {
        emission = emitFlow === undefined ? undefined
          : factCache.resolve(request.atom, request.sink, transfer?.output, charge);
        if (emission?.status === 'SUPPRESSED') { suppressedRequests += 1; continue; }
        if (emission?.status === 'EMITTED' && emission.summary.properties.edgeChannel !== request.channel) {
          witnesses.push(gate().result); witnessUnavailable += 1; omitted += 1; continue;
        }
        const facts = emission?.status === 'EMITTED' ? Object.freeze([emission.provenance, emission.summary]) : undefined;
        if (emitFlow !== undefined && facts === undefined) {
          witnesses.push(gate().result); witnessUnavailable += 1; omitted += 1; continue;
        }
        attempt = materializeSupported(request, witness, transfers, propagations, charge, facts);
      } else {
        const read = request.terminalInputRead;
        const prepareInput = transfer !== undefined && transfer.runToken === runToken && read !== undefined ? (used: ScanLocalChargeV1) => {
          const candidate: ScanLocalFlowCandidateV1 = Object.freeze({ atom: request.atom,
            sourceNode: witness.sources.get(request.atom.sourceId)!, sinkNode: request.sink,
            sinkState: transfer.input, observation: 'TERMINAL_INPUT_READ',
            terminalInputRead: read, omittedAtoms: 0, omittedTokens: 0 });
          terminalCandidates.push(candidate);
          if (emitFlow === undefined) return undefined;
          const facts = emitFlow(candidate, used);
          terminalCandidate = candidate;
          return facts;
        } : undefined;
        attempt = materializeSupported(request, witness, transfers, propagations, charge, undefined, prepareInput);
        emission = attempt.emission;
        if (emission?.status === 'EMITTED' && emission.summary?.properties?.edgeChannel !== request.channel) {
          witnesses.push(gate().result); witnessUnavailable += 1; omitted += 1; continue;
        }
        if (emitFlow !== undefined && emission?.status !== 'EMITTED') {
          witnesses.push(gate().result); witnessUnavailable += 1; omitted += 1; continue;
        }
        const cached = recordAdmittedTerminalEmission(terminalCandidate, attempt.emission, attempt.measured,
          request.channel, read, charge, (candidate, facts, used) => factCache.record(candidate, facts, used));
        if (emitFlow !== undefined && !cached) attempt = gate();
      }
      witnesses.push(attempt.result);
      if (attempt.measured) omittedTraceSteps += attempt.result.omitted;
      else { witnessUnavailable += 1; omitted += 1; }
      omitted += attempt.result.omitted;
    }
    return omitted;
  };
  const analysis = runScanLocalWorklist({ ...input, observe, publish, finish });
  // Collection still preserves every executed candidate when an early limit skips `finish`.
  const collected = flowCollector.collect(analysis);
  const outcome = terminalCandidates.length === 0 ? collected : Object.freeze({ ...collected,
    candidates: Object.freeze([...collected.candidates, ...terminalCandidates]) });
  return Object.freeze({ analysis, flows: outcome, flowCoverage: coverageLog.snapshot(outcome.candidates),
    facts: emitFlow === undefined ? Object.freeze([]) : factCache.project(outcome.candidates),
    witnesses: Object.freeze(witnesses),
    omittedRequests: witness.requests.length - witnesses.length - suppressedRequests,
    witnessUnavailable, omittedTraceSteps, suppressedRequests });
}

function materializeSupported(request: WitnessRequest, witness: ScanLocalWitnessInputV1,
  transfers: ReadonlyMap<string, Transfer>, propagations: ReadonlyMap<string, ReadonlyMap<string, Propagation>>,
  charge: ScanLocalChargeV1, facts?: readonly SafeFactV2[],
  prepareInput?: (charge: ScanLocalChargeV1) => ReturnType<ScanLocalFlowFactEmitterV1> | undefined): WitnessAttempt {
  if (!charge(1)) return gate();
  const source = witness.sources.get(request.atom.sourceId);
  // The collector's own request admissibility applies here too: an unnamed source, empty sink,
  // reserved channel or invalid field path is never a required witness.
  const terminalState = request.terminalInputRead === undefined
    ? transfers.get(request.sink)?.output : transfers.get(request.sink)?.input;
  if (!isAdmissibleScanLocalFlowRequest(request.atom, request.sink) || source === undefined || source.length === 0
    || !hasScanLocalAtom(transfers.get(source)?.output, request.atom, charge)
    || !hasScanLocalAtom(terminalState, request.atom, charge)
    || (request.terminalInputRead !== undefined && !terminalReadValid(request, witness, charge))) return gate();
  const root = witness.carriers.get(source);
  const terminal = witness.carriers.get(request.sink);
  if (!isAdmissibleScanLocalCarrier(root, charge) || !isAdmissibleScanLocalCarrier(terminal, charge)) return gate();
  const inputRead = request.terminalInputRead !== undefined;
  if (inputRead && source === request.sink) return gate();
  const steps: MaterializationStep[] = [Object.freeze({ ...root, kind: 'SOURCE' })];
  const identities = new Map<string, string>();
  if (!isUniqueScanLocalCarrier(source, root, identities, charge)) return gate();
  if (source === request.sink) steps.push(Object.freeze({ ...terminal, kind: 'SINK' }));
  else {
    let terminalNode = source;
    for (const targets of propagations.values()) {
      if (!charge(1)) return gate();
      for (const edge of targets.values()) {
        if (!charge(1)) return gate();
        if (inputRead && (terminalNode === request.sink || edge.from !== terminalNode)) continue;
        const model = witness.edges.get(edge.from)?.get(edge.to);
        if (model?.supported !== true || model.channel !== request.channel || edge.to === source
          || inputRead && (!Number.isSafeInteger(model.ordinal) || model.ordinal < 0)) continue;
        if (!hasScanLocalAtom(edge.output, request.atom, charge)
          || !hasScanLocalAtom(transfers.get(edge.from)?.output, request.atom, charge)
          || !hasScanLocalAtom(transfers.get(edge.to)?.input, request.atom, charge)
          || (request.terminalInputRead === undefined || edge.to !== request.sink)
            && !hasScanLocalAtom(transfers.get(edge.to)?.output, request.atom, charge)) continue;
        const from = witness.carriers.get(edge.from);
        const to = witness.carriers.get(edge.to);
        if (!isAdmissibleScanLocalCarrier(from, charge) || !isAdmissibleScanLocalCarrier(to, charge)
          || !isUniqueScanLocalCarrier(edge.from, from, identities, charge)
          || !isUniqueScanLocalCarrier(edge.to, to, identities, charge)) return gate();
        if (!charge(1)) return gate();
        steps.push(Object.freeze({ ...to,
          kind: edge.to === request.sink ? 'SINK' : to.kind === 'SANITIZER' ? 'SANITIZER' : 'PROPAGATION',
          predecessor: Object.freeze({ node: from.node, edge: model.ordinal, field: from.field, item: from.item }),
        }));
        if (inputRead) terminalNode = edge.to;
      }
    }
    if (!charge(steps.length)) return gate();
    if (!steps.some((step) => step.kind === 'SINK') || inputRead && terminalNode !== request.sink) return gate();
  }
  const emission = prepareInput?.(charge);
  if (emission !== undefined && emission.status !== 'EMITTED') return Object.freeze({ ...gate(), emission });
  // Reserve before calling the existing selector; its graph counter is a bounded reservation,
  // not an independent worklist allowance. Unused reservation is deliberately not refunded.
  if (!charge(witness.maxWitnessOperations)) return gate();
  if (emission !== undefined && (emission.summary?.properties?.edgeChannel !== request.channel
    || inputRead && !isKnownTerminalEmissionBoundToRead(emission, request.channel, request.terminalInputRead!))) {
    return Object.freeze({ ...gate(), emission });
  }
  const materialFacts = emission?.status === 'EMITTED'
    ? Object.freeze([emission.provenance, emission.summary]) : facts;
  // Fact admission rehashes, canonicalizes and serializes evidence outside the graph counter.
  if (materialFacts !== undefined && !charge(materializerFactUnits(materialFacts))) return gate();
  return Object.freeze({ measured: true, ...(emission === undefined ? {} : { emission }),
    result: materializeTraceV2({ kind: request.atom.channel, steps, subjects: witness.subjects,
    context: witness.context, limits: witness.limits, graphBudget: witness.maxWitnessOperations,
    ...(materialFacts === undefined ? {} : { facts: materialFacts }) }) });
}

function terminalReadValid(request: WitnessRequest, witness: ScanLocalWitnessInputV1,
  charge: ScanLocalChargeV1): boolean {
  return isValidScanLocalInputRead(request.terminalInputRead, request.channel, request.atom, request.sink,
    witness.carriers.get(request.sink), charge);
}
