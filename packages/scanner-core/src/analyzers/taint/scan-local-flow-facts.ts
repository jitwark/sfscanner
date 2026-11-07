import type { ScannerLimitsV2 } from '@hub/contracts';
import { FIELD_FLOW_ENUMS_V1, FIELD_FLOW_SANITIZER_MODELS_V1 } from '@hub/contracts/scanner-v2-field-flow';
import {
  fieldFlowPathDigestV1, readFieldFlowPropertiesV1, validateFieldFlowSubject,
  type FieldFlowPropertiesV1,
} from '@hub/contracts/scanner-v2-field-flow-validation';
import type { SafeFactV2, SubjectV2 } from '../../capabilities/scheduler';
import {
  isSafeFactRejectionReasonV2, readSubject,
  type SafeFactRejectionReasonV2, type SafeFactSubjectV2,
} from '../../facts/safe-fact-validator';
import { createCandidateFactId } from '../../result-v2/identities';
import type { ScanLocalFlowCandidateV1 } from './scan-local-flows';
import { exceedsSinkPathCap, prepaidUnits } from './scan-local-flow-facts-budget';
import {
  SCAN_LOCAL_LIMITS_V1, compareCodeUnits, isValidFieldPath, type SanitizerTokenV1, type ScanLocalChargeV1,
  type TaintAtomV1, type UnknownReasonV1,
} from './scan-local-state';

const PROVENANCE_KIND = 'dataflow.provenance.v1';
const SUMMARY_KIND = 'dataflow.summary.v3';
const MAX_TOKENS = SCAN_LOCAL_LIMITS_V1.maxSanitizerTokens;
const MAX_REASONS = SCAN_LOCAL_LIMITS_V1.maxUnknownReasons;
/** Reviewed scopes keyed once; a token outside them never reaches a fact. */
const TOKEN_SCOPES: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.fromEntries(
  FIELD_FLOW_SANITIZER_MODELS_V1.map((model) => [model.modelId, model.clears] as const),
));

export type ScanLocalFlowFactsInputV1 = Readonly<{
  /** The collector's executed flow, never a synthesized one. */
  candidate: ScanLocalFlowCandidateV1;
  /** The run's own counter: every unit of the work below is prepaid from it. */
  charge: ScanLocalChargeV1;
  sourceSubject: SubjectV2;
  sinkSubject: SubjectV2;
  taintLabels: readonly string[];
  sinkClass: string;
  sinkFieldPath: readonly string[];
  sinkParameterPath: string;
  sinkChannel: string;
  edgeChannel: string;
  limits: ScannerLimitsV2;
  propertyPath?: string;
}>;
/** Validator sentinels, an exhausted prepayment, or a candidate the collector never supported. */
export type ScanLocalFlowOmissionReasonV1 = SafeFactRejectionReasonV2 | 'BUDGET_EXHAUSTED' | 'UNSUPPORTED_ATOM';
export type ScanLocalFlowFactsV1 =
  | Readonly<{ status: 'EMITTED'; provenance: SafeFactV2; summary: SafeFactV2;
    invalidTokens: number; omittedSanitizers: number }>
  | Readonly<{ status: 'SUPPRESSED'; provenance: SafeFactV2; invalidTokens: 0; omittedSanitizers: 0 }>
  | Readonly<{ status: 'OMITTED'; reason: ScanLocalFlowOmissionReasonV1 }>;

type NodeSubjectV1 = Extract<SafeFactSubjectV2, Readonly<{ kind: 'NODE' }>>;
type GuardedSubjectsV1 = Readonly<{ source: NodeSubjectV1; sink: NodeSubjectV1 }>;
type WireTokensV1 = Readonly<{
  wire: readonly string[]; valid: readonly SanitizerTokenV1[]; invalid: number; overflow: number;
}>;

function omitted(reason: ScanLocalFlowOmissionReasonV1): ScanLocalFlowFactsV1 {
  return Object.freeze({ status: 'OMITTED', reason });
}

function sameAtom(left: TaintAtomV1, right: TaintAtomV1): boolean {
  if (left === right) return true;
  if (left.channel !== right.channel || left.sourceId !== right.sourceId
    || left.field.length !== right.field.length) return false;
  for (let index = 0; index < left.field.length; index += 1) {
    if (left.field[index] !== right.field[index]) return false;
  }
  return true;
}

/** CONTROL is reserved, and support is a structural membership check, so no per-atom key is allocated. */
function supported(candidate: ScanLocalFlowCandidateV1): boolean {
  const { atom, sinkState } = candidate;
  if (atom.channel === 'CONTROL' || atom.sourceId.length === 0 || !isValidFieldPath(atom.field)) return false;
  const limit = Math.min(sinkState.atoms.length, SCAN_LOCAL_LIMITS_V1.maxAtomsPerField);
  for (let index = 0; index < limit; index += 1) if (sameAtom(sinkState.atoms[index]!, atom)) return true;
  return false;
}

