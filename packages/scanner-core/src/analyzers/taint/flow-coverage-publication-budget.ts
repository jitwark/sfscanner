import type { FieldFlowPropertiesV1 } from '../../../../../contracts/scanner-v2-field-flow-validation';
import { FIELD_FLOW_PROPERTY_TYPES_V1, isFieldFlowFactKindV1 } from '../../../../../contracts/scanner-v2-field-flow';
import type { SafeFactV2 } from '../../../../../contracts/scanner-v2-evidence';
import type { FlowCoverageDerivationV1 } from './flow-coverage-derivation';
import type { ScanLocalChargeV1 } from './scan-local-state';

type Success = Extract<FlowCoverageDerivationV1, Readonly<{ ok: true }>>;
type DerivationFailureReason = Extract<FlowCoverageDerivationV1, Readonly<{ ok: false }>>['reason'];
export type FlowCoveragePublicationFailureReasonV1 = DerivationFailureReason
  | 'INVALID_PROPERTY' | 'INVALID_SUBJECT' | 'INCOHERENT_EVIDENCE';
export type FlowCoveragePublicationMeterV1 =
  | Readonly<{ ok: true; coverage: Success; properties: FieldFlowPropertiesV1; facts: readonly SafeFactV2[];
      hasCoverage: boolean }>
  | Readonly<{ ok: false; reason: FlowCoveragePublicationFailureReasonV1 }>;

type Step = 'OK' | 'BUDGET' | 'INVALID';
type State = { slots: number; wire: number; coverageSlots: number; coverageWire: number; factCount: number;
  flowFacts: number; flowSlots: number; flowWire: number; summaries: number; hasCoverage: boolean };
const FACT_KEYS = Object.freeze(['factId', 'kind', 'subject', 'properties'] as const);
const DERIVATION_FAILURES: readonly DerivationFailureReason[] = Object.freeze(['BUDGET_EXHAUSTED',
  'TELEMETRY_UNAVAILABLE', 'INVALID_COUNTER', 'UNSUPPORTED_OBSERVATION', 'INCOHERENT_EVIDENCE']);

