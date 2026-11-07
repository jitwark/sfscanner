import { describe, expect, it } from 'vitest';
import { scanWorkflowV2 } from './scan-workflow';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from '../semantics/builtin-catalogue';
import { resolveNodeSemantics } from '../semantics/catalogue-resolver';
import { parseSourceDocument } from '../source/source-parser';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import type { SecurityNodeV2 } from '../workflow-v2/security-workflow';

/**
 * Packet B2 (INDEPENDENT-REVIEW R03). `n8n-nodes-base.noOp` is a pure passthrough, so a workflow
 * that wires a manual trigger into it must not raise `SEMANTIC_CATALOGUE_MISS` for a node that only
 * forwards its input.
 *
 * `workflow-v2/node-normalization.ts` canonicalizes numeric and decimal-string `typeVersion` forms
 * before semantic resolution. Malformed strings fail admission; a syntactically valid prerelease
 * without an exact catalogue record remains unbound and degrades the scan.
 */

type Node = Record<string, unknown>;
const encoder = new TextEncoder();
const PROFILE = { id: 'beta-default', version: '2.0.0' } as const;
const START: Node = { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} };
const finish = (overrides: Node = {}): Node => ({ id: 'finish', name: 'Finish', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {}, ...overrides });
const source = (nodes: readonly Node[]) => JSON.stringify({ nodes, connections: { Start: { main: [[{ node: 'Finish', type: 'main', index: 0 }]] } } });

const analysisOf = (workflow: string) => {
  const result = scanWorkflowV2({ bytes: encoder.encode(workflow), profile: PROFILE });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`scan failed: ${result.code}`);
  return result.result.analysis;
};

const nodesOf = (workflow: string): readonly SecurityNodeV2[] => {
  const parsed = parseSourceDocument(encoder.encode(workflow));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(`fixture failed to parse: ${parsed.code}`);
  const normalized = normalizeSecurityWorkflow(parsed.document);
  expect(normalized.ok).toBe(true);
  if (!normalized.ok) throw new Error(`fixture failed to normalize: ${normalized.code}`);
  return normalized.workflow.nodes;
};

/** Replays the resolver call `v2/scan-workflow.ts` makes per node, on the pipeline's own normalization output. */
const semanticsFor = (node: SecurityNodeV2 | undefined) => {
  if (node === undefined) throw new Error('fixture node is missing');
  const operation = node.parameters.find((field) => field.pointer.endsWith('/operation'))?.value;
  return resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, { nodeType: node.type, version: node.typeVersion ?? '1.0.0', operation: typeof operation === 'string' ? operation : null });
};

