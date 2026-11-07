import { describe, expect, it, vi } from 'vitest';
import { parseWorkflowJson } from './workflow';
import { VIRTUAL_ENTRY, computeExecutionDominators, dominates } from './graph-dominators';

const node = (name: string) => ({ id: name, name, type: 'n8n-nodes-base.noOp', parameters: {} });
const to = (...names: string[]) => ({ main: [names.map((name) => ({ node: name, type: 'main', index: 0 }))] });

interface ModernReadonlySetMethods<T> {
  union<U>(other: ReadonlySet<U>): Set<T | U>;
  intersection<U>(other: ReadonlySet<U>): Set<T & U>;
  difference<U>(other: ReadonlySet<U>): Set<T>;
  symmetricDifference<U>(other: ReadonlySet<U>): Set<T | U>;
  isSubsetOf(other: ReadonlySet<unknown>): boolean;
  isSupersetOf(other: ReadonlySet<unknown>): boolean;
  isDisjointFrom(other: ReadonlySet<unknown>): boolean;
}

function dominatorsOf(nodes: string[], connections: Record<string, unknown>) {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes: nodes.map(node), connections }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return computeExecutionDominators(parsed.workflow);
}

function largeReverseChain(size: number) {
  const nodes = Array.from({ length: size }, (_value, index) => node(`N${index}`));
  const connections: Record<string, unknown> = {};
  for (let index = size - 1; index > 0; index -= 1) connections[`N${index}`] = to(`N${index - 1}`);
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.workflow;
}

describe('scanner-core execution dominators', () => {
  it('requires a gate on every branch and keeps unreachable nodes fail-closed', () => {
    const branched = dominatorsOf(['Start', 'Left', 'Right', 'Target'], {
      Start: to('Left', 'Right'), Left: to('Target'), Right: to('Target'),
    });
    expect(dominates(branched, 0, 3)).toBe(true);
    expect(dominates(branched, 1, 3)).toBe(false);

    const unreachable = dominatorsOf(['Entry', 'Cycle', 'Tail'], { Cycle: to('Tail'), Tail: to('Cycle') });
    expect(dominates(unreachable, 0, 1)).toBe(false);
    expect(Array.from(unreachable.dominatorsByNode[1] ?? [])).toEqual([VIRTUAL_ENTRY, 1]);
  });

  it('does not treat a node as dominating itself', () => {
    const result = dominatorsOf(['A', 'B'], { A: to('B') });
    expect(dominates(result, 1, 1)).toBe(false);
  });

  it('retains the exported ReadonlySet interface over compact bitset storage', () => {
    const result = dominatorsOf(['A', 'B'], { A: to('B') });
    const dominators: ReadonlySet<number> = result.dominatorsByNode[1]!;
    const modernDominators = dominators as ReadonlySet<number> & ModernReadonlySetMethods<number>;
    const expected = [VIRTUAL_ENTRY, 0, 1];
    const visited: number[] = [];

    expect(dominators.size).toBe(3);
    expect(Array.from(dominators.keys())).toEqual(expected);
    expect(Array.from(dominators.values())).toEqual(expected);
    expect(Array.from(dominators.entries())).toEqual(expected.map((value) => [value, value]));
    const additional = new Set([0, 2]);
    expect(Array.from(modernDominators.union(additional))).toEqual([VIRTUAL_ENTRY, 0, 1, 2]);
    expect(Array.from(modernDominators.intersection(additional))).toEqual([0]);
    expect(Array.from(modernDominators.difference(additional))).toEqual([VIRTUAL_ENTRY, 1]);
    expect(Array.from(modernDominators.symmetricDifference(additional))).toEqual([VIRTUAL_ENTRY, 1, 2]);
    expect(modernDominators.isSubsetOf(modernDominators.union(additional))).toBe(true);
    expect(modernDominators.isSubsetOf(new Set([0]))).toBe(false);
    expect(modernDominators.isSupersetOf(new Set([0]))).toBe(true);
    expect(modernDominators.isSupersetOf(new Set([0, 2]))).toBe(false);
    expect(modernDominators.isDisjointFrom(new Set([3]))).toBe(true);
    expect(modernDominators.isDisjointFrom(new Set([1]))).toBe(false);
    dominators.forEach((value, value2, set) => {
      expect(value2).toBe(value);
      expect(set).toBe(dominators);
      visited.push(value);
    });
    expect(visited).toEqual(expected);
  });

  it('bounds a legal 5,000-node chain without allocating quadratic Set state', () => {
    const workflow = largeReverseChain(5_000);
    const OriginalSet = globalThis.Set;
    class GuardedSet<T> extends OriginalSet<T> {
      constructor(values?: readonly T[] | Iterable<T>) {
        if (Array.isArray(values) && values.length > 64) throw new Error('quadratic dominator Set allocation');
        super(values);
      }
    }
    vi.stubGlobal('Set', GuardedSet);
    try {
      const result = computeExecutionDominators(workflow);
      expect(result.limitExceeded).toBe(true);
      expect(result.dominatorsByNode).toEqual([]);
      expect(dominates(result, 4_999, 0)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
