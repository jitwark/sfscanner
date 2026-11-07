import { describe, expect, it } from 'vitest';
import type { ResolvedNodeSemanticsV2 } from '../../semantics/catalogue-schema';
import type { SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';
import { createGraphOperationBudget } from '../graph-v2/budget';
import { createConfidentialityState, createIntegrityState } from './labels';
import { runTaintWorklistV2, type TaintFactV2 } from './worklist';

const semantics = (nodeType: string, overrides: Partial<ResolvedNodeSemanticsV2> = {}): ResolvedNodeSemanticsV2 => ({
  semanticId: nodeType, nodeType, versionRange: { clauses: [] }, operation: null, entry: 'NONE', parameterPaths: [], authentication: null,
  credentialPaths: [], destinationPaths: [], effects: [], endpoints: [], ports: [], overwritePaths: [], errorMode: 'STOP', retryMode: 'NONE', disabledMode: 'SKIP',
  provenance: { sourceUrl: 'fixture', sourceDigest: 'a'.repeat(64), reviewedAt: '2026-09-08', reviewer: 'test' }, ...overrides,
});
const workflow = (count: number, pairs: readonly (readonly [number, number, number?, number?])[]): SecurityWorkflowV2 => ({
  workflowFields: [], nodes: Array.from({ length: count }, (_, ordinal) => ({ ref: { ordinal, identityDigest: `node-${ordinal}` }, type: 'test', disabled: false, scoringEligibility: 'ELIGIBLE', parameters: [], credentials: [], settings: [] })),
  edges: pairs.map((pair, ordinal) => ({ ordinal, sourceNode: { ordinal: pair[0] }, targetNode: { ordinal: pair[1] }, sourceLabel: 'out', targetLabel: 'in', connectionType: 'main', sourcePort: pair[2] ?? 0, targetPort: pair[3] ?? 0, source: { pointer: `/edges/${ordinal}`, occurrencePath: [ordinal], astNodeId: 'a'.repeat(64), span: null }, resolution: 'RESOLVED' })), ambiguities: [],
} as unknown as SecurityWorkflowV2);
const seed: TaintFactV2 = { key: { node: 0, field: '/value', port: 0, item: 2 }, confidentiality: createConfidentialityState(['WEBHOOK_BODY']), integrity: createIntegrityState([]), trace: [] };

describe('bounded dual taint worklist', () => {
  it('joins branch facts by field, port, and item key', () => {
    const graph = workflow(4, [[0, 1], [0, 2], [1, 3], [2, 3]]);
    const semanticsByNode = new Map([
      ['node-0', semantics('test')],
      ['node-1', semantics('test', { endpoints: [{ path: '/value', channel: 'MODEL', direction: 'SOURCE', taint: 'INTEGRITY' }] })],
      ['node-2', semantics('test')], ['node-3', semantics('test')],
    ]);
    const result = runTaintWorklistV2({ workflow: graph, semantics: semanticsByNode, seeds: [seed], maxTaintStates: 200 });
    expect(result.status).toBe('COMPLETE');
    expect(result.facts.find((fact) => fact.key.node === 3 && fact.key.item === 2)).toMatchObject({ confidentiality: { labels: ['WEBHOOK_BODY'] }, integrity: { labels: ['MODEL_OUTPUT'] } });
  });

  it('terminates cycles at a fixed point and discards all facts on budget exhaustion', () => {
    const graph = workflow(2, [[0, 1], [1, 0]]);
    const complete = runTaintWorklistV2({ workflow: graph, semantics: new Map([['node-0', semantics('test')], ['node-1', semantics('test')]]), seeds: [seed], maxTaintStates: 200 });
    expect(complete.status).toBe('COMPLETE');
    expect(runTaintWorklistV2({ workflow: graph, semantics: new Map(), seeds: [seed], maxTaintStates: 0 })).toMatchObject({ status: 'LIMIT_EXCEEDED', facts: [], traces: [], usage: { exhausted: true } });
  });

  it('does not treat a bounded graph limit or unresolved entry as a clean result', () => {
    const graph = workflow(1, []);
    const limited = runTaintWorklistV2({ workflow: graph, semantics: new Map(), seeds: [seed], graph: { status: 'GRAPH_WORK_LIMIT_EXCEEDED', reachable: [] }, maxTaintStates: 20 });
    const unresolved = runTaintWorklistV2({ workflow: graph, semantics: new Map(), seeds: [seed], graph: { status: 'GRAPH_ENTRY_UNRESOLVED', reachable: [] }, maxTaintStates: 20 });
    expect(limited.status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(unresolved.status).toBe('UNKNOWN');
    expect(unresolved.facts).toEqual([]);
  });
  it('derives admitted trigger entries and accepts an explicit maximum budget object', () => {
    const graph = workflow(1, []);
    const result = runTaintWorklistV2({
      workflow: graph,
      semantics: new Map([['node-0', semantics('test', { entry: 'TRIGGER', endpoints: [{ path: '/body', channel: 'DATA', direction: 'SOURCE', taint: 'CONFIDENTIALITY' }] })]]),
      budget: { maximum: 100 },
    });
    expect(result.status).toBe('COMPLETE');
    expect(result.facts).toMatchObject([{ key: { field: '/body', node: 0 }, confidentiality: { labels: ['WEBHOOK_BODY'] } }]);
  });

  it('routes a non-zero source port to the target port without losing item identity', () => {
    const graph = workflow(2, [[0, 1, 3, 7]]);
    const nonZero = { ...seed, key: { ...seed.key, port: 3 } };
    const result = runTaintWorklistV2({ workflow: graph, semantics: new Map([['node-0', semantics('test')], ['node-1', semantics('test')]]), seeds: [nonZero], maxTaintStates: 200 });
    expect(result.facts.find((fact) => fact.key.node === 1)).toMatchObject({ key: { port: 7, item: 2 } });
  });
  it('reports graph work exhaustion while transferring endpoint fan-out', () => {
    const result = runTaintWorklistV2({
      workflow: workflow(1, []),
      semantics: new Map([['node-0', semantics('test', { endpoints: [
        { path: '/value', channel: 'DATA', direction: 'SINK', taint: 'CONFIDENTIALITY' },
        { path: '/value', channel: 'DATA', direction: 'SINK', taint: 'CONFIDENTIALITY' },
      ] })]]),
      seeds: [seed],
      maxTaintStates: 100,
      graph: { status: 'COMPLETE', reachable: [0], usage: createGraphOperationBudget(1) },
    });
    expect(result.status).toBe('GRAPH_WORK_LIMIT_EXCEEDED');
    expect(result.graphUsage).toMatchObject({ maximum: 1, used: 2, exhausted: true });
    expect(result.facts).toEqual([]);
    expect(result.traces).toEqual([]);
  });
});
