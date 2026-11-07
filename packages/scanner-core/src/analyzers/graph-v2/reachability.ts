import type { SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';
import {
  chargeGraphOperation,
  normalizeGraphOperationBudget,
  prepareGraphV2,
  type GraphOperationBudgetInputV2,
  type GraphOperationBudgetV2,
  type PreparedGraphV2,
} from './budget';

export type GraphAnalysisStatusV2 = 'COMPLETE' | 'GRAPH_ENTRY_UNRESOLVED' | 'GRAPH_WORK_LIMIT_EXCEEDED';
export type ReachabilityNodeStatusV2 = 'REACHABLE' | 'UNREACHABLE' | 'DISABLED' | 'NO_ENTRY';
export type ReachabilityV2 = Readonly<{
  status: GraphAnalysisStatusV2;
  usage: GraphOperationBudgetV2;
  validEntries: readonly number[];
  reachable: readonly number[];
  unreachable: readonly number[];
  nodeStatuses: readonly ReachabilityNodeStatusV2[];
}>;

export function classifyReachabilityV2(
  workflow: SecurityWorkflowV2,
  entries: ReadonlySet<number>,
  budget: GraphOperationBudgetInputV2,
): ReachabilityV2 {
  const graph = prepareGraphV2(workflow);
  let counter = normalizeGraphOperationBudget(budget);
  const values = readEntries(entries);
  const statuses: ReachabilityNodeStatusV2[] = graph.nodes.map((node) => node.enabled ? 'NO_ENTRY' : 'DISABLED');
  for (let index = 0; index < graph.nodes.length; index += 1) {
    counter = charge(counter);
    if (counter.exhausted) return limited(counter, statuses);
    counter = charge(counter);
    if (counter.exhausted) return limited(counter, statuses);
  }
  for (let index = 0; index < values.length; index += 1) {
    counter = charge(counter);
    if (counter.exhausted) return limited(counter, statuses);
  }
  const validEntries = values
    .filter((value) => value >= 0 && value < graph.nodes.length)
    .filter((value) => graph.nodes[value].enabled && graph.nodes[value].scoringEligible)
    .sort((left, right) => left - right);
  if (validEntries.length === 0) return result('GRAPH_ENTRY_UNRESOLVED', counter, [], [], [], statuses);

  const reached = new Set<number>();
  const queue: number[] = [];
  for (const entry of validEntries) {
    counter = charge(counter);
    if (counter.exhausted) return limited(counter, statuses);
    reached.add(entry);
    queue.push(entry);
    counter = charge(counter);
    if (counter.exhausted) return limited(counter, statuses);
  }
  while (queue.length > 0) {
    counter = charge(counter);
    if (counter.exhausted) return limited(counter, statuses);
    const current = queue.shift() as number;
    for (const target of graph.outgoing[current]) {
      counter = charge(counter);
      if (counter.exhausted) return limited(counter, statuses);
      counter = charge(counter);
      if (counter.exhausted) return limited(counter, statuses);
      if (!graph.nodes[target].enabled || reached.has(target)) continue;
      reached.add(target);
      counter = charge(counter);
      if (counter.exhausted) return limited(counter, statuses);
      queue.push(target);
      counter = charge(counter);
      if (counter.exhausted) return limited(counter, statuses);
    }
  }

  const reachable = [...reached].sort((left, right) => left - right);
  const unreachable: number[] = [];
  for (const node of graph.nodes) {
    counter = charge(counter);
    if (counter.exhausted) return limited(counter, statuses);
    const isReached = reached.has(node.index);
    statuses[node.index] = node.enabled ? isReached ? 'REACHABLE' : 'UNREACHABLE' : 'DISABLED';
    if (node.enabled && !isReached) unreachable.push(node.index);
  }
  return result('COMPLETE', counter, validEntries, reachable, unreachable, statuses);

}
function readEntries(entries: ReadonlySet<number>): number[] {
  try {
    if (!(entries instanceof Set) || Object.getPrototypeOf(entries) !== Set.prototype || Object.getOwnPropertyNames(entries).length !== 0 || Object.getOwnPropertySymbols(entries).length !== 0) throw new TypeError('entries must be a plain Set');
    const values: number[] = [];
    Set.prototype.forEach.call(entries, (value: unknown) => {
      if (!Number.isSafeInteger(value)) throw new TypeError('entries must contain safe integers');
      values.push(value as number);
    });
    return values;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('entries must be a closed Set');
  }
}

function charge(counter: GraphOperationBudgetV2): GraphOperationBudgetV2 {
  return chargeGraphOperation(counter).counter;
}
function limited(counter: GraphOperationBudgetV2, _statuses: readonly ReachabilityNodeStatusV2[]): ReachabilityV2 {
  return result('GRAPH_WORK_LIMIT_EXCEEDED', counter, [], [], [], []);
}
function result(
  status: GraphAnalysisStatusV2,
  usage: GraphOperationBudgetV2,
  validEntries: readonly number[],
  reachable: readonly number[],
  unreachable: readonly number[],
  nodeStatuses: readonly ReachabilityNodeStatusV2[],
): ReachabilityV2 {
  return Object.freeze({
    status,
    usage,
    validEntries: Object.freeze(validEntries.slice()),
    reachable: Object.freeze(reachable.slice()),
    unreachable: Object.freeze(unreachable.slice()),
    nodeStatuses: Object.freeze(nodeStatuses.slice()),
  });
}
