import { describe, expect, it } from 'vitest';
import { parseWorkflowJson, type NormalizedWorkflow } from '@hub/scanner-core/workflow';
import { seedTaintStates } from '@hub/scanner-core/analyzers/taint/taint-sources';
import { buildTaintTraces, upstreamNodeIndexes } from '@hub/scanner-core/analyzers/taint/taint-traces';

function workflowOf(nodes: unknown[], connections: Record<string, unknown>): NormalizedWorkflow {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.workflow;
}

const webhook = (name: string) => ({ id: name, name, type: 'n8n-nodes-base.webhook', parameters: {} });
const set = (name: string) => ({ id: name, name, type: 'n8n-nodes-base.set', parameters: {} });
const main = (to: string) => ({ main: [[{ node: to, type: 'main', index: 0 }]] });

const traces = (workflow: NormalizedWorkflow) => buildTaintTraces(workflow, seedTaintStates(workflow));

describe('buildTaintTraces', () => {
  it('records the path from the source to each node it reaches', () => {
    const workflow = workflowOf([webhook('W'), set('A'), set('B')], { W: main('A'), A: main('B') });

    expect(traces(workflow).get(2)).toEqual({ sourceNodeIndex: 0, path: [0, 1, 2] });
  });

  it('records the source itself with a single-node path', () => {
    const workflow = workflowOf([webhook('W')], {});

    expect(traces(workflow).get(0)).toEqual({ sourceNodeIndex: 0, path: [0] });
  });

  it('records nothing for a node no source reaches', () => {
    const workflow = workflowOf([webhook('W'), set('Orphan')], {});

    expect(traces(workflow).get(1)).toBeUndefined();
  });

  it('resolves deterministically to the lowest-indexed source when two reach a node', () => {
    const workflow = workflowOf([webhook('First'), webhook('Second'), set('Target')], {
      First: main('Target'), Second: main('Target'),
    });

    expect(traces(workflow).get(2)?.sourceNodeIndex).toBe(0);
  });

  it('terminates on a cycle', () => {
    const workflow = workflowOf([webhook('W'), set('A'), set('B')], {
      W: main('A'), A: main('B'), B: main('A'),
    });

    expect(traces(workflow).get(2)).toEqual({ sourceNodeIndex: 0, path: [0, 1, 2] });
  });
});

describe('upstreamNodeIndexes', () => {
  it('returns every node that can reach the given node, and not the node itself', () => {
    const workflow = workflowOf([webhook('W'), set('A'), set('B'), set('Aside')], {
      W: main('A'), A: main('B'),
    });

    expect([...upstreamNodeIndexes(workflow, 2)].sort()).toEqual([0, 1]);
  });

  it('terminates on a cycle and excludes the node itself even when it is in one', () => {
    const workflow = workflowOf([webhook('W'), set('A'), set('B')], {
      W: main('A'), A: main('B'), B: main('A'),
    });

    expect([...upstreamNodeIndexes(workflow, 1)].sort()).toEqual([0, 2]);
  });

  it('is empty for a node with no predecessor', () => {
    const workflow = workflowOf([webhook('W'), set('Orphan')], {});

    expect([...upstreamNodeIndexes(workflow, 1)]).toEqual([]);
  });
});