describe('noOp passthrough semantics through the v2 pipeline', () => {
  it('scans a manualTrigger -> noOp fixture with no miss and complete coverage', () => {
    const analysis = analysisOf(source([START, finish()]));
    expect(analysis.diagnostics.filter(({ code }) => code === 'SEMANTIC_CATALOGUE_MISS')).toEqual([]);
    expect(analysis.status).toBe('COMPLETE');
    expect(analysis.capabilities.find(({ id }) => id === 'structural-policies')).toMatchObject({ status: 'COMPLETED', seen: 2, analyzed: 2, skipped: 0, omitted: 0 });
    expect(semanticsFor(nodesOf(source([START, finish()]))[1])?.semanticId).toBe('noop.passthrough');
  });

  it('normalizes numeric typeVersions to the strict versions the resolver receives', () => {
    const nodes = nodesOf(source([START, finish({ typeVersion: 1.5 })]));
    expect(nodes.map((node) => node.typeVersion)).toEqual(['1.0.0', '1.5.0']);
    expect(semanticsFor(nodes[0])?.semanticId).toBe('ingress.manual-trigger');
    expect(semanticsFor(nodes[1])).toBeNull();
  });

  it('covers a noOp outside the pinned exact version with the degraded fallback advisory', () => {
    const workflow = source([START, finish({ typeVersion: 2 })]);
    const analysis = analysisOf(workflow);
    const advisory = analysis.diagnostics.filter(({ code }) => code === 'SEMANTIC_CATALOGUE_MISS');
    expect(advisory).toHaveLength(1);
    expect(advisory[0]).toMatchObject({ aggregateEffect: 'DEGRADED', assessmentEligible: true, location: { pointer: '/nodes/1' } });
    expect(analysis.status).not.toBe('INDETERMINATE');
    // The admitted catalogue still holds no wildcard record: the fallback is synthesised at the
    // resolution seam, so the pinned catalogue digest does not move.
    expect(semanticsFor(nodesOf(workflow)[1])).toBeNull();
  });

  it('reports one degraded coverage advisory for an arbitrary unknown node type', () => {
    const unknown = analysisOf(source([START, finish({ type: 'n8n-nodes-base.notARealNode' })])).diagnostics.filter(({ code }) => code === 'SEMANTIC_CATALOGUE_MISS');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ aggregateEffect: 'DEGRADED', assessmentEligible: true, location: { pointer: '/nodes/1' } });
  });

  it('binds equivalent accepted typeVersion strings to identical semantics through the full scan', () => {
    const workflows = ['1', '1.0', '1.0.0'].map((typeVersion) => source([START, finish({ typeVersion })]));
    const analyses = workflows.map(analysisOf);
    const bindings = workflows.map((workflow) => semanticsFor(nodesOf(workflow)[1]));
    expect(analyses[0]?.status).toBe('COMPLETE');
    expect(analyses[0]?.diagnostics.filter(({ code }) => code === 'SEMANTIC_CATALOGUE_MISS')).toEqual([]);
    for (const analysis of analyses.slice(1)) expect(analysis).toEqual(analyses[0]);
    for (const binding of bindings.slice(1)) expect(binding).toEqual(bindings[0]);
    expect(bindings[0]).toMatchObject({ semanticId: 'noop.passthrough', errorMode: 'UNKNOWN', retryMode: 'UNKNOWN', disabledMode: 'SKIP' });
  });

  it.each(['01', '1.01'])('fails closed for malformed typeVersion string %s', (typeVersion) => {
    const rejected = scanWorkflowV2({ bytes: encoder.encode(source([START, finish({ typeVersion })])), profile: PROFILE });
    expect(rejected).toMatchObject({ ok: false, code: 'SEMANTIC_CATALOGUE_INVALID' });
  });

  it('does not bind an unadmitted prerelease typeVersion to noOp semantics', () => {
    const workflow = source([START, finish({ typeVersion: '1.0.0-alpha' })]);
    const analysis = analysisOf(workflow);
    expect(analysis.status).toBe('DEGRADED');
    expect(analysis.diagnostics.map(({ code }) => code)).toContain('SEMANTIC_CATALOGUE_MISS');
    expect(semanticsFor(nodesOf(workflow)[1])).toBeNull();
  });

  it('keeps the existing normalization semantics for disabled, retry, and error overrides', () => {
    const overrides: Node = { disabled: true, retryOnFail: true, maxTries: 3, waitBetweenTries: 0, onError: 'continueRegularOutput' };
    const workflow = source([START, finish(overrides)]);
    const node = nodesOf(workflow)[1];
    expect(node?.disabled).toBe(true);
    expect(node?.settings.map(({ pointer }) => pointer)).toEqual(expect.arrayContaining(['/nodes/1/retryOnFail', '/nodes/1/maxTries', '/nodes/1/onError']));
    // Node-level overrides are settings, not semantics: the record keeps its own modes and still resolves.
    expect([semanticsFor(node)?.semanticId, semanticsFor(node)?.errorMode, semanticsFor(node)?.retryMode, semanticsFor(node)?.disabledMode]).toEqual(['noop.passthrough', 'UNKNOWN', 'UNKNOWN', 'SKIP']);
    expect(analysisOf(workflow).diagnostics.filter(({ code }) => code === 'SEMANTIC_CATALOGUE_MISS')).toEqual([]);
  });
});
