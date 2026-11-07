import { readFieldFlowPropertiesV1, validateFieldFlowSubject, type FieldFlowPropertiesV1 } from '@hub/contracts/scanner-v2-field-flow-validation';
import type { SafeFactV2, SubjectV2 } from '../../capabilities/scheduler';
import { createCandidateFactId } from '../../result-v2/identities';
import { withFlowCoverageChargeV1, type FlowCoverageSnapshotV1 } from './flow-coverage-observation';
import type { ScanLocalTerminalInputReadV1 } from './scan-local-flows';
import { SCAN_LOCAL_LIMITS_V1, type ScanLocalChargeV1 } from './scan-local-state';
import { isKnownTerminalEmissionBoundToRead } from './scan-local-terminal-binding';
import { isScanLocalWitnessChannel, matchingActiveTaintChannel, PROVENANCE_KEYS, sameOrigin } from './flow-coverage-channel';

export type FlowCoverageCountersV1 = Readonly<{ analysisStatus: 'COMPLETE' | 'LIMITED'; flowsStatus: 'COMPLETE' | 'LIMITED';
  analysisOmitted: number; invalidRequests: number; unmappedSources: number; unpublishedSinks: number;
  incompleteTransfers: number; omittedRequests: number; witnessUnavailable: number; omittedTraceSteps: number; suppressedRequests: number }>;
export type FlowCoverageInputV1 = Readonly<{ kind: 'NOT_APPLICABLE' | 'MODEL_UNKNOWN' | 'PRE_FIELD_LIMITED' | 'UNAVAILABLE_BEFORE_FIELDS' }>
  | Readonly<{ kind: 'TERMINAL'; snapshot: FlowCoverageSnapshotV1; facts: readonly SafeFactV2[]; counters: FlowCoverageCountersV1 }>;
export type FlowCoverageDerivationV1 = Readonly<{ ok: true; properties: FieldFlowPropertiesV1 }>
  | Readonly<{ ok: false; reason: 'BUDGET_EXHAUSTED' | 'TELEMETRY_UNAVAILABLE' | 'INVALID_COUNTER'
      | 'UNSUPPORTED_OBSERVATION' | 'INCOHERENT_EVIDENCE' }>;

type Paid<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: 'BUDGET_EXHAUSTED' | 'INVALID' }>;
type RetainedFact = Readonly<{ fact: SafeFactV2; properties: FieldFlowPropertiesV1 }>;
type PaidEmission = Readonly<{ status: 'EMITTED' | 'SUPPRESSED' | 'OMITTED'; invalidTokens: number;
  omittedSanitizers: number; reason?: string; summary?: RetainedFact; provenance?: RetainedFact }>;
const CAP = 'taint-integrity' as const, EMPTY = Object.freeze([]) as readonly string[];
const COUNTER_KEYS = Object.freeze(['analysisStatus', 'flowsStatus', 'analysisOmitted', 'invalidRequests', 'unmappedSources',
  'unpublishedSinks', 'incompleteTransfers', 'omittedRequests', 'witnessUnavailable', 'omittedTraceSteps', 'suppressedRequests'] as const);
const SUMMARY_KEYS = Object.freeze(['flowKind', 'sinkClass', 'sinkParameterPath', 'sinkChannel', 'edgeChannel', 'taintChannel',
  'taintLabels', 'sourceProvenanceFactId', 'sourceNodeOrdinal', 'sourceNodeDigest', 'sourceFieldPath', 'sinkFieldPath',
  'knowledge', 'unknownReasons', 'omittedAtoms', 'omittedSanitizers', 'sanitizedFor', 'reachability', 'propertyPath'] as const);
const BUDGET = Object.freeze({ ok: false as const, reason: 'BUDGET_EXHAUSTED' as const });
const INVALID = Object.freeze({ ok: false as const, reason: 'INVALID' as const });
const fail = <R extends Exclude<Extract<FlowCoverageDerivationV1, { ok: false }>['reason'], 'BUDGET_EXHAUSTED'>>(reason: R) => Object.freeze({ ok: false as const, reason });
const incoherent = () => fail('INCOHERENT_EVIDENCE'), unsupported = () => fail('UNSUPPORTED_OBSERVATION');
const fromPaid = (reason: 'BUDGET_EXHAUSTED' | 'INVALID'): FlowCoverageDerivationV1 => reason === 'BUDGET_EXHAUSTED' ? BUDGET : incoherent();
const paid = <T>(value: T): Paid<T> => Object.freeze({ ok: true as const, value });
const pay = (charge: ScanLocalChargeV1, units: number): boolean => Number.isSafeInteger(units) && units >= 0 && charge(units);