function guardSubjects(input: ScanLocalFlowFactsInputV1): GuardedSubjectsV1 | Readonly<{ reason: ScanLocalFlowOmissionReasonV1 }> {
  try {
    const source = readSubject(input.sourceSubject, input.limits);
    const sink = readSubject(input.sinkSubject, input.limits);
    if (source.kind !== 'NODE' || sink.kind !== 'NODE') return Object.freeze({ reason: 'INVALID_SUBJECT' as const });
    return Object.freeze({ source, sink });
  } catch (error) {
    // Only the validator's typed sentinels are expected here; anything else is a real defect.
    if (!isSafeFactRejectionReasonV2(error)) throw error;
    return Object.freeze({ reason: error });
  }
}

function originProperties(atom: TaintAtomV1, labels: readonly string[], source: NodeSubjectV1): FieldFlowPropertiesV1 {
  return {
    sourceNodeOrdinal: source.node.ordinal,
    sourceNodeDigest: source.node.identityDigest,
    sourceFieldPath: [...atom.field],
    taintChannel: atom.channel,
    taintLabels: [...labels],
  };
}

/** Every stored token is judged before any is filtered: reviewed model, clears class, this exact path. */
function wireTokens(stored: readonly SanitizerTokenV1[], digest: string): WireTokensV1 {
  const items: readonly unknown[] = Array.isArray(stored) ? stored : [];
  const limit = Math.min(items.length, MAX_TOKENS);
  const entries: { token: SanitizerTokenV1; wire: string }[] = [];
  let invalid = 0;
  for (let index = 0; index < limit; index += 1) {
    const token = items[index] as SanitizerTokenV1;
    const scope = Object.hasOwn(TOKEN_SCOPES, token.modelId) ? TOKEN_SCOPES[token.modelId] : undefined;
    if (scope === undefined || !scope.includes(token.sink) || token.pathDigest !== digest) { invalid += 1; continue; }
    entries.push({ token, wire: `v1/${token.modelId}/${token.sink}/${token.pathDigest}` });
  }
  // `valid` follows the sorted wire list, so a suppressed draft can drop exactly the matching tokens.
  entries.sort((left, right) => compareCodeUnits(left.wire, right.wire));
  return Object.freeze({ wire: Object.freeze(entries.map((entry) => entry.wire)),
    valid: Object.freeze(entries.map((entry) => entry.token)), invalid,
    overflow: Math.max(0, items.length - MAX_TOKENS) });
}

/** A state reason list is read only up to its contract cap; anything past it becomes an omission. */
function boundedReasons(values: readonly UnknownReasonV1[]): Readonly<{ present: readonly UnknownReasonV1[]; overflow: boolean }> {
  if (!Array.isArray(values)) return Object.freeze({ present: Object.freeze([]), overflow: true });
  const limit = Math.min(values.length, MAX_REASONS + 1);
  const present: UnknownReasonV1[] = [];
  for (let index = 0; index < limit; index += 1) present.push(values[index]!);
  return Object.freeze({ present: Object.freeze(present), overflow: values.length > MAX_REASONS });
}

/** Contract order is the validator's order; a positive omission always adds PAYLOAD_LIMIT. */
function orderedReasons(present: readonly UnknownReasonV1[], omission: boolean): readonly UnknownReasonV1[] {
  const reasons = new Set<UnknownReasonV1>(present);
  if (omission) reasons.add('PAYLOAD_LIMIT');
  return Object.freeze(FIELD_FLOW_ENUMS_V1.fieldFlowUnknownReason
    .filter((reason): reason is UnknownReasonV1 => reasons.has(reason as UnknownReasonV1))
    .slice(0, MAX_REASONS));
}

function canonicalFact(kind: string, subject: SubjectV2, properties: FieldFlowPropertiesV1): SafeFactV2 {
  return Object.freeze({ factId: createCandidateFactId({ kind, subject, properties }), kind, subject, properties });
}

/** The knowledge decision and its exact omissions, as the summary validator will see them. */
type SummaryStateV1 = Readonly<{
  knowledge: 'KNOWN' | 'UNKNOWN'; reasons: readonly UnknownReasonV1[];
  omittedAtoms: number; omittedSanitizers: number;
}>;

