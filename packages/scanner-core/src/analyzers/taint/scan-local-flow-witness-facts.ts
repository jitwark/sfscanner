import type { ScannerLimitsV2 } from '@hub/contracts';
import type { SafeFactV2, SubjectV2 } from '../../capabilities/scheduler';
import type { TaintTraceStepV2 } from '../taint-v2/transfer';
import {
  emitScanLocalFlowFacts, type ScanLocalFlowFactsV1, type ScanLocalFlowOmissionReasonV1,
} from './scan-local-flow-facts';
import type { ScanLocalFlowCandidateV1 } from './scan-local-flows';
import {
  atomKey, type FieldStateV1, type ScanLocalChargeV1, type TaintAtomV1,
} from './scan-local-state';

/**
 * Reviewed sink semantics for one actual sink node. `sinkChannel` is the sink's own input channel.
 * PRECONDITION: `edgeChannel` MUST be the channel of the actual supported terminal edge for this
 * sink. It never authorizes inventing or relabelling a terminal edge; aligning it with each witness
 * request channel remains the reviewed caller's responsibility. A mismatch fails the witness
 * closed, while the summary stays withheld from consumers that require the actual edge (this
 * internal constructor carries no model/edge authority of its own).
 */
export type ScanLocalFlowSinkSpecV1 = Readonly<{
  sinkClass: string;
  sinkFieldPath: readonly string[];
  sinkParameterPath: string;
  sinkChannel: string;
  edgeChannel: string;
}>;
/**
 * Reviewed caller wiring for one run: the runner's own node -> carrier ordinal view, the reviewed
 * per-sink semantics (including the terminal `edgeChannel` precondition), and the run limits.
 * This is a trusted internal constructor: it establishes no edge, model or public admission
 * authority, and the production compiler plus same-node channel authority remain pending.
 */
export type ScanLocalFlowFactEmitterInputV1 = Readonly<{
  /** The runner's own node -> carrier ordinal view, so a fact subject is a real trace endpoint. */
  carriers: ReadonlyMap<string, TaintTraceStepV2>;
  subjects: ReadonlyMap<number, SubjectV2>;
  sinks: ReadonlyMap<string, ScanLocalFlowSinkSpecV1>;
  taintLabels: readonly string[];
  limits: ScannerLimitsV2;
  propertyPath?: string;
}>;
/** One real factory call per supported candidate, paid from that publication's own counter. */
export type ScanLocalFlowFactEmitterV1 =
  (candidate: ScanLocalFlowCandidateV1, charge: ScanLocalChargeV1) => ScanLocalFlowFactsV1;

/** Worst case for one UTF-16 unit through JSON escaping, UTF-8 framing and identity encoding. */
const WIRE_UNITS_PER_CODE_UNIT = 6;
/** One slot is prepaid for each recorded emission's place in the final projection. */
const PROJECTION_SLOT_UNITS = 1;
/** Two constant endpoint lookups (carrier ordinal and subject) before any factory guard. */
const EMITTER_LOOKUP_UNITS = 2;
const MAX_WALK_DEPTH = 4;
const MAX_WALK_SLOTS = 64;

function omitted(reason: ScanLocalFlowOmissionReasonV1): ScanLocalFlowFactsV1 {
  return Object.freeze({ status: 'OMITTED', reason });
}

/** The reviewed caller closure: subjects are the runner's own carriers, never a second resolution. */
export function createScanLocalFlowFactEmitterV1(
  input: ScanLocalFlowFactEmitterInputV1,
): ScanLocalFlowFactEmitterV1 {
  return (candidate, charge) => {
    // Both endpoint reads are constant work; a refusal performs none of the factory's guards.
    if (!charge(EMITTER_LOOKUP_UNITS)) return omitted('BUDGET_EXHAUSTED');
    const source = input.carriers.get(candidate.sourceNode);
    const sink = input.carriers.get(candidate.sinkNode);
    const spec = input.sinks.get(candidate.sinkNode);
    const sourceSubject = source === undefined ? undefined : input.subjects.get(source.node);
    const sinkSubject = sink === undefined ? undefined : input.subjects.get(sink.node);
    if (sourceSubject === undefined || sinkSubject === undefined) return omitted('INVALID_SUBJECT');
    if (spec === undefined) return omitted('INVALID_PROPERTY');
    return emitScanLocalFlowFacts({ candidate, charge, sourceSubject, sinkSubject,
      taintLabels: input.taintLabels, sinkClass: spec.sinkClass, sinkFieldPath: spec.sinkFieldPath,
      sinkParameterPath: spec.sinkParameterPath, sinkChannel: spec.sinkChannel, edgeChannel: spec.edgeChannel,
      limits: input.limits, ...(input.propertyPath === undefined ? {} : { propertyPath: input.propertyPath }) });
  };
}

/** Fact slots whose identity is deduplicated when the final canonical list is projected. */
const EMITTED_FACT_SLOTS = 2;
const SUPPRESSED_FACT_SLOTS = 1;

type CachedEmissionV1 = Readonly<{
  candidate: ScanLocalFlowCandidateV1; facts: ScanLocalFlowFactsV1;
}>;
export type ScanLocalFlowWitnessFactCacheV1 = Readonly<{
  /** Prepaid insert of one actual emission; a refused charge stores nothing. */
  record: (candidate: ScanLocalFlowCandidateV1, facts: ScanLocalFlowFactsV1, charge: ScanLocalChargeV1) => void;
  /** Only the observed executed sink generation resolves; a superseded generation never does. */
  resolve: (atom: TaintAtomV1, sink: string, executed: FieldStateV1 | undefined,
    charge: ScanLocalChargeV1) => ScanLocalFlowFactsV1 | undefined;
  /**
   * Canonical facts of exactly these collected candidates, first-seen by fact ID and in candidate
   * order. An EMITTED flow contributes provenance then summary; a SUPPRESSED flow contributes only
   * its validated provenance (never a summary), so a suppressed origin is not lost.
   */
  project: (candidates: readonly ScanLocalFlowCandidateV1[]) => readonly SafeFactV2[];
}>;

