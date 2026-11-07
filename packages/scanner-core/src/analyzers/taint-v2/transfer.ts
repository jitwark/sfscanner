import type { ResolvedNodeSemanticsV2, SemanticChannelV2, SemanticEndpointV2 } from '../../semantics/catalogue-schema';
import { chargeGraphOperation, normalizeGraphOperationBudget, type GraphOperationBudgetInputV2, type GraphOperationBudgetV2 } from '../graph-v2/budget';
import type { SecurityNodeV2 } from '../../workflow-v2/security-workflow';
import {
  bottomConfidentiality,
  bottomIntegrity,
  createConfidentialityState,
  createIntegrityState,
  joinConfidentialityStates,
  joinIntegrityStates,
  killConfidentialityLabels,
  killIntegrityLabels,
  type ConfidentialityLabel,
  type ConfidentialityState,
  type IntegrityLabel,
  type IntegrityState,
} from './labels';

export type TaintKeyV2 = Readonly<{ node: number; field: string; port: number; item: number }>;
export type TaintTraceStepV2 = Readonly<{ kind: 'SOURCE' | 'PROPAGATION' | 'SANITIZER' | 'SINK'; node: number; field: string; port: number; item: number }>;
export type TaintFactV2 = Readonly<{ key: TaintKeyV2; confidentiality: ConfidentialityState; integrity: IntegrityState; trace: readonly TaintTraceStepV2[] }>;
export type TaintTransferInputV2 = Readonly<{ node: SecurityNodeV2; semantics?: ResolvedNodeSemanticsV2; incoming: readonly TaintFactV2[]; graphBudget?: GraphOperationBudgetInputV2 }>;
export type TaintTransferResultV2 = Readonly<{ status: 'COMPLETE' | 'UNKNOWN' | 'GRAPH_WORK_LIMIT_EXCEEDED'; facts: readonly TaintFactV2[]; omitted: number; graphUsage?: GraphOperationBudgetV2 }>;

export function transferNodeV2(input: TaintTransferInputV2): TaintTransferResultV2 {
  const exhausted = readExhaustedGraphBudgetV2(input.graphBudget);
  if (exhausted !== undefined) return graphLimitResult({ counter: exhausted });
  const budget: MutableTransferBudget | undefined = input.graphBudget === undefined
    ? undefined : { counter: normalizeGraphOperationBudget(input.graphBudget) };
  const ordinal = input.node.ref.ordinal;
  const semantics = input.semantics;
  const unknown = semantics === undefined || semantics.errorMode === 'UNKNOWN' || semantics.retryMode === 'UNKNOWN'
    || !['STOP', 'CONTINUE', 'OUTPUT'].includes(semantics.errorMode as string)
    || !['NONE', 'BOUNDED', 'PLATFORM'].includes(semantics.retryMode as string);
  const facts = new Map<string, TaintFactV2>();
  for (const original of input.incoming) {
    if (!chargeTransfer(budget, original.trace.length + 1)) return graphLimitResult(budget);
    const key = { node: ordinal, field: original.key.field, port: original.key.port, item: original.key.item };
    let confidentiality = original.confidentiality;
    let integrity = original.integrity;
    let trace = appendTrace(original.trace, { kind: 'PROPAGATION', ...key });
    if (semantics) {
      for (const path of semantics.overwritePaths) {
        if (!chargeTransfer(budget)) return graphLimitResult(budget);
        if (pathMatch(key.field, path)) {
          confidentiality = killConfidentialityLabels(confidentiality, confidentiality.labels);
          integrity = killIntegrityLabels(integrity, integrity.labels);
        }
      }
      const applied = applyEndpoints(semantics.endpoints, key.field, confidentiality, integrity, budget);
      if (applied === undefined) return graphLimitResult(budget);
      ({ confidentiality, integrity } = applied);
      const endpointTrace = appendEndpointTrace(semantics.endpoints, key, trace, budget);
      if (endpointTrace === undefined) return graphLimitResult(budget);
      trace = endpointTrace;
    }
    if (unknown) { confidentiality = createConfidentialityState(confidentiality.labels, true); integrity = createIntegrityState(integrity.labels, true); }
    addFact(facts, { key, confidentiality, integrity, trace });
  }
  if (semantics) for (const endpoint of semantics.endpoints) {
    if (!chargeTransfer(budget)) return graphLimitResult(budget);
    if (endpoint.direction !== 'SOURCE') continue;
    const key = { node: ordinal, field: endpoint.path, port: 0, item: 0 };
    const source = sourceStates(endpoint.channel, endpoint.taint);
    const confidentiality = unknown ? createConfidentialityState(source.confidentiality.labels, true) : source.confidentiality;
    const integrity = unknown ? createIntegrityState(source.integrity.labels, true) : source.integrity;
    addFact(facts, { key, confidentiality, integrity, trace: [{ kind: 'SOURCE', ...key }] });
  }
  let stateUnknown = false;
  for (const fact of facts.values()) {
    if (!chargeTransfer(budget)) return graphLimitResult(budget);
    stateUnknown ||= fact.confidentiality.unknown || fact.integrity.unknown;
  }
  if (facts.size > 0 && !chargeTransfer(budget, facts.size)) return graphLimitResult(budget);
  return transferResult(unknown || stateUnknown ? 'UNKNOWN' : 'COMPLETE', [...facts.values()], budget);
}

