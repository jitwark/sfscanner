import { describe, expect, it } from 'vitest';
import type { ResolvedNodeSemanticsV2 } from '../../semantics/catalogue-schema';
import { createConfidentialityState, createIntegrityState } from './labels';
import { resolveSubworkflowSemantics, type SubworkflowDefinitionV2 } from './subworkflow';
import type { SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';
import type { TaintFactV2 } from './transfer';

const node = (ordinal: number, type = 'fixture', parameters: readonly never[] = []) => ({ ref: { ordinal, identityDigest: `node-${ordinal}`, source: { pointer: `/nodes/${ordinal}` } }, type, disabled: false, scoringEligibility: 'ELIGIBLE', parameters, credentials: [], settings: [] }) as never;
const workflow = (nodes: readonly unknown[]): SecurityWorkflowV2 => Object.freeze({ workflowFields: Object.freeze([]), nodes: Object.freeze([...nodes]), edges: Object.freeze([]), ambiguities: Object.freeze([]) }) as unknown as SecurityWorkflowV2;
const semantics = (nodeType: string, effects: ResolvedNodeSemanticsV2['effects'] = [], entry: ResolvedNodeSemanticsV2['entry'] = 'NONE'): ResolvedNodeSemanticsV2 => Object.freeze({
  semanticId: nodeType, nodeType, versionRange: Object.freeze({ clauses: Object.freeze([]) }), operation: null, entry, parameterPaths: Object.freeze([]), authentication: null,
  credentialPaths: Object.freeze([]), destinationPaths: Object.freeze([]), effects: Object.freeze([...effects]), endpoints: Object.freeze([]), ports: Object.freeze([]), overwritePaths: Object.freeze([]),
  errorMode: 'STOP', retryMode: 'NONE', disabledMode: 'SKIP', provenance: Object.freeze({ sourceUrl: 'https://example.test/review', sourceDigest: 'a'.repeat(64), reviewedAt: '2026-09-08', reviewer: 'test' }),
});
const seedFact: TaintFactV2 = Object.freeze({ key: Object.freeze({ node: 0, field: '/payload', port: 0, item: 0 }), confidentiality: createConfidentialityState(['WEBHOOK_BODY']), integrity: createIntegrityState(['INBOUND_MESSAGE']), trace: Object.freeze([]) });

function definition(identity: string, nodes: readonly unknown[], records: readonly [string, ResolvedNodeSemanticsV2][]): SubworkflowDefinitionV2 {
  return { identity, workflow: workflow(nodes), semantics: new Map(records) };
}

describe('bounded subworkflow semantic resolution', () => {
  it('returns unknown for a missing literal subworkflow without guessing host input', () => {
    const invoke = node(0, 'n8n-nodes-base.executeWorkflow', [{ pointer: '/nodes/0/parameters/workflowId', occurrences: [], value: 'missing', classification: 'PLAIN' }] as never);
    const result = resolveSubworkflowSemantics({ workflow: workflow([invoke]), semantics: new Map([['node-0', semantics('n8n-nodes-base.executeWorkflow', ['START_SUBWORKFLOW'])]]), incoming: [seedFact] });
    expect(result.status).toBe('UNKNOWN');
    expect(result.events).toMatchObject([{ kind: 'MISSING', identity: 'missing' }]);
    expect(result.facts[0]).toMatchObject({ confidentiality: { unknown: true }, integrity: { unknown: true } });
  });

  it('traverses a present child once and records visited identities deterministically', () => {
    const invoke = node(0, 'n8n-nodes-base.executeWorkflow', [{ pointer: '/nodes/0/parameters/workflowId', occurrences: [], value: 'child', classification: 'PLAIN' }] as never);
    const child = definition('child', [node(0, 'n8n-nodes-base.executeWorkflowTrigger')], [['node-0', semantics('n8n-nodes-base.executeWorkflowTrigger', [], 'SUBWORKFLOW')]]);
    const result = resolveSubworkflowSemantics({ workflow: workflow([invoke]), semantics: new Map([['node-0', semantics('n8n-nodes-base.executeWorkflow', ['START_SUBWORKFLOW'])]]), subworkflows: new Map([['child', child]]), incoming: [seedFact] });
    expect(result.status).toBe('COMPLETE');
    expect(result.visited).toEqual(['child']);
    expect(result.events).toMatchObject([{ kind: 'ENTER', identity: 'child' }, { kind: 'RETURN', identity: 'child' }]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('bounds recursive identities and work without executing child input', () => {
    const invoke = node(0, 'n8n-nodes-base.executeWorkflow', [{ pointer: '/nodes/0/parameters/workflowId', occurrences: [], value: 'loop', classification: 'PLAIN' }] as never);
    const loop = definition('loop', [node(0, 'n8n-nodes-base.executeWorkflow', [{ pointer: '/nodes/0/parameters/workflowId', occurrences: [], value: 'loop', classification: 'PLAIN' }] as never)], [['node-0', semantics('n8n-nodes-base.executeWorkflow', ['START_SUBWORKFLOW'])]]);
    const result = resolveSubworkflowSemantics({ workflow: workflow([invoke]), semantics: new Map([['node-0', semantics('n8n-nodes-base.executeWorkflow', ['START_SUBWORKFLOW'])]]), subworkflows: new Map([['loop', loop]]), incoming: [seedFact], maximumDepth: 2 });
    expect(result.status).toBe('UNKNOWN');
    expect(result.events.some((event) => event.kind === 'CYCLE')).toBe(true);
  });
  it.each([
    ['zero work budget', { maximum: 0 }],
    ['zero depth budget', { maximumDepth: 0 }],
  ])('returns no partial proof for %s', (_name, limits) => {
    const invoke = node(0, 'n8n-nodes-base.executeWorkflow', [{ pointer: '/nodes/0/parameters/workflowId', occurrences: [], value: 'child', classification: 'PLAIN' }] as never);
    const child = definition('child', [node(0, 'n8n-nodes-base.executeWorkflowTrigger')], [['node-0', semantics('n8n-nodes-base.executeWorkflowTrigger', [], 'SUBWORKFLOW')]]);
    const result = resolveSubworkflowSemantics({ workflow: workflow([invoke]), semantics: new Map([['node-0', semantics('n8n-nodes-base.executeWorkflow', ['START_SUBWORKFLOW'])]]), subworkflows: new Map([['child', child]]), incoming: [seedFact], ...(limits as { maximum?: number; maximumDepth?: number }) });
    expect(result.status).toBe('LIMIT_EXCEEDED');
    expect(result.events).toEqual([]);
    expect(result.transfers).toEqual([]);
    expect(result.facts).toEqual([]);
    expect(result.visited).toEqual([]);
    expect(result.omitted).toBeGreaterThan(0);
  });

  it('propagates child exit facts to later parent nodes', () => {
    const invoke = node(0, 'n8n-nodes-base.executeWorkflow', [{ pointer: '/nodes/0/parameters/workflowId', occurrences: [], value: 'child', classification: 'PLAIN' }] as never);
    const sink = node(1, 'sink');
    const childTrigger = node(0, 'n8n-nodes-base.executeWorkflowTrigger');
    const childSemantics = semantics('n8n-nodes-base.executeWorkflowTrigger', [], 'SUBWORKFLOW');
    const source = Object.freeze({ ...childSemantics, endpoints: Object.freeze([{ path: '/childPayload', channel: 'DATA' as const, direction: 'SOURCE' as const, taint: 'CONFIDENTIALITY' as const }]) }) as ResolvedNodeSemanticsV2;
    const child = definition('child', [childTrigger], [['node-0', source]]);
    const sinkSemantics = Object.freeze({ ...semantics('sink'), endpoints: Object.freeze([{ path: '/childPayload', channel: 'DATA' as const, direction: 'SINK' as const, taint: 'CONFIDENTIALITY' as const }]) }) as ResolvedNodeSemanticsV2;
    const result = resolveSubworkflowSemantics({ workflow: workflow([invoke, sink]), semantics: new Map([['node-0', semantics('n8n-nodes-base.executeWorkflow', ['START_SUBWORKFLOW'])], ['node-1', sinkSemantics]]), subworkflows: new Map([['child', child]]), incoming: [seedFact] });
    expect(result.status).toBe('COMPLETE');
    expect(result.events).toContainEqual(expect.objectContaining({ kind: 'SINK', node: 1, field: '/childPayload' }));
  });


  it('does not treat dynamic workflow identifiers as resolved references', () => {
    const invoke = node(0, 'n8n-nodes-base.executeWorkflow', [{ pointer: '/nodes/0/parameters/workflowId', occurrences: [], value: '{{$json.workflowId}}', classification: 'EXPRESSION' }] as never);
    const result = resolveSubworkflowSemantics({ workflow: workflow([invoke]), semantics: new Map([['node-0', semantics('n8n-nodes-base.executeWorkflow', ['START_SUBWORKFLOW'])]]), subworkflows: new Map(), incoming: [seedFact] });
    expect(result.status).toBe('UNKNOWN');
    expect(result.events[0]?.kind).toBe('UNKNOWN');
  });
});
