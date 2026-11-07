import { describe, expect, it } from 'vitest';
import { predecessorsByNode, successorsByNode } from './workflow-graph-adjacency';
import { buildWorkflowGraph } from './workflow-graph';

const nodes = [{ name: 'Trigger' }, { name: 'Agent' }, { name: 'Tool' }, { name: 'Model' }];

describe('scanner-core workflow graph', () => {
  it('preserves edge ordinals, output/input indexes, and reviewed views', () => {
    const graph = buildWorkflowGraph(nodes, {
      Trigger: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
      Tool: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 1 }]] },
      Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
    });

    expect(graph.edges).toEqual([
      { ordinal: 0, connectionType: 'main', fromNodeIndex: 0, fromOutputIndex: 0, toNodeIndex: 1, toInputIndex: 0 },
      { ordinal: 1, connectionType: 'ai_tool', fromNodeIndex: 2, fromOutputIndex: 0, toNodeIndex: 1, toInputIndex: 1 },
      { ordinal: 2, connectionType: 'ai_languageModel', fromNodeIndex: 3, fromOutputIndex: 0, toNodeIndex: 1, toInputIndex: 0 },
    ]);
    expect(graph.views.execution).toEqual([graph.edges[0]]);
    expect(graph.views.capability).toEqual([graph.edges[1]]);
    expect(graph.views.context).toEqual([graph.edges[2]]);
    expect(graph.views.unknown).toEqual([]);
  });

  it('preserves empty output slots and classifies unknown connection types safely', () => {
    const graph = buildWorkflowGraph([{ name: 'Source' }, { name: 'Target' }], {
      Source: {
        main: [null, [{ node: 'Target' }]],
        ai_future: [[{ node: 'Target' }]],
        ai_tool: [[{ node: 'Target' }]],
      },
    });

    expect(graph.edges.map((edge) => [edge.connectionType, edge.fromOutputIndex])).toEqual([
      ['main', 1], ['ai_future', 0], ['ai_tool', 0],
    ]);
    expect(graph.views.unknown.map((edge) => edge.connectionType)).toEqual(['ai_future']);
  });

  it('reports malformed, unknown, and ambiguous ends without fabricating edges', () => {
    const graph = buildWorkflowGraph([{ name: 'Dup' }, { name: 'Dup' }, { name: 'Trigger' }], {
      Trigger: {
        main: [[{ node: 'Dup' }, { node: 'Absent' }, { notANode: 'Dup' }]],
      },
      Missing: { main: [[{ node: 'Trigger' }]] },
      Broken: 'not-an-object',
    });

    expect(graph.edges).toEqual([]);
    expect(graph.diagnostics).toEqual([
      { code: 'AMBIGUOUS_CONNECTION_TARGET' },
      { code: 'UNKNOWN_CONNECTION_TARGET' },
      { code: 'MALFORMED_CONNECTION_ENTRY' },
      { code: 'UNKNOWN_CONNECTION_SOURCE' },
      { code: 'UNKNOWN_CONNECTION_SOURCE' },
    ]);
  });

  it('stops deterministically at the edge budget', () => {
    const graph = buildWorkflowGraph(nodes, {
      Trigger: { main: [[{ node: 'Agent' }, { node: 'Tool' }]] },
    }, { maxEdges: 1 });

    expect(graph.edges).toHaveLength(1);
    expect(graph.limitExceeded).toBe(true);
    expect(graph.views.execution).toEqual(graph.edges);
  });

  it('derives stable successor and predecessor indexes from edge order', () => {
    const graph = buildWorkflowGraph(nodes, {
      Trigger: { main: [[{ node: 'Agent' }, { node: 'Tool' }]] },
      Tool: { ai_tool: [[{ node: 'Agent' }]] },
    });

    expect(successorsByNode(graph.edges).get(0)?.map((edge) => edge.toNodeIndex)).toEqual([1, 2]);
    expect(predecessorsByNode(graph.edges).get(1)?.map((edge) => edge.fromNodeIndex)).toEqual([0, 2]);
  });

  it('defaults a missing target index to 0 without a diagnostic', () => {
    const graph = buildWorkflowGraph([{ name: 'Source' }, { name: 'Target' }], {
      Source: { main: [[{ node: 'Target', type: 'main' }]] },
    });

    expect(graph.edges).toEqual([
      { ordinal: 0, connectionType: 'main', fromNodeIndex: 0, fromOutputIndex: 0, toNodeIndex: 1, toInputIndex: 0 },
    ]);
    expect(graph.diagnostics).toEqual([]);
  });

  it.each([
    ['zero', 0],
    ['a positive integer', 3],
  ])('accepts %s as a target index', (_label, value) => {
    const graph = buildWorkflowGraph([{ name: 'Source' }, { name: 'Target' }], {
      Source: { main: [[{ node: 'Target', type: 'main', index: value }]] },
    });

    expect(graph.edges).toEqual([
      { ordinal: 0, connectionType: 'main', fromNodeIndex: 0, fromOutputIndex: 0, toNodeIndex: 1, toInputIndex: value },
    ]);
    expect(graph.diagnostics).toEqual([]);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
    ['a numeric string', '0'],
    ['a non-numeric string', 'abc'],
    ['an object', {}],
    ['an array', []],
  ])('rejects a %s target index without fabricating an edge or an implied zero', (_label, value) => {
    const graph = buildWorkflowGraph([{ name: 'Source' }, { name: 'Target' }], {
      Source: { main: [[{ node: 'Target', type: 'main', index: value }]] },
    });

    expect(graph.edges).toEqual([]);
    expect(graph.diagnostics).toEqual([
      { code: 'MALFORMED_CONNECTION_INDEX', pointer: '/connections/Source/main/0/0/index' },
    ]);
  });

  it('locates each malformed index independently by its own JSON pointer', () => {
    const graph = buildWorkflowGraph([{ name: 'Source' }, { name: 'A' }, { name: 'B' }], {
      Source: { main: [[{ node: 'A', index: -1 }, { node: 'B', index: 1.5 }]] },
    });

    expect(graph.edges).toEqual([]);
    expect(graph.diagnostics).toEqual([
      { code: 'MALFORMED_CONNECTION_INDEX', pointer: '/connections/Source/main/0/0/index' },
      { code: 'MALFORMED_CONNECTION_INDEX', pointer: '/connections/Source/main/0/1/index' },
    ]);
  });
});

