import type { SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';
import {
  chargeGraphOperation,
  normalizeGraphOperationBudget,
  prepareGraphV2,
  type GraphOperationBudgetInputV2,
  type GraphOperationBudgetV2,
  type PreparedGraphV2,
} from './budget';
import type { GraphAnalysisStatusV2 } from './reachability';

export type SccsV2 = Readonly<{
  status: GraphAnalysisStatusV2;
  usage: GraphOperationBudgetV2;
  components: readonly (readonly number[])[];
  componentByNode: readonly number[];
  condensationEdges: readonly (readonly [number, number])[];
}>;

type Frame = { node: number; next: number };

export function computeSccsV2(workflow: SecurityWorkflowV2, budget: GraphOperationBudgetInputV2): SccsV2 {
  const graph = prepareGraphV2(workflow);
  let counter = normalizeGraphOperationBudget(budget);
  for (let index = 0; index < graph.nodes.length; index += 1) {
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
  }

  const discovery = Array(graph.nodes.length).fill(-1) as number[];
  const low = Array(graph.nodes.length).fill(0) as number[];
  const onStack = Array(graph.nodes.length).fill(false) as boolean[];
  const stack: number[] = [];
  const rawComponents: number[][] = [];
  let nextIndex = 0;
  for (let root = 0; root < graph.nodes.length; root += 1) {
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
    if (discovery[root] >= 0) continue;
    discovery[root] = nextIndex;
    low[root] = nextIndex;
    nextIndex += 1;
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
    stack.push(root);
    onStack[root] = true;
    counter = charge(counter);
    if (counter.exhausted) return limited(counter);
    const frames: Frame[] = [{ node: root, next: 0 }];
    while (frames.length > 0) {
      counter = charge(counter);
      if (counter.exhausted) return limited(counter);
      const frame = frames[frames.length - 1];
      const target = graph.outgoing[frame.node][frame.next];
      if (target !== undefined) {
        frame.next += 1;
        counter = charge(counter);
        if (counter.exhausted) return limited(counter);
        counter = charge(counter);
        if (counter.exhausted) return limited(counter);
        if (discovery[target] < 0) {
          discovery[target] = nextIndex;
          low[target] = nextIndex;
          nextIndex += 1;
          counter = charge(counter);
          if (counter.exhausted) return limited(counter);
          stack.push(target);
          onStack[target] = true;
          counter = charge(counter);
          if (counter.exhausted) return limited(counter);
          frames.push({ node: target, next: 0 });
        } else if (onStack[target]) {
          low[frame.node] = Math.min(low[frame.node], discovery[target]);
        }
        continue;
      }
      frames.pop();
      counter = charge(counter);
      if (counter.exhausted) return limited(counter);
      const parent = frames[frames.length - 1];
      if (parent) low[parent.node] = Math.min(low[parent.node], low[frame.node]);
      if (low[frame.node] !== discovery[frame.node]) continue;
      const component: number[] = [];
      let member: number;
      do {
        member = stack.pop() as number;
        onStack[member] = false;
        component.push(member);
        counter = charge(counter);
        if (counter.exhausted) return limited(counter);
      } while (member !== frame.node);
      rawComponents.push(component.sort((left, right) => left - right));
    }
  }

  const byNode = Array(graph.nodes.length).fill(-1) as number[];
  rawComponents.forEach((component, id) => component.forEach((node) => { byNode[node] = id; }));
  const condensation = buildCondensation(graph, byNode, counter);
  if (!condensation.ok) return limited(condensation.counter);
  const ordered = topologicalOrder(rawComponents.length, condensation.edges, condensation.counter);
  if (!ordered.ok) return limited(ordered.counter);
  const remap = Array(rawComponents.length).fill(0) as number[];
  ordered.order.forEach((oldId, newId) => { remap[oldId] = newId; });
  const components = ordered.order.map((oldId) => rawComponents[oldId]);
  const componentByNode = byNode.map((id) => remap[id]);
  const condensationEdges = condensation.edges
    .map(([from, to]) => [remap[from], remap[to]] as const)
    .sort(([leftFrom, leftTo], [rightFrom, rightTo]) => leftFrom - rightFrom || leftTo - rightTo);
  return Object.freeze({
    status: 'COMPLETE', usage: ordered.counter,
    components: Object.freeze(components.map((component) => Object.freeze(component.slice()))),
    componentByNode: Object.freeze(componentByNode),
    condensationEdges: Object.freeze(condensationEdges.map(([from, to]) => Object.freeze([from, to] as const))),
  });
}

function buildCondensation(graph: PreparedGraphV2, byNode: readonly number[], initial: GraphOperationBudgetV2): { ok: true; edges: readonly (readonly [number, number])[]; counter: GraphOperationBudgetV2 } | { ok: false; counter: GraphOperationBudgetV2 } {
  let counter = initial;
  const seen = new Set<string>();
  const edges: Array<readonly [number, number]> = [];
  for (const edge of graph.edges) {
    counter = charge(counter);
    if (counter.exhausted) return { ok: false, counter };
    const from = byNode[edge.from];
    const to = byNode[edge.to];
    if (from === to) continue;
    const key = `${from}:${to}`;
    const exists = seen.has(key);
    counter = charge(counter);
    if (counter.exhausted) return { ok: false, counter };
    if (exists) continue;
    seen.add(key);
    counter = charge(counter);
    if (counter.exhausted) return { ok: false, counter };
    edges.push([from, to]);
  }
  return { ok: true, edges: edges.sort(([a, b], [c, d]) => a - c || b - d), counter };
}

function topologicalOrder(count: number, edges: readonly (readonly [number, number])[], initial: GraphOperationBudgetV2): { ok: true; order: readonly number[]; counter: GraphOperationBudgetV2 } | { ok: false; counter: GraphOperationBudgetV2 } {
  let counter = initial;
  const outgoing = Array.from({ length: count }, () => [] as number[]);
  const indegree = Array(count).fill(0) as number[];
  for (const [from, to] of edges) {
    counter = charge(counter);
    if (counter.exhausted) return { ok: false, counter };
    outgoing[from].push(to);
    indegree[to] += 1;
  }
  const queue = indegree.map((value, id) => value === 0 ? id : -1).filter((id) => id >= 0);
  const order: number[] = [];
  while (queue.length > 0) {
    counter = charge(counter);
    if (counter.exhausted) return { ok: false, counter };
    queue.sort((left, right) => left - right);
    const current = queue.shift() as number;
    order.push(current);
    for (const target of outgoing[current]) {
      counter = charge(counter);
      if (counter.exhausted) return { ok: false, counter };
      indegree[target] -= 1;
      if (indegree[target] === 0) queue.push(target);
    }
  }
  return { ok: true, order, counter };
}

function charge(counter: GraphOperationBudgetV2): GraphOperationBudgetV2 { return chargeGraphOperation(counter).counter; }
function limited(counter: GraphOperationBudgetV2): SccsV2 { return Object.freeze({ status: 'GRAPH_WORK_LIMIT_EXCEEDED', usage: counter, components: Object.freeze([]), componentByNode: Object.freeze([]), condensationEdges: Object.freeze([]) }); }