/** One canonical summary shape, so a suppressed flow is guarded by what it would have emitted. */
function summaryDraft(
  input: ScanLocalFlowFactsInputV1, origin: FieldFlowPropertiesV1, provenanceFactId: string,
  state: SummaryStateV1, sanitizedFor: readonly string[],
): FieldFlowPropertiesV1 | undefined {
  return readFieldFlowPropertiesV1(SUMMARY_KIND, {
    ...origin,
    flowKind: 'TAINT_SINK',
    sinkClass: input.sinkClass,
    sinkParameterPath: input.sinkParameterPath,
    sinkChannel: input.sinkChannel,
    edgeChannel: input.edgeChannel,
    sourceProvenanceFactId: provenanceFactId,
    sinkFieldPath: [...input.sinkFieldPath],
    knowledge: state.knowledge,
    unknownReasons: [...state.reasons],
    omittedAtoms: state.omittedAtoms,
    omittedSanitizers: state.omittedSanitizers,
    sanitizedFor: [...sanitizedFor],
    reachability: 'CONFIGURED',
    ...(input.propertyPath === undefined ? {} : { propertyPath: input.propertyPath }),
  });
}

/**
 * Emits the canonical provenance plus sink-summary facts for one paid scan-local flow. The whole
 * cost is prepaid from the run's own counter, so a refusal performs no guard, digest, or hash; the
 * only tolerated failures are the validator's typed subject sentinels. Tokens that cannot be stated
 * for this exact sink path or class are counted, dropped, and widen knowledge to UNKNOWN.
 */
export function emitScanLocalFlowFacts(input: ScanLocalFlowFactsInputV1): ScanLocalFlowFactsV1 {
  // Both structural refusals are O(1): an input that can never be a fact is not debited first.
  if (exceedsSinkPathCap(input.sinkFieldPath)) return omitted('INVALID_PROPERTY');
  if (input.sourceSubject.kind !== 'NODE' || input.sinkSubject.kind !== 'NODE') return omitted('INVALID_SUBJECT');
  if (!input.charge(prepaidUnits(input))) return omitted('BUDGET_EXHAUSTED');
  if (!supported(input.candidate)) return omitted('UNSUPPORTED_ATOM');
  const subjects = guardSubjects(input);
  if ('reason' in subjects) return omitted(subjects.reason);
  const { candidate } = input;
  const atom = candidate.atom;
  const origin = originProperties(atom, input.taintLabels, subjects.source);
  const provenanceProperties = readFieldFlowPropertiesV1(PROVENANCE_KIND, origin);
  if (provenanceProperties === undefined) return omitted('INVALID_PROPERTY');
  if (!validateFieldFlowSubject(PROVENANCE_KIND, subjects.source, provenanceProperties)) {
    return omitted('INVALID_SUBJECT');
  }
  const provenance = canonicalFact(PROVENANCE_KIND, subjects.source, provenanceProperties);
  const digest = fieldFlowPathDigestV1(input.sinkFieldPath);
  const tokens = wireTokens(candidate.sinkState.sanitizedFor, digest);
  const omittedAtoms = candidate.omittedAtoms;
  // A bound publication folds its own token omissions into `omittedTokens` and resets the state
  // counter, so the state's counter only adds omissions no bound result has already counted.
  const omittedSanitizers = candidate.omittedTokens + candidate.sinkState.omittedSanitizers
    + tokens.invalid + tokens.overflow;
  const stateReasons = boundedReasons(candidate.sinkState.unknownReasons);
  // A list past the contract cap is bounded above and surfaces its remainder as an omission.
  const reasons = orderedReasons(stateReasons.present,
    omittedAtoms > 0 || omittedSanitizers > 0 || stateReasons.overflow);
  const knowledge = reasons.length === 0 ? 'KNOWN' : 'UNKNOWN';
  const state: SummaryStateV1 = Object.freeze({ knowledge, reasons, omittedAtoms, omittedSanitizers });
  // A KNOWN state with no omission and a token for this exact class and path is already sanitized.
  const suppressed = knowledge === 'KNOWN' && tokens.valid.some((token) => token.sink === input.sinkClass);
  // An emitted KNOWN summary cannot carry its own suppression token, so the guard draft omits it.
  const sanitizedFor = suppressed
    ? tokens.wire.filter((_, index) => tokens.valid[index]?.sink !== input.sinkClass)
    : tokens.wire;
  const summaryProperties = summaryDraft(input, origin, provenance.factId, state, sanitizedFor);
  if (summaryProperties === undefined) return omitted('INVALID_PROPERTY');
  if (!validateFieldFlowSubject(SUMMARY_KIND, subjects.sink, summaryProperties)) return omitted('INVALID_SUBJECT');
  if (suppressed) return Object.freeze({ status: 'SUPPRESSED', provenance, invalidTokens: 0, omittedSanitizers: 0 });
  const summary = canonicalFact(SUMMARY_KIND, subjects.sink, summaryProperties);
  return Object.freeze({ status: 'EMITTED', provenance, summary, invalidTokens: tokens.invalid, omittedSanitizers });
}