describe('Q03.3 edge resolutions and stable analysis order', () => {
  it('resolves duplicate labels to UNKNOWN in both input orders without selecting a node', () => {
    const duplicateNodes = [{ name: 'Dup', id: 'node-1' }, { name: 'Dup', id: 'node-2' }, { name: 'Trigger', id: 't' }];
    for (const connections of [
      { Trigger: { main: [[{ node: 'Dup', index: 0 }, { node: 'Dup', index: 1 }]] } },
      { Trigger: { main: [[{ node: 'Dup', index: 1 }, { node: 'Dup', index: 0 }]] } },
    ]) {
      const graph = buildWorkflowGraph(duplicateNodes, connections);
      expect(graph.edges).toEqual([]);
      expect(graph.resolutions).toEqual([
        { state: 'UNKNOWN', reason: 'AMBIGUOUS_LABEL', label: 'Dup', inputOrdinal: 0 },
        { state: 'UNKNOWN', reason: 'AMBIGUOUS_LABEL', label: 'Dup', inputOrdinal: 1 },
      ]);
    }
  });

  it('keeps immutable ids in exact resolutions and sorts analysis edges deterministically', () => {
    const graph = buildWorkflowGraph(
      [{ name: 'B', id: 'id-b' }, { name: 'A', id: 'id-a' }, { name: 'C', id: 'id-c' }],
      {
        B: { main: [[{ node: 'C' }]] },
        A: { main: [[{ node: 'C' }, { node: 'B' }]] },
      },
    );
    expect(graph.analysisEdges.map((edge) => [edge.fromNodeIndex, edge.toNodeIndex])).toEqual([[1, 0], [1, 2], [0, 2]]);
    expect(graph.resolutions).toEqual([
      { state: 'EXACT', from: 'u:4:id-b', to: 'u:4:id-c', channel: 'main', inputOrdinal: 0 },
      { state: 'EXACT', from: 'u:4:id-a', to: 'u:4:id-c', channel: 'main', inputOrdinal: 0 },
      { state: 'EXACT', from: 'u:4:id-a', to: 'u:4:id-b', channel: 'main', inputOrdinal: 1 },
    ]);
  });

  it('resolves a two-node cycle deterministically', () => {
    const graph = buildWorkflowGraph([{ name: 'A', id: 'a' }, { name: 'B', id: 'b' }], {
      A: { main: [[{ node: 'B' }]] },
      B: { main: [[{ node: 'A' }]] },
    });
    expect(graph.resolutions).toEqual([
      { state: 'EXACT', from: 'u:1:a', to: 'u:1:b', channel: 'main', inputOrdinal: 0 },
      { state: 'EXACT', from: 'u:1:b', to: 'u:1:a', channel: 'main', inputOrdinal: 0 },
    ]);
    expect(graph.analysisEdges).toHaveLength(2);
  });

  it('keeps same-id nodes distinct in resolved edge identity', () => {
    const nodes = [{ name: 'A', id: 'dup' }, { name: 'B', id: 'dup' }];
    const forward = buildWorkflowGraph(nodes, { A: { main: [[{ node: 'B' }]] } });
    const reverse = buildWorkflowGraph([...nodes].reverse(), { A: { main: [[{ node: 'B' }]] } });
    expect(forward.resolutions[0]).toMatchObject({ state: 'EXACT' });
    expect(reverse.resolutions[0]).toMatchObject({ state: 'EXACT' });
    if (forward.resolutions[0]?.state !== 'EXACT' || reverse.resolutions[0]?.state !== 'EXACT') return;
    expect(forward.resolutions[0].from).not.toBe(forward.resolutions[0].to);
    expect([reverse.resolutions[0].from, reverse.resolutions[0].to])
      .toEqual([forward.resolutions[0].from, forward.resolutions[0].to]);
  });

  it('does not collide duplicate-id encodings with user identity strings', () => {
    const graph = buildWorkflowGraph(
      [{ name: 'y', id: 'x' }, { name: 'z', id: 'x' }, { name: 'x#y' }],
      { y: { main: [[{ node: 'z' }]] }, z: { main: [[{ node: 'x#y' }]] } },
    );
    const identities = graph.resolutions.flatMap((edge) => edge.state === 'EXACT' ? [edge.from, edge.to] : []);
    expect([...new Set(identities)].sort()).toEqual(['d:1:x#n:1:y', 'd:1:x#n:1:z', 'u:3:x#y']);
  });

  it('keeps analysis identity order stable when node positions permute', () => {
    const connections = { A: { main: [[{ node: 'B' }, { node: 'C' }]] }, B: { main: [[{ node: 'C' }]] } };
    const forward = buildWorkflowGraph([{ name: 'A', id: 'id-a' }, { name: 'B', id: 'id-b' }, { name: 'C', id: 'id-c' }], connections);
    const permuted = buildWorkflowGraph([{ name: 'C', id: 'id-c' }, { name: 'B', id: 'id-b' }, { name: 'A', id: 'id-a' }], connections);
    const pairs = (graph: ReturnType<typeof buildWorkflowGraph>, nodes: ReadonlyArray<{ id?: string }>) => {
      const ids = nodes.map((node) => node.id);
      return graph.analysisEdges.map((edge) => [ids[edge.fromNodeIndex], ids[edge.toNodeIndex]]);
    };
    expect(pairs(forward, [{ id: 'id-a' }, { id: 'id-b' }, { id: 'id-c' }]))
      .toEqual([['id-a', 'id-b'], ['id-a', 'id-c'], ['id-b', 'id-c']]);
    expect(pairs(permuted, [{ id: 'id-c' }, { id: 'id-b' }, { id: 'id-a' }])).toEqual(pairs(forward, [{ id: 'id-a' }, { id: 'id-b' }, { id: 'id-c' }]));
  });

  it('records missing labels, invalid ports and self-loops explicitly', () => {
    const graph = buildWorkflowGraph([{ name: 'A', id: 'a' }], {
      A: { main: [[{ node: 'A' }, { node: 'Missing', index: 0 }, { node: 'A', index: -1 }]] },
    });
    expect(graph.resolutions).toEqual([
      { state: 'EXACT', from: 'u:1:a', to: 'u:1:a', channel: 'main', inputOrdinal: 0 },
      { state: 'UNKNOWN', reason: 'MISSING_LABEL', label: 'Missing', inputOrdinal: 1 },
      { state: 'UNKNOWN', reason: 'INVALID_PORT', label: 'A', inputOrdinal: 2 },
    ]);
    expect(graph.diagnostics).toEqual([
      { code: 'UNKNOWN_CONNECTION_TARGET' },
      { code: 'MALFORMED_CONNECTION_INDEX', pointer: '/connections/A/main/0/2/index' },
    ]);
  });
});
