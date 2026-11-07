import type { NormalizedWorkflow } from '../../workflow';
import { predecessorsByNode, successorsByNode } from '../../workflow-graph-adjacency';
import { MAX_TAINT_LATTICE_ASCENT, TAINT_SINK_KINDS, bottomTaintState, createTaintState, joinTaintStates, taintStatesEqual, type TaintState } from './taint-lattice';

export const MAX_TAINT_STATE_UPDATES = 20_000;
export type TaintPropagationResult = {
  readonly outputStates: readonly TaintState[];
  readonly updates: number;
  readonly maxUpdates: number;
  readonly reachedFixedPoint: boolean;
  readonly limitExceeded: boolean;
};
export type TaintPropagationOptions = {
  maxUpdates?: number;
  transfer?: (nodeIndex: number, state: TaintState) => TaintState;
};

export function propagateTaint(workflow: NormalizedWorkflow, seeds: readonly TaintState[], options: TaintPropagationOptions = {}): TaintPropagationResult {
  const edges = workflow.graph.views.execution;
  const successors = successorsByNode(edges);
  const predecessors = predecessorsByNode(edges);
  const outputStates = workflow.nodes.map((_node, index) => seeds[index] ?? bottomTaintState);
  const maxUpdates = options.maxUpdates ?? updateBudget(workflow.nodes.length);
  const queue = workflow.nodes.map((_node, index) => index);
  const queued = new Set(queue);
  // Head-index cursor: dequeue is O(1) instead of `Array.prototype.shift`'s O(n) move of the
  // remaining slots. The cursor only advances and the array is only appended to, so the dequeue
  // sequence is exactly the one `shift()` produced.
  let head = 0;
  let updates = 0;
  let limitExceeded = false;
  while (head < queue.length) {
    if (updates >= maxUpdates) { limitExceeded = true; break; }
    const index = queue[head] as number;
    head += 1;
    queued.delete(index);
    updates += 1;
    const joined = (predecessors.get(index) ?? []).reduce(
      (state, edge) => joinTaintStates(state, outputStates[edge.fromNodeIndex]),
      seeds[index] ?? bottomTaintState,
    );
    const next = options.transfer ? options.transfer(index, joined) : joined;
    if (taintStatesEqual(next, outputStates[index])) continue;
    outputStates[index] = next;
    for (const edge of successors.get(index) ?? []) {
      if (queued.has(edge.toNodeIndex)) continue;
      queued.add(edge.toNodeIndex);
      queue.push(edge.toNodeIndex);
    }
  }
  // The result owns every state it publishes: each is copied out of this call's working vector, so
  // mutating the caller's seeds or the shared bottom/top identities afterwards cannot rewrite what a
  // consumer already read, and the vector itself cannot be re-pointed.
  const published = outputStates.map((state) => createTaintState(state.labels, state.sanitizedFor));
  return Object.freeze({ outputStates: Object.freeze(published), updates, maxUpdates, reachedFixedPoint: !limitExceeded, limitExceeded });
}

export function incomingTaint(result: TaintPropagationResult, workflow: NormalizedWorkflow, nodeIndex: number, inputIndex = 0): TaintState {
  return incomingTaintFrom(result.outputStates, workflow, nodeIndex, inputIndex);
}

/** Joins the states an explicit per-node taint vector holds for every predecessor of one input. */
export function incomingTaintFrom(outputStates: readonly TaintState[], workflow: NormalizedWorkflow, nodeIndex: number, inputIndex = 0): TaintState {
  // The join starts from an owned bottom state, never the shared identity: no caller can reach the
  // module's bottom value through this function and edit it into another caller's result, and a
  // predecessor-free node still receives a complete, owned state.
  let state = createTaintState([], TAINT_SINK_KINDS);
  for (const edge of workflow.graph.views.execution) {
    if (edge.toNodeIndex !== nodeIndex || edge.toInputIndex !== inputIndex) continue;
    state = joinTaintStates(state, outputStates[edge.fromNodeIndex]);
  }
  return state;
}

function updateBudget(nodeCount: number): number {
  return Math.min(nodeCount * (MAX_TAINT_LATTICE_ASCENT + 1) + 1, MAX_TAINT_STATE_UPDATES);
}