function data(input: unknown, key: string, charge: ScanLocalChargeV1): Paid<unknown> {
  if (!pay(charge, 1)) return BUDGET;
  if (input === null || typeof input !== 'object') return INVALID;
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined && 'value' in descriptor ? paid(descriptor.value) : INVALID;
}
function text(input: unknown, key: string, charge: ScanLocalChargeV1): Paid<string> {
  const value = data(input, key, charge); if (!value.ok) return value;
  if (typeof value.value !== 'string') return INVALID;
  return pay(charge, 1 + value.value.length) ? paid(value.value) : BUDGET;
}
function integer(input: unknown, key: string, charge: ScanLocalChargeV1): Paid<number> {
  const value = data(input, key, charge); if (!value.ok) return value;
  return typeof value.value === 'number' && Number.isSafeInteger(value.value) && value.value >= 0 ? paid(value.value) : INVALID;
}
function listLength(value: unknown, maximum: number, charge: ScanLocalChargeV1): Paid<number> {
  if (!pay(charge, 1)) return BUDGET;
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return INVALID;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value > maximum) return INVALID;
  if (!pay(charge, length.value + 1)) return BUDGET;
  return Reflect.ownKeys(value).length === length.value + 1 ? paid(length.value) : INVALID;
}
function strings(value: unknown, maximum: number, charge: ScanLocalChargeV1): Paid<readonly string[]> {
  const length = listLength(value, maximum, charge); if (!length.ok) return length;
  const result: string[] = [];
  for (let index = 0; index < length.value; index += 1) {
    if (!pay(charge, 1)) return BUDGET;
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item || !('value' in item) || typeof item.value !== 'string') return INVALID;
    if (!pay(charge, 1 + item.value.length)) return BUDGET;
    result.push(item.value);
  }
  return paid(Object.freeze(result));
}
function record(value: unknown, keys: readonly string[], charge: ScanLocalChargeV1): Paid<Record<string, unknown>> {
  if (!pay(charge, 1)) return BUDGET; if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return INVALID;
  if (!pay(charge, 1 + keys.length)) return BUDGET; const names = Reflect.ownKeys(value);
  if (names.length > keys.length || names.some((key) => typeof key !== 'string' || !keys.includes(key))) return INVALID; // fixed closed key table
  const result: Record<string, unknown> = {};
  for (const name of names as string[]) {
    if (!pay(charge, 1)) return BUDGET;
    const descriptor = Object.getOwnPropertyDescriptor(value, name); if (!descriptor || !('value' in descriptor)) return INVALID;
    const item = descriptor.value;
    if (typeof item === 'string') { if (!pay(charge, 1 + item.length)) return BUDGET; }
    else if (Array.isArray(item)) { const fields = strings(item, 32, charge); if (!fields.ok) return fields; }
    else if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) return INVALID;
    result[name] = item;
  }
  return paid(result);
}
function subject(value: unknown, charge: ScanLocalChargeV1): Paid<SubjectV2> {
  if (!pay(charge, 1)) return BUDGET;
  if (value === null || typeof value !== 'object') return INVALID;
  if (!pay(charge, 2)) return BUDGET; const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('node')) return INVALID;
  const kind = text(value, 'kind', charge); if (!kind.ok) return kind; if (kind.value !== 'NODE') return INVALID;
  const node = data(value, 'node', charge); if (!node.ok) return node;
  const ordinal = integer(node.value, 'ordinal', charge); if (!ordinal.ok) return ordinal;
  const digest = text(node.value, 'identityDigest', charge); if (!digest.ok) return digest;
  const source = data(node.value, 'source', charge); if (!source.ok) return source;
  return paid(Object.freeze({ kind: 'NODE', node: Object.freeze({ ordinal: ordinal.value, identityDigest: digest.value, source: source.value }) }) as SubjectV2);
}
function retainedFact(value: unknown, kind: 'dataflow.provenance.v1' | 'dataflow.summary.v3', charge: ScanLocalChargeV1): Paid<RetainedFact> {
  const declared = text(value, 'kind', charge); if (!declared.ok) return declared; if (declared.value !== kind) return INVALID;
  const factId = text(value, 'factId', charge); if (!factId.ok) return factId;
  const rawSubject = data(value, 'subject', charge); if (!rawSubject.ok) return rawSubject;
  const rawProperties = data(value, 'properties', charge); if (!rawProperties.ok) return rawProperties;
  const subj = subject(rawSubject.value, charge); if (!subj.ok) return subj;
  const props = record(rawProperties.value, kind === 'dataflow.provenance.v1' ? PROVENANCE_KEYS : SUMMARY_KEYS, charge); if (!props.ok) return props;
  if (!pay(charge, 32)) return BUDGET;
  const properties = readFieldFlowPropertiesV1(kind, props.value);
  if (!properties || !validateFieldFlowSubject(kind, subj.value, properties)) return INVALID;
  const fact: SafeFactV2 = Object.freeze({ factId: factId.value, kind, subject: subj.value, properties });
  if (!pay(charge, 2048)) return BUDGET;
  return createCandidateFactId(fact) === factId.value ? paid(Object.freeze({ fact, properties })) : INVALID;
}
function emission(value: unknown, charge: ScanLocalChargeV1): Paid<PaidEmission> {
  const status = text(value, 'status', charge); if (!status.ok) return status;
  if (status.value === 'OMITTED') { const reason = text(value, 'reason', charge); if (!reason.ok) return reason;
    return paid({ status: 'OMITTED', invalidTokens: 0, omittedSanitizers: 0, reason: reason.value }); }
  const invalid = integer(value, 'invalidTokens', charge); if (!invalid.ok) return invalid;
  const omitted = integer(value, 'omittedSanitizers', charge); if (!omitted.ok) return omitted;
  if (status.value === 'SUPPRESSED') return paid({ status: 'SUPPRESSED', invalidTokens: invalid.value, omittedSanitizers: omitted.value });
  if (status.value !== 'EMITTED') return INVALID;
  const rawProvenance = data(value, 'provenance', charge); if (!rawProvenance.ok) return rawProvenance;
  const rawSummary = data(value, 'summary', charge); if (!rawSummary.ok) return rawSummary;
  const provenance = retainedFact(rawProvenance.value, 'dataflow.provenance.v1', charge); if (!provenance.ok) return provenance;
  const summary = retainedFact(rawSummary.value, 'dataflow.summary.v3', charge); if (!summary.ok) return summary;
  return paid({ status: 'EMITTED', provenance: provenance.value, summary: summary.value, invalidTokens: invalid.value, omittedSanitizers: omitted.value });
}
function counters(value: unknown, charge: ScanLocalChargeV1): Paid<FlowCoverageCountersV1> {
  if (!pay(charge, 1)) return BUDGET;
  if (value === null || typeof value !== 'object') return INVALID;
  if (!pay(charge, 1 + COUNTER_KEYS.length)) return BUDGET; const names = Reflect.ownKeys(value);
  if (names.length !== COUNTER_KEYS.length || names.some((key) => typeof key !== 'string' || !(COUNTER_KEYS as readonly string[]).includes(key))) return INVALID;
  let analysisStatus: 'COMPLETE' | 'LIMITED' | undefined, flowsStatus: 'COMPLETE' | 'LIMITED' | undefined; const numbers: number[] = [];
  for (const [index, key] of COUNTER_KEYS.entries()) {
    if (index < 2) { const read = text(value, key, charge); if (!read.ok) return read;
      if (read.value !== 'COMPLETE' && read.value !== 'LIMITED') return INVALID; if (index === 0) analysisStatus = read.value; else flowsStatus = read.value;
    } else { const read = integer(value, key, charge); if (!read.ok) return read; numbers.push(read.value); }
  }
  const values = numbers as [number, number, number, number, number, number, number, number, number];
  return paid(Object.freeze({ analysisStatus: analysisStatus!, flowsStatus: flowsStatus!, analysisOmitted: values[0],
    invalidRequests: values[1], unmappedSources: values[2], unpublishedSinks: values[3], incompleteTransfers: values[4],
    omittedRequests: values[5], witnessUnavailable: values[6], omittedTraceSteps: values[7], suppressedRequests: values[8] }));
}
function finish(charge: ScanLocalChargeV1, values: Readonly<Record<string, unknown>>): Paid<FieldFlowPropertiesV1> {
  if (!pay(charge, 1)) return BUDGET;
  const properties = Object.freeze({ capabilityId: CAP, coverageStatus: values.coverageStatus, fieldsExamined: values.fieldsExamined ?? 0,
    knownFields: values.knownFields ?? 0, knownEmptyFields: values.knownEmptyFields ?? 0, unknownFields: values.unknownFields ?? 0,
    positiveFields: values.positiveFields ?? 0, emittedFlows: values.emittedFlows ?? 0, suppressedFlows: values.suppressedFlows ?? 0,
    omittedAtoms: values.omittedAtoms ?? 0, omittedSanitizers: values.omittedSanitizers ?? 0, unknownReasons: values.unknownReasons ?? EMPTY,
    taintChannels: values.taintChannels ?? EMPTY, sinkChannels: values.sinkChannels ?? EMPTY, edgeChannels: values.edgeChannels ?? EMPTY,
    unmappedSources: values.unmappedSources ?? 0, unmappedSinks: values.unmappedSinks ?? 0, unmappedPaths: values.unmappedPaths ?? 0,
    redactedPaths: values.redactedPaths ?? 0, invalidTokens: values.invalidTokens ?? 0, witnessUnavailable: values.witnessUnavailable ?? 0,
    omittedTraceSteps: values.omittedTraceSteps ?? 0 });
  if (!pay(charge, 32)) return BUDGET; const valid = readFieldFlowPropertiesV1('dataflow.coverage.v1', properties);
  return valid && validateFieldFlowSubject('dataflow.coverage.v1', { kind: 'WORKFLOW' }, valid) ? paid(valid) : INVALID;
}

