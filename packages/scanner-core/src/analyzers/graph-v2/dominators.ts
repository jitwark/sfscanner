import type { SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';
import {
  chargeGraphOperation,
  normalizeGraphOperationBudget,
  prepareGraphV2,
  type GraphOperationBudgetInputV2,
  type GraphOperationBudgetV2,
} from './budget';
import type { GraphAnalysisStatusV2 } from './reachability';

export const VIRTUAL_ENTRY_V2 = -1;
export const VIRTUAL_ENTRY = VIRTUAL_ENTRY_V2;

export type DominatorsV2 = Readonly<{
  status: GraphAnalysisStatusV2;
  usage: GraphOperationBudgetV2;
  dominatorsByNode: readonly (readonly number[])[];
}>;

export function computeDominatorsV2(
  workflow: SecurityWorkflowV2,
  entries: ReadonlySet<number>,
  budget: GraphOperationBudgetInputV2,
): DominatorsV2 {
  const graph = prepareGraphV2(workflow);
  let counter = normalizeGraphOperationBudget(budget);
  for (let index = 0; index < graph.nodes.length; index += 1) {
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
  }
  const values = readEntries(entries);
  for (let index = 0; index < values.length; index += 1) {
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
  }
  const validEntries = values.filter((value) => value >= 0 && value < graph.nodes.length)
    .filter((value) => graph.nodes[value].enabled && graph.nodes[value].scoringEligible).sort((left, right) => left - right);
  if (validEntries.length === 0) return unresolved(counter);

  const reached = new Set<number>();
  const queue: number[] = [];
  for (const entry of validEntries) {
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
    reached.add(entry);
    queue.push(entry);
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
  }
  while (queue.length > 0) {
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
    const current = queue.shift() as number;
    for (const target of graph.outgoing[current]) {
      counter = charge(counter);
      if (counter.exhausted) return limited(counter);
      counter = charge(counter);
      if (counter.exhausted) return limited(counter);
      if (!graph.nodes[target].enabled || reached.has(target)) continue;
      reached.add(target);
      queue.push(target);
      counter = charge(counter);
      if (counter.exhausted) return limited(counter);
    }
  }

  const dominators = Array.from({ length: graph.nodes.length }, () => new Set<number>());
  const reachable = [...reached].sort((left, right) => left - right);
  for (const node of reachable) {
    const initial = validEntries.includes(node) ? [VIRTUAL_ENTRY_V2, node] : [VIRTUAL_ENTRY_V2, ...reachable];
    for (const value of initial) {
      counter = charge(counter);
      if (counter.exhausted) return limited(counter);
      dominators[node].add(value);
    }
  }
  const worklist = reachable.slice();
  const queued = new Set<number>();
  for (const node of reachable) {
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
    queued.add(node);
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
  }
  while (worklist.length > 0) {
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
    const node = worklist.shift() as number;
    queued.delete(node);
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
    if (validEntries.includes(node)) continue;
    const predecessors: number[] = [];
    for (const predecessor of graph.incoming[node]) {
      counter = charge(counter);
      if (counter.exhausted) return limited(counter);
      if (reached.has(predecessor) && graph.nodes[predecessor].enabled) predecessors.push(predecessor);
    }
    const next = new Set<number>(dominators[predecessors[0]] ?? [VIRTUAL_ENTRY_V2]);
    for (const predecessor of predecessors.slice(1)) {
      for (const value of [...next]) {
        counter = charge(counter);
        if (counter.exhausted) return limited(counter);
        if (!dominators[predecessor].has(value)) next.delete(value);
      }
    }
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
    next.add(node);
    let changed = next.size !== dominators[node].size;
    for (const value of next) {
      counter = charge(counter);
      if (counter.exhausted) return limited(counter);
      if (!dominators[node].has(value)) changed = true;
    }
    if (!changed) for (const value of dominators[node]) {
      counter = charge(counter);
      if (counter.exhausted) return limited(counter);
      if (!next.has(value)) changed = true;
    }
    if (!changed) continue;
    dominators[node] = next;
    for (const target of graph.outgoing[node]) {
      counter = charge(counter);
      if (counter.exhausted) return limited(counter);
      const targetReached = reached.has(target);
      counter = charge(counter);
      if (counter.exhausted) return limited(counter);
      const targetQueued = queued.has(target);
      if (!targetReached || targetQueued) continue;
      queued.add(target);
      worklist.push(target);
      counter = charge(counter);
      if (counter.exhausted) return limited(counter);
    }
  }

  const proof = dominators.map((set) => Object.freeze([...set].sort((left, right) => left - right)));
  return Object.freeze({ status: 'COMPLETE', usage: counter, dominatorsByNode: Object.freeze(proof) });
}
export const adaptDominatorsV2 = computeDominatorsV2;

export function dominatesV2(result: DominatorsV2, dominatorIndex: number, nodeIndex: number): boolean {
  if (result.status !== 'COMPLETE' || dominatorIndex === nodeIndex) return false;
  return result.dominatorsByNode[nodeIndex]?.includes(dominatorIndex) ?? false;
}

export const dominates = dominatesV2;

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

function charge(counter: GraphOperationBudgetV2): GraphOperationBudgetV2 { return chargeGraphOperation(counter).counter; }
function limited(usage: GraphOperationBudgetV2): DominatorsV2 { return Object.freeze({ status: 'GRAPH_WORK_LIMIT_EXCEEDED', usage, dominatorsByNode: Object.freeze([]) }); }
function unresolved(usage: GraphOperationBudgetV2): DominatorsV2 { return Object.freeze({ status: 'GRAPH_ENTRY_UNRESOLVED', usage, dominatorsByNode: Object.freeze([]) }); }
