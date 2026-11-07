import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '../../workflow';
import { seedTaintStates } from './taint-sources';
import { buildTaintTraces, MAX_TRACE_DEPTH, upstreamNodeIndexes } from './taint-traces';

function workflowFor(count: number, edges: readonly (readonly [number, number])[]) {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `n${index}`, name: `N${index}`, type: index === 0 ? 'n8n-nodes-base.webhook' : 'n8n-nodes-base.set', parameters: {},
  }));
  const connections = Object.fromEntries(nodes.map((node, index) => [node.name, {
    main: [edges.filter(([from]) => from === index).map(([, to]) => ({ node: `N${to}`, type: 'main', index: 0 }))],
  }]));
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections }));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.workflow;
}

describe('legacy taint witness boundaries', () => {
  it('selects the shortest supported source path instead of a longer predecessor route', () => {
    const workflow = workflowFor(5, [[0, 1], [0, 3], [1, 2], [2, 4], [3, 4]]);
    const traces = buildTaintTraces(workflow, seedTaintStates(workflow));
    expect(traces.get(4)).toEqual({ sourceNodeIndex: 0, path: [0, 3, 4] });
    expect(traces.has(2)).toBe(true);
  });

  it('terminates cycles without repeating a node or treating a node as its own upstream cause', () => {
    const workflow = workflowFor(4, [[0, 1], [1, 2], [2, 1], [2, 3]]);
    const traces = buildTaintTraces(workflow, seedTaintStates(workflow));
    expect(traces.get(3)).toEqual({ sourceNodeIndex: 0, path: [0, 1, 2, 3] });
    expect(upstreamNodeIndexes(workflow, 1)).toEqual(new Set([0, 2]));
    expect([...buildTaintTraces(workflow, seedTaintStates(workflow))]).toEqual([...traces]);
  });

  it('retains the last admitted depth and omits the next hop without fabricating a truncated witness', () => {
    const edges = Array.from({ length: MAX_TRACE_DEPTH }, (_, index) => [index, index + 1] as const);
    const workflow = workflowFor(MAX_TRACE_DEPTH + 1, edges);
    const traces = buildTaintTraces(workflow, seedTaintStates(workflow));
    expect(traces.get(MAX_TRACE_DEPTH - 1)).toEqual({ sourceNodeIndex: 0, path: Array.from({ length: MAX_TRACE_DEPTH }, (_, index) => index) });
    expect(traces.has(MAX_TRACE_DEPTH)).toBe(false);
  });
});
