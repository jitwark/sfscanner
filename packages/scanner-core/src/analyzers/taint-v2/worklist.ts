import type { GraphOperationBudgetV2 } from '../graph-v2/budget';
import type { ResolvedNodeSemanticsV2 } from '../../semantics/catalogue-schema';
import type { CapabilityCandidateV2, SafeFactV2 } from '../../capabilities/scheduler';
import type { DestinationInventoryRecord, DestinationInventoryResult } from '../destinations/inventory';
import type { SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';
import { createConfidentialityState, createIntegrityState, joinConfidentialityStates, joinIntegrityStates, taintStateKey } from './labels';
import { transferNodeV2, type TaintFactV2, type TaintKeyV2, type TaintTraceStepV2 } from './transfer';
export type { TaintFactV2 } from './transfer';
export type TaintWorkBudgetV2 = Readonly<{ maximum: number; used: number; omitted: number; exhausted: boolean }>;
export type TaintGraphOutputV2 = Readonly<{ status: 'COMPLETE' | 'GRAPH_ENTRY_UNRESOLVED' | 'GRAPH_WORK_LIMIT_EXCEEDED'; reachable: readonly number[]; usage?: GraphOperationBudgetV2 }>;
export type TaintWorklistInputV2 = Readonly<{
  workflow: SecurityWorkflowV2;
  semantics: ReadonlyMap<string, ResolvedNodeSemanticsV2> | Readonly<{ resolvedNodeSemantics: ReadonlyMap<string, ResolvedNodeSemanticsV2> }>;
  seeds?: readonly TaintFactV2[];
  entries?: readonly number[];
  graph?: TaintGraphOutputV2;
  destinationFacts?: DestinationInventoryResult | readonly DestinationInventoryRecord[];
  codeFacts?: CapabilityCandidateV2 | readonly SafeFactV2[];
  maxTaintStates?: number;
  budget?: number | Readonly<{ maxTaintStates?: number; maximum?: number }>;
}>;
export type TaintTraceV2 = Readonly<{ key: TaintKeyV2; steps: readonly TaintTraceStepV2[] }>;
export type TaintWorklistResultV2 = Readonly<{
  status: 'COMPLETE' | 'UNKNOWN' | 'LIMIT_EXCEEDED' | 'GRAPH_WORK_LIMIT_EXCEEDED'; facts: readonly TaintFactV2[]; traces: readonly TaintTraceV2[]; omitted: number; usage: TaintWorkBudgetV2; graphUsage?: GraphOperationBudgetV2;
}>;

type MutableBudget = { maximum: number; used: number; omitted: number; exhausted: boolean };
type MutableFacts = Map<number, Map<string, TaintFactV2>>;

export function createTaintWorkBudget(maximum: number): TaintWorkBudgetV2 {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new TypeError('maxTaintStates must be a non-negative safe integer');
  return Object.freeze({ maximum, used: 0, omitted: 0, exhausted: false });
}

export function runTaintWorklistV2(input: TaintWorklistInputV2): TaintWorklistResultV2 {
  const maximum = readMaximum(input);
  const budget: MutableBudget = { maximum, used: 0, omitted: 0, exhausted: false };
  let graphBudget = input.graph?.usage;
  if (input.graph?.status === 'GRAPH_WORK_LIMIT_EXCEEDED') return finish('GRAPH_WORK_LIMIT_EXCEEDED', budget, graphBudget);
  if (input.graph?.status === 'GRAPH_ENTRY_UNRESOLVED') return finish('UNKNOWN', budget, graphBudget);
  const reachable = input.graph?.status === 'COMPLETE' ? new Set(input.graph.reachable) : undefined;
  const semantics = 'resolvedNodeSemantics' in input.semantics ? input.semantics.resolvedNodeSemantics : input.semantics;
  const facts: MutableFacts = new Map();
  const queue: number[] = [];
  const queued = new Set<number>();
  const processed = new Set<number>();
  const outgoingEdges = new Map<number, SecurityWorkflowV2['edges'][number][]>();
  for (const edge of input.workflow.edges) {
    if (!charge(budget) || edge.resolution !== 'RESOLVED' || edge.connectionType !== 'main' || edge.sourceNode === undefined || edge.targetNode === undefined) {
      if (budget.exhausted) return finish('LIMIT_EXCEEDED', budget);
      continue;
    }
    if (!validNode(edge.sourceNode.ordinal, input.workflow) || !validNode(edge.targetNode.ordinal, input.workflow)) continue;
    const edges = outgoingEdges.get(edge.sourceNode.ordinal) ?? [];
    edges.push(edge); outgoingEdges.set(edge.sourceNode.ordinal, edges);
  }
  for (const edges of outgoingEdges.values()) edges.sort((left, right) => left.ordinal - right.ordinal || left.sourcePort - right.sourcePort || (left.targetNode?.ordinal ?? -1) - (right.targetNode?.ordinal ?? -1));
  const enqueue = (node: number): boolean => {
    if (queued.has(node)) return true;
    if (!charge(budget)) return false;
    queued.add(node); queue.push(node); return true;
  };
  for (const seed of input.seeds ?? []) {
    if (!validNode(seed.key.node, input.workflow) || reachable && !reachable.has(seed.key.node)) continue;
    if (!charge(budget)) return finish('LIMIT_EXCEEDED', budget);
    merge(facts, seed.key.node, seed);
    if (!enqueue(seed.key.node)) return finish('LIMIT_EXCEEDED', budget);
  }
  const entryNodes = input.entries ?? input.workflow.nodes
    .filter((node) => semantics.get(node.ref.identityDigest)?.entry !== 'NONE')
    .map((node) => node.ref.ordinal);
  for (const node of entryNodes) {
    if (validNode(node, input.workflow) && (!reachable || reachable.has(node)) && !enqueue(node)) return finish('LIMIT_EXCEEDED', budget);
  }
  let uncertain = false;
  while (queue.length > 0) {
    if (!charge(budget)) return finish('LIMIT_EXCEEDED', budget);
    const ordinal = queue.shift() as number;
    queued.delete(ordinal);
    if (!charge(budget)) return finish('LIMIT_EXCEEDED', budget);
    const node = input.workflow.nodes[ordinal];
    const semantic = node === undefined ? undefined : semantics.get(node.ref.identityDigest);
    if (!node || reachable && !reachable.has(ordinal)) continue;
    if (node.disabled) {
      uncertain ||= semantic?.disabledMode === 'UNKNOWN';
      continue;
    }
    const firstVisit = !processed.has(ordinal);
    processed.add(ordinal);
    const incoming = [...(facts.get(ordinal)?.values() ?? [])];
    for (const fact of incoming) if (!charge(budget)) return finish('LIMIT_EXCEEDED', budget);
    const transferred = transferNodeV2({
      node, semantics: semantic, incoming,
      ...(graphBudget === undefined ? {} : { graphBudget }),
    });
    graphBudget = transferred.graphUsage ?? graphBudget;
    if (transferred.status === 'GRAPH_WORK_LIMIT_EXCEEDED') return finish('GRAPH_WORK_LIMIT_EXCEEDED', budget, graphBudget);
    uncertain ||= transferred.status === 'UNKNOWN';
    let changed = false;
    for (const fact of transferred.facts) {
      if (!charge(budget)) return finish('LIMIT_EXCEEDED', budget);
      if (!charge(budget)) return finish('LIMIT_EXCEEDED', budget);
      if (mergeChanged(facts, ordinal, fact)) changed = true;
    }
    if (!changed && !firstVisit) continue;
    for (const edge of outgoingEdges.get(ordinal) ?? []) {
      if (!charge(budget)) return finish('LIMIT_EXCEEDED', budget);
      const target = edge.targetNode?.ordinal;
      if (target === undefined || !validNode(target, input.workflow) || reachable && !reachable.has(target)) continue;
      const outgoing = [...(facts.get(ordinal)?.values() ?? [])].filter((fact) => fact.key.port === edge.sourcePort);
      for (const fact of outgoing) {
        if (!charge(budget)) return finish('LIMIT_EXCEEDED', budget);
        const traceStep: TaintTraceStepV2 = { kind: 'PROPAGATION', node: target, field: fact.key.field, port: edge.targetPort, item: fact.key.item };
        const next: TaintFactV2 = Object.freeze({ ...fact, key: Object.freeze({ ...fact.key, node: target, port: edge.targetPort }), trace: Object.freeze([...fact.trace, traceStep]) });
        if (!charge(budget)) return finish('LIMIT_EXCEEDED', budget);
        if (mergeChanged(facts, target, next) && !enqueue(target)) return finish('LIMIT_EXCEEDED', budget);
      }
    }
  }
  const output = [...facts.values()].flatMap((items) => [...items.values()]).sort(compareFacts);
  const traces = output.filter((fact) => fact.trace.length > 0).map((fact) => Object.freeze({ key: fact.key, steps: fact.trace }));
  return Object.freeze({
    status: uncertain ? 'UNKNOWN' : 'COMPLETE',
    facts: Object.freeze(output), traces: Object.freeze(traces), omitted: budget.omitted,
    usage: freezeBudget(budget), ...(graphBudget === undefined ? {} : { graphUsage: graphBudget }),
  });
}

export const analyzeTaintWorklistV2 = runTaintWorklistV2;

function readMaximum(input: TaintWorklistInputV2): number {
  const configured = typeof input.budget === 'number' ? input.budget : input.budget?.maxTaintStates ?? input.budget?.maximum;
  const value = input.maxTaintStates ?? configured ?? 10_000;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('maxTaintStates must be a non-negative safe integer');
  return value;
}
function validNode(value: number, workflow: SecurityWorkflowV2): boolean { return Number.isSafeInteger(value) && value >= 0 && value < workflow.nodes.length; }
function charge(budget: MutableBudget): boolean { budget.used += 1; budget.omitted = Math.max(0, budget.used - budget.maximum); budget.exhausted = budget.used > budget.maximum; return !budget.exhausted; }
function freezeBudget(budget: MutableBudget): TaintWorkBudgetV2 { return Object.freeze({ ...budget }); }
function finish(status: 'UNKNOWN' | 'LIMIT_EXCEEDED' | 'GRAPH_WORK_LIMIT_EXCEEDED', budget: MutableBudget, graphBudget?: GraphOperationBudgetV2): TaintWorklistResultV2 {
  if (status === 'LIMIT_EXCEEDED' && !budget.exhausted) charge(budget);
  return Object.freeze({
    status, facts: Object.freeze([]), traces: Object.freeze([]),
    omitted: status === 'GRAPH_WORK_LIMIT_EXCEEDED' ? Math.max(1, budget.omitted, graphBudget?.omitted ?? 0) : budget.omitted,
    usage: freezeBudget(budget), ...(graphBudget === undefined ? {} : { graphUsage: graphBudget }),
  });
}
function merge(facts: MutableFacts, node: number, value: TaintFactV2): void {
  const values = facts.get(node) ?? new Map<string, TaintFactV2>();
  const safe = freezeFact(value);
  const previous = values.get(keyOf(safe.key));
  values.set(keyOf(safe.key), previous ? joined(previous, safe) : safe);
  facts.set(node, values);
}
function mergeChanged(facts: MutableFacts, node: number, value: TaintFactV2): boolean {
  const values = facts.get(node) ?? new Map<string, TaintFactV2>();
  const safe = freezeFact(value);
  const previous = values.get(keyOf(safe.key));
  const next = previous ? joined(previous, safe) : safe;
  if (previous && sameFact(previous, next)) return false;
  values.set(keyOf(safe.key), next); facts.set(node, values); return true;
}
function freezeFact(value: TaintFactV2): TaintFactV2 {
  return Object.freeze({ key: Object.freeze({ ...value.key }), confidentiality: createConfidentialityState(value.confidentiality.labels, value.confidentiality.unknown), integrity: createIntegrityState(value.integrity.labels, value.integrity.unknown), trace: Object.freeze(value.trace.slice()) });
}
function joined(left: TaintFactV2, right: TaintFactV2): TaintFactV2 {
  const trace = left.trace.length <= right.trace.length ? left.trace : right.trace;
  return Object.freeze({ key: right.key, confidentiality: joinConfidentialityStates(left.confidentiality, right.confidentiality), integrity: joinIntegrityStates(left.integrity, right.integrity), trace: Object.freeze(trace.slice()) });
}
function sameFact(left: TaintFactV2, right: TaintFactV2): boolean {
  return taintStateKey(left.confidentiality) === taintStateKey(right.confidentiality)
    && taintStateKey(left.integrity) === taintStateKey(right.integrity);
}
function keyOf(key: TaintKeyV2): string { return `${key.node}|${key.field}|${key.port}|${key.item}`; }
function compareFacts(left: TaintFactV2, right: TaintFactV2): number { return left.key.node - right.key.node || left.key.field.localeCompare(right.key.field) || left.key.port - right.key.port || left.key.item - right.key.item; }