const budget = (): Readonly<{ ok: false; reason: 'BUDGET_EXHAUSTED' }> => Object.freeze({ ok: false, reason: 'BUDGET_EXHAUSTED' });
const invalid = (): Readonly<{ ok: false; reason: 'INCOHERENT_EVIDENCE' }> => Object.freeze({ ok: false, reason: 'INCOHERENT_EVIDENCE' });
function add(left: number, right: number): number | undefined {
  const value = left + right; return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function multiply(left: number, right: number): number | undefined {
  const value = left * right; return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function charge(actual: ScanLocalChargeV1, units: number): Step {
  if (!Number.isSafeInteger(units) || units < 0) return 'INVALID';
  return actual(units) ? 'OK' : 'BUDGET';
}
function accumulate(state: State, slots: number, wire: number): Step {
  const nextSlots = add(state.slots, slots), nextWire = add(state.wire, wire);
  if (nextSlots === undefined || nextWire === undefined) return 'BUDGET';
  state.slots = nextSlots; state.wire = nextWire; return 'OK';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function readRecord(value: unknown, allowed: readonly string[], actual: ScanLocalChargeV1, exact = true): Step | Record<string, unknown> {
  if (!isRecord(value)) return 'INVALID';
  const header = charge(actual, 1); if (header !== 'OK') return header;
  const names = Object.getOwnPropertyNames(value);
  const walk = charge(actual, names.length + 1); if (walk !== 'OK') return walk;
  const symbols = charge(actual, 1); if (symbols !== 'OK') return symbols;
  if (Object.getOwnPropertySymbols(value).length !== 0) return 'INVALID';
  if ((exact && names.length !== allowed.length) || names.some((name) => !allowed.includes(name))) return 'INVALID';
  const output: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return 'INVALID';
    output[name] = descriptor.value;
  }
  return output;
}
function meterString(value: unknown, actual: ScanLocalChargeV1, state: State): Step {
  if (typeof value !== 'string') return 'INVALID';
  const read = charge(actual, 1); if (read !== 'OK') return read;
  const length = value.length; const wire = multiply(length, 6);
  if (wire === undefined) return 'BUDGET'; const total = add(wire, 1); if (total === undefined) return 'BUDGET';
  const paid = charge(actual, total); if (paid !== 'OK') return paid;
  return accumulate(state, 1, total);
}
function meterInteger(value: unknown, state: State): Step {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 'INVALID';
  return accumulate(state, 1, 0);
}
function meterStringList(value: unknown, actual: ScanLocalChargeV1, state: State): Step {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return 'INVALID';
  const header = charge(actual, 1); if (header !== 'OK') return header;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!descriptor || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value > 32) return 'INVALID';
  const length = descriptor.value; const slots = add(length, 1); if (slots === undefined) return 'BUDGET';
  const walk = charge(actual, slots); if (walk !== 'OK') return walk;
  const symbols = charge(actual, 1); if (symbols !== 'OK') return symbols;
  if (Object.getOwnPropertySymbols(value).length !== 0) return 'INVALID';
  if (Object.getOwnPropertyNames(value).length !== length + 1) return 'INVALID';
  state.factCount = length;
  let wire = 0;
  for (let index = 0; index < length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item || !item.enumerable || !('value' in item) || typeof item.value !== 'string') return 'INVALID';
    const itemCodeUnits = multiply(item.value.length, 6); if (itemCodeUnits === undefined) return 'BUDGET';
    const itemWire = add(itemCodeUnits, 1); if (itemWire === undefined) return 'BUDGET';
    const nextWire = add(wire, itemWire); if (nextWire === undefined) return 'BUDGET'; wire = nextWire;
    const paidItem = charge(actual, itemWire); if (paidItem !== 'OK') return paidItem;
  }
  const total = add(wire, state.wire); if (total === undefined) return 'BUDGET';
  const totalSlots = add(state.slots, length); if (totalSlots === undefined) return 'BUDGET';
  state.wire = total; state.slots = totalSlots; return 'OK';
}
function meterProperties(value: unknown, schema: Readonly<Record<string, 'STRING' | 'INTEGER' | 'STRING_LIST'>>,
  actual: ScanLocalChargeV1, state: State): Step | FieldFlowPropertiesV1 {
  const keys = Object.keys(schema); const record = readRecord(value, keys, actual, false);
  if (typeof record === 'string') return record;
  const output: Record<string, string | number | readonly string[]> = {};
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) { if (key === 'propertyPath') continue; return 'INVALID'; }
    const raw = record[key]; const type = schema[key]!;
    if (type === 'STRING') { if (typeof raw !== 'string') return 'INVALID'; const step = meterString(raw, actual, state);
      if (step !== 'OK') return step; output[key] = raw; }
    else if (type === 'INTEGER') { if (typeof raw !== 'number') return 'INVALID'; const step = meterInteger(raw, state);
      if (step !== 'OK') return step; output[key] = raw; }
    else { if (!Array.isArray(raw)) return 'INVALID'; const step = meterStringList(raw, actual, state);
      if (step !== 'OK') return step; output[key] = Object.freeze([...raw]); }
  }
  return Object.freeze(output);
}
function isStep(value: Step | unknown): value is Step {
  return value === 'OK' || value === 'BUDGET' || value === 'INVALID';
}
function isDerivationFailureReason(value: string): value is DerivationFailureReason {
  return DERIVATION_FAILURES.some((reason) => reason === value);
}
function isFactRecord(value: unknown): value is SafeFactV2 { return isRecord(value); }
function meterFact(value: unknown, actual: ScanLocalChargeV1, state: State): Step | SafeFactV2 {
  const fact = readRecord(value, FACT_KEYS, actual); if (isStep(fact)) return fact;
  const kindStep = meterString(fact.kind, actual, state); if (kindStep !== 'OK') return kindStep;
  const idStep = meterString(fact.factId, actual, state); if (idStep !== 'OK') return idStep;
  if (isFieldFlowFactKindV1(fact.kind)) {
    const fieldTypes = FIELD_FLOW_PROPERTY_TYPES_V1[fact.kind];
    const beforeSlots = state.slots, beforeWire = state.wire;
    const properties = meterProperties(fact.properties, fieldTypes, actual, state); if (isStep(properties)) return properties;
    const flowFacts = add(state.flowFacts, 1), flowSlots = add(state.flowSlots, state.slots - beforeSlots);
    const flowWire = add(state.flowWire, state.wire - beforeWire);
    if (flowFacts === undefined || flowSlots === undefined || flowWire === undefined) return 'BUDGET';
    state.flowFacts = flowFacts; state.flowSlots = flowSlots; state.flowWire = flowWire;
    if (fact.kind === 'dataflow.summary.v3') { const summaries = add(state.summaries, 1);
      if (summaries === undefined) return 'BUDGET'; state.summaries = summaries; }
    if (fact.kind === 'dataflow.coverage.v1') state.hasCoverage = true;
  }
  return isFactRecord(value) ? value : 'INVALID';
}
function meterFacts(value: unknown, actual: ScanLocalChargeV1, state: State): Step | SafeFactV2[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return 'INVALID';
  const header = charge(actual, 1); if (header !== 'OK') return header;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!descriptor || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value)) return 'INVALID';
  const length = descriptor.value; const slots = add(length, 1); if (slots === undefined) return 'BUDGET';
  const walk = charge(actual, slots); if (walk !== 'OK') return walk;
  const symbols = charge(actual, 1); if (symbols !== 'OK') return symbols;
  if (Object.getOwnPropertySymbols(value).length !== 0) return 'INVALID';
  if (Object.getOwnPropertyNames(value).length !== length + 1) return 'INVALID';
  const facts: SafeFactV2[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item || !item.enumerable || !('value' in item)) return 'INVALID';
    const fact = meterFact(item.value, actual, state); if (isStep(fact)) return fact; facts.push(fact);
  }
  return facts;
}
function reservation(state: State, semanticLength: number): number | undefined {
  const propertySlots = multiply(state.coverageSlots, 4), propertyWire = multiply(state.coverageWire, 2);
  const identitySlots = multiply(state.coverageSlots, 12), identityWire = multiply(state.coverageWire, 8), semanticWire = multiply(semanticLength, 6);
  const coherenceFacts = multiply(state.flowFacts + 1, 32), coherenceWire = multiply(state.flowWire, 4);
  const factCopies = multiply(state.factCount + 1, 8), flowSlots = multiply(state.flowSlots, 2);
  const summaryWork = multiply(state.summaries + 1, 16);
  if (propertySlots === undefined || propertyWire === undefined || identitySlots === undefined || identityWire === undefined
    || semanticWire === undefined || coherenceFacts === undefined || coherenceWire === undefined || summaryWork === undefined
    || factCopies === undefined || flowSlots === undefined) return;
  let property = add(128, propertySlots); if (property === undefined) return; property = add(property, propertyWire);
  const identityTail = add(identityWire, semanticWire); if (identityTail === undefined) return;
  let identity = add(256, identitySlots); if (identity === undefined) return; identity = add(identity, identityTail);
  const coherenceTail = add(coherenceWire, summaryWork); if (coherenceTail === undefined) return;
  let coherence = add(192, coherenceFacts); if (coherence === undefined) return;
  coherence = add(coherence, coherenceTail); if (coherence === undefined) return;
  coherence = add(coherence, factCopies); if (coherence === undefined) return; coherence = add(coherence, flowSlots);
  if (property === undefined || identity === undefined || coherence === undefined) return;
  const total = add(property, identity); return total === undefined ? undefined : add(total, coherence);
}

