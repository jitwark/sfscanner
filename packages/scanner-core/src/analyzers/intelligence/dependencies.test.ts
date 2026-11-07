import { describe, expect, it } from 'vitest';
import type { ResolvedNodeSemanticsV2 } from '../../semantics/catalogue-schema';
import type { SecurityNodeV2, SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';
import { summarizeDependencies } from './dependencies';

const node = (ordinal: number, credentials: readonly unknown[] = [], parameters: Record<string, unknown> = {}): SecurityNodeV2 => ({
  ref: { ordinal, identityDigest: `n${ordinal}`, source: { pointer: `/nodes/${ordinal}` } as SecurityNodeV2['ref']['source'] },
  type: 'n8n-nodes-base.httpRequest', disabled: false, scoringEligibility: 'ELIGIBLE',
  parameters: Object.entries(parameters).map(([key, value], index) => ({ pointer: `/nodes/${ordinal}/parameters/${key}`, value, classification: 'PLAIN', occurrences: [{ pointer: `/nodes/${ordinal}`, occurrencePath: [index], astNodeId: 'a'.repeat(64), span: null }] })) as SecurityNodeV2['parameters'],
  credentials: credentials as SecurityNodeV2['credentials'], settings: [],
});
const semantics = (id: string, credentialPaths: readonly string[] = [], semanticId = id): ResolvedNodeSemanticsV2 => ({
  semanticId, nodeType: id, versionRange: { clauses: [] }, operation: null, entry: 'NONE', parameterPaths: [], authentication: null,
  credentialPaths, destinationPaths: [], effects: [], endpoints: [], ports: [], overwritePaths: [], errorMode: 'STOP', retryMode: 'NONE', disabledMode: 'SKIP',
  provenance: { sourceUrl: 'fixture', sourceDigest: 'a'.repeat(64), reviewedAt: '2026-10-17', reviewer: 'test' },
});
const workflow = (nodes: SecurityNodeV2[]): SecurityWorkflowV2 => ({ workflowFields: [], nodes, edges: [], ambiguities: [] });
const map = (...records: ResolvedNodeSemanticsV2[]) => new Map(records.map((record) => [`n${records.indexOf(record)}`, record]));

describe('Q06.3 dependency summary', () => {
  it('counts reviewed credential slots and configured references without publishing identifiers', () => {
    const result = summarizeDependencies({
      workflow: workflow([node(0, [{ pointer: '/nodes/0/credentials/httpRequestAuth' }])]),
      semantics: map(semantics('n8n-nodes-base.httpRequest', ['/credentials/httpRequestAuth'])),
    });
    expect(result).toMatchObject({
      totalNodes: 1, reviewedNodes: 1, assumedNodes: 0, unknownNodes: 0,
      credentialReferences: 1, requiredCredentialSlots: 1, configuredCredentialSlots: 1,
      missingCredentialSlots: 0, unknownCredentialSlots: 0,
    });
  });

  it('distinguishes missing and unknown credential slots', () => {
    const missing = summarizeDependencies({
      workflow: workflow([node(0)]),
      semantics: map(semantics('n8n-nodes-base.httpRequest', ['/credentials/httpRequestAuth'])),
    });
    expect(missing).toMatchObject({ requiredCredentialSlots: 1, configuredCredentialSlots: 0, missingCredentialSlots: 1 });

    const unknown = summarizeDependencies({
      workflow: workflow([node(0, [{ pointer: '/nodes/0/credentials' }])]),
      semantics: map(semantics('n8n-nodes-base.httpRequest', ['/credentials'])),
    });
    expect(unknown).toMatchObject({ requiredCredentialSlots: 1, configuredCredentialSlots: 0, unknownCredentialSlots: 1 });
  });

  it('counts environment references and redacts sensitive identifiers', () => {
    const result = summarizeDependencies({
      workflow: workflow([node(0, [], { a: '={{ $env.API_URL }}', b: "={{ $env['API_URL'] }}", c: '={{ $env.sk_live_token }}', d: '$env.API_KEY' })]),
      semantics: map(semantics('n8n-nodes-base.httpRequest')),
    });
        expect(result).toMatchObject({ environmentReferences: 3, redactedIdentifiers: 1 });
    expect(JSON.stringify(result)).not.toContain('sk_live_token');
    expect(JSON.stringify(result)).not.toContain('API_URL');
  });

  it('separates reviewed, assumed and unknown nodes and ignores target context', () => {
    const result = summarizeDependencies({
      workflow: workflow([node(0), node(1), node(2)]),
      semantics: new Map([
        ['n0', semantics('n8n-nodes-base.httpRequest', [], 'generic.fallback')],
        ['n1', semantics('n8n-nodes-base.httpRequest')],
      ]),
    });
    expect(result).toMatchObject({ totalNodes: 3, reviewedNodes: 1, assumedNodes: 1, unknownNodes: 1 });
  });
});
