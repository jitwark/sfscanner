import type { NormalizedWorkflow } from './workflow';
import type { RawWorkflowEdge } from './workflow-graph';
import { predecessorsByNode, successorsByNode } from './workflow-graph-adjacency';

export const VIRTUAL_ENTRY = -1;
export type ExecutionDominators = Readonly<{
  dominatorsByNode: readonly ReadonlySet<number>[];
  limitExceeded?: true;
}>;

interface ReadonlySetLike<T> {
  readonly size: number;
  has(value: T): boolean;
  keys(): Iterator<T>;
}

const MAX_DOMINATOR_NODES = 5_000;
const MAX_DOMINATOR_EDGES = 10_000;
const MAX_DOMINATOR_WORD_OPERATIONS = 4_000_000;

export function computeExecutionDominators(workflow: NormalizedWorkflow): ExecutionDominators {
  const nodeCount = workflow.nodes.length;
  const edges = workflow.graph.views.execution;
  if (nodeCount > MAX_DOMINATOR_NODES || edges.length > MAX_DOMINATOR_EDGES) return exhaustedResult();

  const nodeIndexes = workflow.nodes.map((_node, index) => index);
  const predecessors = predecessorsByNode(edges);
  const entryPoints = nodeIndexes.filter((index) => (predecessors.get(index) ?? []).length === 0);
  const reachable = reachableFrom(entryPoints, successorsByNode(edges));
  const wordCount = Math.ceil((nodeCount + 1) / 32);
  const bitsets = nodeIndexes.map(() => new Uint32Array(wordCount));
  initialize(bitsets, nodeCount, reachable);

  let work = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const index of nodeIndexes) {
      if (!reachable.has(index)) continue;
      const incoming = predecessors.get(index) ?? [];
      const cost = wordCount * (incoming.length + 1);
      if (work > MAX_DOMINATOR_WORD_OPERATIONS - cost) return exhaustedResult();
      work += cost;
      changed = intersectPredecessors(bitsets, index, incoming) || changed;
    }
  }
  return resultFor(bitsets, nodeCount);
}

export function dominates(result: ExecutionDominators, dominatorIndex: number, nodeIndex: number): boolean {
  if (result.limitExceeded || dominatorIndex === nodeIndex) return false;
  return result.dominatorsByNode[nodeIndex]?.has(dominatorIndex) ?? false;
}

function initialize(bitsets: Uint32Array[], nodeCount: number, reachable: ReadonlySet<number>): void {
  const wordCount = bitsets[0]?.length ?? 0;
  const bitCount = nodeCount + 1;
  const remainingBits = bitCount & 31;
  for (let index = 0; index < nodeCount; index += 1) {
    const bits = bitsets[index];
    if (!bits) continue;
    if (reachable.has(index)) {
      bits.fill(0xffffffff);
      if (remainingBits !== 0) bits[wordCount - 1] = (1 << remainingBits) - 1;
    } else {
      setBit(bits, 0);
      setBit(bits, index + 1);
    }
  }
}

function intersectPredecessors(
  bitsets: Uint32Array[],
  index: number,
  incoming: readonly RawWorkflowEdge[],
): boolean {
  const current = bitsets[index];
  if (!current) return false;
  let changed = false;
  for (let word = 0; word < current.length; word += 1) {
    let next = incoming.length === 0 ? 0 : 0xffffffff;
    for (const edge of incoming) next &= bitsets[edge.fromNodeIndex]?.[word] ?? 0;
    if (word === 0 && incoming.length === 0) next |= 1;
    const selfBit = index + 1;
    if ((selfBit >>> 5) === word) next |= 1 << (selfBit & 31);
    if (current[word] === next) continue;
    current[word] = next;
    changed = true;
  }
  return changed;
}

function setBit(words: Uint32Array, bit: number): void {
  words[bit >>> 5] = (words[bit >>> 5] ?? 0) | (1 << (bit & 31));
}