export function meterFlowCoveragePublicationV1(input: Readonly<{
  coverage: FlowCoverageDerivationV1; existingFacts: readonly SafeFactV2[]; semanticSha256: string;
}>, actual: ScanLocalChargeV1): FlowCoveragePublicationMeterV1 {
  const header = charge(actual, 1); if (header === 'BUDGET') return budget(); if (header === 'INVALID') return invalid();
  if (!isRecord(input)) return invalid();
  const coverage = readRecord(input.coverage, ['ok', 'properties', 'reason'], actual, false);
  if (isStep(coverage)) return coverage === 'BUDGET' ? budget() : invalid();
  if (coverage.ok === false) {
    if (Object.hasOwn(coverage, 'properties') || typeof coverage.reason !== 'string'
      || !isDerivationFailureReason(coverage.reason)) return invalid();
    return Object.freeze({ ok: false, reason: coverage.reason });
  }
  if (coverage.ok !== true || Object.hasOwn(coverage, 'reason')) return invalid();
  const state: State = { slots: 0, wire: 0, coverageSlots: 0, coverageWire: 0, factCount: 0,
    flowFacts: 0, flowSlots: 0, flowWire: 0, summaries: 0, hasCoverage: false };
  const coverageSlotsBefore = state.slots, coverageWireBefore = state.wire;
  const properties = meterProperties(coverage.properties, FIELD_FLOW_PROPERTY_TYPES_V1['dataflow.coverage.v1'], actual, state);
  if (isStep(properties)) return properties === 'BUDGET' ? budget() : Object.freeze({ ok: false, reason: 'INVALID_PROPERTY' });
  state.coverageSlots = state.slots - coverageSlotsBefore; state.coverageWire = state.wire - coverageWireBefore;
  const facts = meterFacts(input.existingFacts, actual, state); if (isStep(facts)) return facts === 'BUDGET' ? budget() : invalid();
  const semanticLength = meterString(input.semanticSha256, actual, state); if (semanticLength !== 'OK') return semanticLength === 'BUDGET' ? budget() : invalid();
  const reserve = reservation(state, input.semanticSha256.length); if (reserve === undefined) return budget();
  const paid = charge(actual, reserve); if (paid === 'BUDGET') return budget(); if (paid === 'INVALID') return invalid();
  return Object.freeze({ ok: true, coverage: Object.freeze({ ok: true as const, properties }), properties, facts: Object.freeze(facts), hasCoverage: state.hasCoverage });
}