export function deriveFlowCoverageV1(input: FlowCoverageInputV1, charge: ScanLocalChargeV1): FlowCoverageDerivationV1 {
  if (input.kind !== 'TERMINAL') {
    if (!pay(charge, 1)) return BUDGET;
    const status = input.kind === 'NOT_APPLICABLE' ? 'COMPLETE' : input.kind === 'MODEL_UNKNOWN' || input.kind === 'UNAVAILABLE_BEFORE_FIELDS' ? 'FAILED'
      : input.kind === 'PRE_FIELD_LIMITED' ? 'LIMITED' : undefined;
    if (status === undefined) return unsupported(); const result = finish(charge, { coverageStatus: status });
    return result.ok ? Object.freeze({ ok: true, properties: result.value }) : fromPaid(result.reason);
  }
  const handoff = withFlowCoverageChargeV1(input.snapshot, (actual) => {
    if (actual !== charge) return fail('TELEMETRY_UNAVAILABLE');
    const count = data(input, 'counters', charge); if (!count.ok) return fromPaid(count.reason);
    const counts = counters(count.value, charge); if (!counts.ok) return counts.reason === 'BUDGET_EXHAUSTED' ? BUDGET : fail('INVALID_COUNTER');
    const status = text(input.snapshot, 'status', charge); if (!status.ok) return fromPaid(status.reason);
    if (status.value !== 'OBSERVED') return fail('TELEMETRY_UNAVAILABLE');
    const rows = data(input.snapshot, 'rows', charge); if (!rows.ok) return fromPaid(rows.reason);
    const rowLength = listLength(rows.value, SCAN_LOCAL_LIMITS_V1.maxFieldStates, charge);
    if (!rowLength.ok) return rowLength.reason === 'BUDGET_EXHAUSTED' ? BUDGET : unsupported();
    if (rowLength.value === 0) return unsupported(); if (rowLength.value !== 1) return incoherent();
    if (!pay(charge, 1)) return BUDGET; const row = Object.getOwnPropertyDescriptor(rows.value, '0'); if (!row || !('value' in row)) return incoherent();
    const candidateRaw = data(row.value, 'candidate', charge); if (!candidateRaw.ok) return fromPaid(candidateRaw.reason);
    const emissionRaw = data(row.value, 'emission', charge); if (!emissionRaw.ok) return fromPaid(emissionRaw.reason);
    const observation = text(candidateRaw.value, 'observation', charge); if (!observation.ok) return fromPaid(observation.reason);
    if (observation.value !== 'TERMINAL_INPUT_READ') return unsupported();
    const readRaw = data(candidateRaw.value, 'terminalInputRead', charge); if (!readRaw.ok) return fromPaid(readRaw.reason);
    const atomRaw = data(candidateRaw.value, 'atom', charge); if (!atomRaw.ok) return fromPaid(atomRaw.reason);
    const readChannel = text(readRaw.value, 'channel', charge); if (!readChannel.ok) return fromPaid(readChannel.reason);
    if (!isScanLocalWitnessChannel(readChannel.value)) return incoherent();
    const readSink = text(readRaw.value, 'sinkParameterPath', charge); if (!readSink.ok) return fromPaid(readSink.reason);
    const readPath = data(readRaw.value, 'path', charge); if (!readPath.ok) return fromPaid(readPath.reason);
    const atomField = data(atomRaw.value, 'field', charge); if (!atomField.ok) return fromPaid(atomField.reason);
    const atomChannel = text(atomRaw.value, 'channel', charge); if (!atomChannel.ok) return fromPaid(atomChannel.reason);
    const atomSource = text(atomRaw.value, 'sourceId', charge); if (!atomSource.ok) return fromPaid(atomSource.reason);
    const sourceNode = text(candidateRaw.value, 'sourceNode', charge); if (!sourceNode.ok) return fromPaid(sourceNode.reason);
    const sinkNode = text(candidateRaw.value, 'sinkNode', charge); if (!sinkNode.ok) return fromPaid(sinkNode.reason);
    const omittedAtoms = integer(candidateRaw.value, 'omittedAtoms', charge); if (!omittedAtoms.ok) return fromPaid(omittedAtoms.reason);
    const omittedTokens = integer(candidateRaw.value, 'omittedTokens', charge); if (!omittedTokens.ok) return fromPaid(omittedTokens.reason);
    const readFields = strings(readPath.value, 32, charge); if (!readFields.ok) return fromPaid(readFields.reason);
    const atomFields = strings(atomField.value, 32, charge); if (!atomFields.ok) return fromPaid(atomFields.reason);
    if (atomSource.value.length === 0 || sourceNode.value.length === 0 || sinkNode.value.length === 0
      || readFields.value.length !== atomFields.value.length || readFields.value.some((field, index) => field !== atomFields.value[index])) return incoherent();
    const parsed = emission(emissionRaw.value, charge); if (!parsed.ok) return fromPaid(parsed.reason);
    const base = { coverageStatus: 'LIMITED', omittedAtoms: omittedAtoms.value, omittedSanitizers: parsed.value.omittedSanitizers,
      invalidTokens: parsed.value.invalidTokens, unmappedSources: counts.value.unmappedSources, witnessUnavailable: counts.value.witnessUnavailable,
      omittedTraceSteps: counts.value.omittedTraceSteps };
    if (parsed.value.status === 'OMITTED' && parsed.value.reason === 'BUDGET_EXHAUSTED') return BUDGET;
    if (parsed.value.status !== 'EMITTED' || parsed.value.summary?.properties.knowledge !== 'KNOWN') {
      const result = finish(charge, base); return result.ok ? Object.freeze({ ok: true, properties: result.value }) : fromPaid(result.reason);
    }
    const facts = data(input, 'facts', charge); if (!facts.ok) return fromPaid(facts.reason);
    const factLength = listLength(facts.value, 2 * SCAN_LOCAL_LIMITS_V1.maxFieldStates, charge);
    if (!factLength.ok) return factLength.reason === 'BUDGET_EXHAUSTED' ? BUDGET : incoherent();
    const provenance = new Map<string, RetainedFact>(), summaries = new Map<string, RetainedFact>();
    for (let index = 0; index < factLength.value; index += 1) {
      if (!pay(charge, 1)) return BUDGET;
      const item = Object.getOwnPropertyDescriptor(facts.value, String(index)); if (!item || !('value' in item)) return incoherent();
      const kind = text(item.value, 'kind', charge); if (!kind.ok) return fromPaid(kind.reason);
      if (kind.value !== 'dataflow.provenance.v1' && kind.value !== 'dataflow.summary.v3') continue;
      const id = text(item.value, 'factId', charge); if (!id.ok) return fromPaid(id.reason);
      const parsedFact = retainedFact(item.value, kind.value, charge); if (!parsedFact.ok) return fromPaid(parsedFact.reason);
      const map = kind.value === 'dataflow.provenance.v1' ? provenance : summaries;
      if (map.has(id.value)) return incoherent(); map.set(id.value, parsedFact.value);
    }
    const summary = summaries.get(parsed.value.summary!.fact.factId);
    if (summary === undefined) { if (summaries.size > 0) return incoherent();
      const result = finish(charge, base); return result.ok ? Object.freeze({ ok: true, properties: result.value }) : fromPaid(result.reason); }
    if (summaries.size !== 1) return incoherent(); const sourceId = summary.properties.sourceProvenanceFactId;
    if (typeof sourceId !== 'string') return incoherent(); const origin = provenance.get(sourceId); if (origin === undefined) return incoherent();
    if (!pay(charge, 128)) return BUDGET;
    const taintChannel = matchingActiveTaintChannel(atomChannel.value, origin.properties, summary.properties);
    if (taintChannel === undefined || !sameOrigin(origin.properties, summary.properties)
      || parsed.value.provenance!.fact.factId !== sourceId || !sameOrigin(parsed.value.provenance!.properties, origin.properties)) return incoherent();
    const carrier = data(readRaw.value, 'carrier', charge); if (!carrier.ok) return fromPaid(carrier.reason);
    const read: ScanLocalTerminalInputReadV1 = Object.freeze({ channel: readChannel.value, path: readFields.value, sinkParameterPath: readSink.value,
      carrier: carrier.value as ScanLocalTerminalInputReadV1['carrier'] });
    if (!pay(charge, 1)) return BUDGET;
    if (!isKnownTerminalEmissionBoundToRead({ status: 'EMITTED', provenance: origin.fact, summary: summary.fact,
      invalidTokens: parsed.value.invalidTokens, omittedSanitizers: parsed.value.omittedSanitizers }, readChannel.value, read)) return incoherent();
    if (omittedAtoms.value !== summary.properties.omittedAtoms || parsed.value.omittedSanitizers !== summary.properties.omittedSanitizers) return incoherent();
    if (!pay(charge, 1)) return BUDGET; const taintChannels = Object.freeze([taintChannel]);
    if (!pay(charge, 1)) return BUDGET; const sinkChannels = Object.freeze([summary.properties.sinkChannel as string]);
    if (!pay(charge, 1)) return BUDGET; const edgeChannels = Object.freeze([summary.properties.edgeChannel as string]);
    const degraded = counts.value.analysisStatus !== 'COMPLETE' || counts.value.flowsStatus !== 'COMPLETE'
      || [counts.value.analysisOmitted, counts.value.invalidRequests, counts.value.unmappedSources, counts.value.unpublishedSinks,
        counts.value.incompleteTransfers, counts.value.omittedRequests, counts.value.witnessUnavailable, counts.value.omittedTraceSteps,
        counts.value.suppressedRequests, omittedAtoms.value, parsed.value.omittedSanitizers, parsed.value.invalidTokens].some((value) => value !== 0);
    const result = finish(charge, { ...base, coverageStatus: degraded ? 'LIMITED' : 'COMPLETE', fieldsExamined: 2, knownFields: 2,
      knownEmptyFields: 0, unknownFields: 0, positiveFields: 2, emittedFlows: 1, suppressedFlows: 0, unknownReasons: EMPTY,
      taintChannels, sinkChannels, edgeChannels, unmappedSinks: 0, unmappedPaths: 0, redactedPaths: 0 });
    return result.ok ? Object.freeze({ ok: true, properties: result.value }) : fromPaid(result.reason);
  });
  return handoff.ok ? handoff.value : fail('TELEMETRY_UNAVAILABLE');
}