function keyOf(atom: TaintAtomV1, sink: string): string {
  return `${atomKey(atom)}\u0000${sink}`;
}
/** Length-based key cost: no key string is allocated before the run has paid for it. */
function keyUnits(atom: TaintAtomV1, sink: string): number {
  let units = 2 + atom.sourceId.length + atom.channel.length + sink.length;
  for (const segment of atom.field) units += 1 + segment.length;
  return units;
}

/**
 * One run's actual emissions. The worklist counter paid for each key, the candidate-object
 * projection slot and each projected fact slot at publication, so collecting and projecting
 * afterwards rebuilds no key and performs no unpaid O(R) walk.
 */
export function createScanLocalFlowWitnessFactCacheV1(): ScanLocalFlowWitnessFactCacheV1 {
  const entries = new Map<string, CachedEmissionV1>();
  // Object identity is the final-candidate view: projection looks up these exact collected objects.
  const byCandidate = new Map<ScanLocalFlowCandidateV1, ScanLocalFlowFactsV1>();
  return Object.freeze({
    record: (candidate, facts, charge) => {
      const slots = facts.status === 'EMITTED' ? EMITTED_FACT_SLOTS
        : facts.status === 'SUPPRESSED' ? SUPPRESSED_FACT_SLOTS : 0;
      if (!charge(keyUnits(candidate.atom, candidate.sinkNode) + PROJECTION_SLOT_UNITS + slots)) return;
      const key = keyOf(candidate.atom, candidate.sinkNode);
      const prior = entries.get(key);
      // A newer generation supersedes the prior candidate: it leaves both indexes, so no caller
      // can project an old generation through this cache even by passing its object back.
      if (prior !== undefined) byCandidate.delete(prior.candidate);
      entries.set(key, Object.freeze({ candidate, facts }));
      byCandidate.set(candidate, facts);
    },
    resolve: (atom, sink, executed, charge) => {
      if (executed === undefined) return undefined;
      if (!charge(keyUnits(atom, sink))) return undefined;
      const entry = entries.get(keyOf(atom, sink));
      if (entry === undefined || entry.candidate.sinkState !== executed) return undefined;
      return entry.facts;
    },
    project: (candidates) => {
      const seen = new Set<string>();
      const facts: SafeFactV2[] = [];
      const retain = (fact: SafeFactV2): void => {
        if (seen.has(fact.factId)) return;
        seen.add(fact.factId);
        facts.push(fact);
      };
      for (const candidate of candidates) {
        const emission = byCandidate.get(candidate);
        if (emission === undefined) continue;
        if (emission.status === 'EMITTED') { retain(emission.provenance); retain(emission.summary); }
        else if (emission.status === 'SUPPRESSED') retain(emission.provenance);
      }
      return Object.freeze(facts);
    },
  });
}

function textUnits(value: unknown): number {
  return typeof value === 'string' ? 1 + WIRE_UNITS_PER_CODE_UNIT * value.length : 1;
}

/** Bounded structural walk: the canonical property records are flat, and a cap stops any surprise. */
function valueUnits(value: unknown, depth: number): number {
  if (typeof value === 'string') return textUnits(value);
  if (value === null || typeof value !== 'object') return 1;
  if (depth >= MAX_WALK_DEPTH) return 2;
  if (Array.isArray(value)) {
    let units = 1 + value.length;
    const limit = Math.min(value.length, MAX_WALK_SLOTS);
    for (let index = 0; index < limit; index += 1) units += valueUnits(value[index], depth + 1);
    return units;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  let units = 1 + keys.length;
  const limit = Math.min(keys.length, MAX_WALK_SLOTS);
  for (let index = 0; index < limit; index += 1) {
    const key = keys[index]!;
    units += textUnits(key) + valueUnits(record[key], depth + 1);
  }
  return units;
}

function subjectUnits(subject: SafeFactV2['subject']): number {
  if (subject === null || typeof subject !== 'object' || subject.kind !== 'NODE') return 4;
  const node = subject.node;
  const occurrence = node.source.occurrencePath;
  let units = 4 + textUnits(node.identityDigest) + textUnits(node.explicitId) + textUnits(node.name)
    + textUnits(node.source.pointer) + textUnits(node.source.astNodeId) + 1 + occurrence.length;
  for (let index = 0; index < Math.min(occurrence.length, MAX_WALK_SLOTS); index += 1) units += 1;
  return units;
}

/**
 * Prepayment for the materializer's own fact admission and evidence/trace serialization, which run
 * outside its graph counter: `createFactId` canonicalizes properties and hashes the fact, then the
 * fact is serialized as evidence and its subject/factId are written again into the trace steps.
 * Step graph work stays on the existing maxWitnessOperations reservation. The measure is
 * structural, so a tiny fact is not debited a maximum payload.
 */
export function materializerFactUnits(facts: readonly SafeFactV2[]): number {
  let units = 1 + facts.length;
  for (const fact of facts) {
    units += 2 + textUnits(fact.kind)
      + 2 * (textUnits(fact.factId) + subjectUnits(fact.subject))
      + 2 * valueUnits(fact.properties, 0);
  }
  return units;
}