function reachableFrom(entryPoints: readonly number[], successors: ReturnType<typeof successorsByNode>): Set<number> {
  const reached = new Set<number>(entryPoints);
  const queue = [...entryPoints];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current === undefined) continue;
    for (const edge of successors.get(current) ?? []) {
      if (reached.has(edge.toNodeIndex)) continue;
      reached.add(edge.toNodeIndex);
      queue.push(edge.toNodeIndex);
    }
  }
  return reached;
}

function resultFor(bitsets: Uint32Array[], nodeCount: number): ExecutionDominators {
  return Object.freeze({
    dominatorsByNode: Object.freeze(bitsets.map((words) => new BitSetView(words, nodeCount))),
  });
}

function exhaustedResult(): ExecutionDominators {
  return Object.freeze({ dominatorsByNode: Object.freeze([]), limitExceeded: true });
}

class BitSetView implements ReadonlySet<number> {
  readonly #words: Uint32Array;
  readonly #nodeCount: number;

  constructor(words: Uint32Array, nodeCount: number) {
    this.#words = words;
    this.#nodeCount = nodeCount;
  }

  get size(): number {
    return this.#words.reduce((count, word) => count + popcount(word), 0);
  }

  has(value: number): boolean {
    if (value === VIRTUAL_ENTRY) return ((this.#words[0] ?? 0) & 1) !== 0;
    if (!Number.isInteger(value) || value < 0 || value >= this.#nodeCount) return false;
    const bit = value + 1;
    return ((this.#words[bit >>> 5] ?? 0) & (1 << (bit & 31))) !== 0;
  }

  union<U>(other: ReadonlySetLike<U>): Set<number | U> {
    const result = new Set<number | U>(this);
    for (const value of iteratorValues(other.keys())) result.add(value);
    return result;
  }

  intersection<U>(other: ReadonlySetLike<U>): Set<number & U> {
    const result = new Set<number & U>();
    if (this.size <= other.size) {
      for (const value of this) if (other.has(value as U)) result.add(value as number & U);
    } else {
      for (const value of iteratorValues(other.keys())) {
        if (this.has(value as number)) result.add(value as number & U);
      }
    }
    return result;
  }

  difference<U>(other: ReadonlySetLike<U>): Set<number> {
    const result = new Set<number>(this);
    for (const value of iteratorValues(other.keys())) result.delete(value as number);
    return result;
  }

  symmetricDifference<U>(other: ReadonlySetLike<U>): Set<number | U> {
    const result = new Set<number | U>(this);
    for (const value of iteratorValues(other.keys())) {
      if (result.has(value)) result.delete(value);
      else result.add(value);
    }
    return result;
  }

  isSubsetOf(other: ReadonlySetLike<unknown>): boolean {
    if (this.size > other.size) return false;
    for (const value of this) if (!other.has(value)) return false;
    return true;
  }

  isSupersetOf(other: ReadonlySetLike<unknown>): boolean {
    if (this.size < other.size) return false;
    for (const value of iteratorValues(other.keys())) if (!this.has(value as number)) return false;
    return true;
  }

  isDisjointFrom(other: ReadonlySetLike<unknown>): boolean {
    if (this.size <= other.size) {
      for (const value of this) if (other.has(value)) return false;
    } else {
      for (const value of iteratorValues(other.keys())) if (this.has(value as number)) return false;
    }
    return true;
  }

  *entries(): SetIterator<[number, number]> {
    for (const value of this.values()) yield [value, value];
  }

  keys(): SetIterator<number> {
    return this.values();
  }

  *values(): SetIterator<number> {
    if (this.has(VIRTUAL_ENTRY)) yield VIRTUAL_ENTRY;
    for (let index = 0; index < this.#nodeCount; index += 1) if (this.has(index)) yield index;
  }

  [Symbol.iterator](): SetIterator<number> {
    return this.values();
  }

  forEach(callback: (value: number, value2: number, set: ReadonlySet<number>) => void, thisArg?: unknown): void {
    for (const value of this.values()) callback.call(thisArg, value, value, this);
  }
}

function* iteratorValues<T>(iterator: Iterator<T>): IterableIterator<T> {
  for (let next = iterator.next(); !next.done; next = iterator.next()) yield next.value;
}

function popcount(input: number): number {
  let value = input >>> 0;
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