export const transferTaintV2 = transferNodeV2;
export function readExhaustedGraphBudgetV2(input: GraphOperationBudgetInputV2 | undefined): GraphOperationBudgetV2 | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  try {
    if (Object.getPrototypeOf(input) !== Object.prototype) return undefined;
    const maximum = Object.getOwnPropertyDescriptor(input, 'maximum');
    const used = Object.getOwnPropertyDescriptor(input, 'used');
    const omitted = Object.getOwnPropertyDescriptor(input, 'omitted');
    const exhausted = Object.getOwnPropertyDescriptor(input, 'exhausted');
    if (!maximum || !('value' in maximum) || typeof maximum.value !== 'number' || !Number.isSafeInteger(maximum.value) || maximum.value < 0
      || !used || !('value' in used) || typeof used.value !== 'number' || !Number.isSafeInteger(used.value) || used.value <= maximum.value
      || !omitted || !('value' in omitted) || omitted.value !== used.value - maximum.value
      || !exhausted || !('value' in exhausted) || exhausted.value !== true) return undefined;
    return Object.freeze({ maximum: maximum.value, used: used.value, omitted: omitted.value, exhausted: true });
  } catch {
    return undefined;
  }
}
type MutableTransferBudget = { counter: GraphOperationBudgetV2 };

function chargeTransfer(budget: MutableTransferBudget | undefined, units = 1): boolean {
  if (budget === undefined) return true;
  if (budget.counter.exhausted) return false;
  const charged = chargeGraphOperation(budget.counter, units);
  budget.counter = charged.counter;
  return charged.ok;
}

function transferResult(
  status: TaintTransferResultV2['status'],
  facts: readonly TaintFactV2[],
  budget: MutableTransferBudget | undefined,
): TaintTransferResultV2 {
  return Object.freeze({
    status, facts: Object.freeze(facts), omitted: 0,
    ...(budget === undefined ? {} : { graphUsage: budget.counter }),
  });
}

function graphLimitResult(budget: MutableTransferBudget | undefined): TaintTransferResultV2 {
  return Object.freeze({
    status: 'GRAPH_WORK_LIMIT_EXCEEDED' as const, facts: Object.freeze([]),
    omitted: Math.max(1, budget?.counter.omitted ?? 0),
    ...(budget === undefined ? {} : { graphUsage: budget.counter }),
  });
}

function applyEndpoints(
  endpoints: readonly SemanticEndpointV2[],
  field: string,
  confidentiality: ConfidentialityState,
  integrity: IntegrityState,
  budget: MutableTransferBudget | undefined,
): { confidentiality: ConfidentialityState; integrity: IntegrityState } | undefined {
  let nextConfidentiality = confidentiality;
  let nextIntegrity = integrity;
  for (const endpoint of endpoints) {
    if (!chargeTransfer(budget)) return undefined;
    if (!pathMatch(field, endpoint.path)) continue;
    if (endpoint.direction === 'SOURCE') {
      const source = sourceStates(endpoint.channel, endpoint.taint);
      nextConfidentiality = joinConfidentialityStates(nextConfidentiality, source.confidentiality);
      nextIntegrity = joinIntegrityStates(nextIntegrity, source.integrity);
    } else if (endpoint.direction === 'SANITIZER') {
      if (endpoint.taint === 'CONFIDENTIALITY' || endpoint.taint === 'BOTH') nextConfidentiality = killConfidentialityLabels(nextConfidentiality, nextConfidentiality.labels);
      if (endpoint.taint === 'INTEGRITY' || endpoint.taint === 'BOTH') nextIntegrity = killIntegrityLabels(nextIntegrity, nextIntegrity.labels);
    }
  }
  return { confidentiality: nextConfidentiality, integrity: nextIntegrity };
}

function appendEndpointTrace(
  endpoints: readonly SemanticEndpointV2[],
  key: TaintKeyV2,
  trace: readonly TaintTraceStepV2[],
  budget: MutableTransferBudget | undefined,
): readonly TaintTraceStepV2[] | undefined {
  let output = trace;
  for (const endpoint of endpoints) {
    if (!chargeTransfer(budget)) return undefined;
    if (!pathMatch(key.field, endpoint.path) || endpoint.direction === 'SOURCE') continue;
    if (!chargeTransfer(budget, output.length + 1)) return undefined;
    output = appendTrace(output, { kind: endpoint.direction === 'SANITIZER' ? 'SANITIZER' : 'SINK', ...key });
  }
  return output;
}



function sourceStates(channel: SemanticChannelV2, taint: SemanticEndpointV2['taint']): { confidentiality: ConfidentialityState; integrity: IntegrityState } {
  const confidentiality: ConfidentialityLabel[] = channel === 'DATA' ? ['WEBHOOK_BODY'] : channel === 'MODEL' ? ['AI_MODEL_OUTPUT'] : channel === 'CONTEXT' ? ['EXTERNAL_FILE'] : [];
  const integrity: IntegrityLabel[] = channel === 'DATA' ? ['INBOUND_MESSAGE'] : channel === 'MODEL' ? ['MODEL_OUTPUT'] : channel === 'CONTEXT' ? ['RETRIEVED_CONTEXT'] : channel === 'TOOL' ? ['TOOL_RESULT'] : [];
  const unknownChannel = channel === 'ERROR' || channel === 'CONTROL';
  return {
    confidentiality: taint === 'INTEGRITY' ? bottomConfidentiality : createConfidentialityState(confidentiality, unknownChannel),
    integrity: taint === 'CONFIDENTIALITY' ? bottomIntegrity : createIntegrityState(integrity, unknownChannel),
  };
}

function pathMatch(field: string, path: string): boolean { return field === path || field.startsWith(`${path}/`); }
function appendTrace(trace: readonly TaintTraceStepV2[], step: TaintTraceStepV2): readonly TaintTraceStepV2[] { return Object.freeze([...trace, step]); }
function addFact(facts: Map<string, TaintFactV2>, value: TaintFactV2): void {
  const existing = facts.get(keyOf(value.key));
  if (!existing) { facts.set(keyOf(value.key), Object.freeze({ ...value, trace: Object.freeze(value.trace.slice()) })); return; }
  facts.set(keyOf(value.key), Object.freeze({ key: value.key, confidentiality: joinConfidentialityStates(existing.confidentiality, value.confidentiality), integrity: joinIntegrityStates(existing.integrity, value.integrity), trace: Object.freeze(existing.trace.length <= value.trace.length ? existing.trace.slice() : value.trace.slice()) }));
}
function keyOf(key: TaintKeyV2): string { return `${key.node}|${key.field}|${key.port}|${key.item}`; }
