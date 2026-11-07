import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import type { ScanFinding } from '../policy/policy';
import { parseSourceDocument } from '../source/source-parser';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import { candidateTrace } from './candidate-trace';
import type { AnalyzerContextV2 } from './scheduler';

const encoder = new TextEncoder();
function context(sinkName = 'Sink'): AnalyzerContextV2 {
  const parsed = parseSourceDocument(encoder.encode(JSON.stringify({
    nodes: [
      { id: 'source', name: 'Source', type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: {} },
      { id: 'sink', name: sinkName, type: 'n8n-nodes-base.executeCommand', typeVersion: 1, parameters: { command: 'echo' } },
    ],
    connections: { Source: { main: [[{ node: 'Sink', type: 'main', index: 0 }]] } },
  })), DEFAULT_SCANNER_LIMITS_V2);
  if (!parsed.ok) throw new Error('source fixture failed');
  const normalized = normalizeSecurityWorkflow(parsed.document, DEFAULT_SCANNER_LIMITS_V2);
  if (!normalized.ok) throw new Error('workflow fixture failed');
  return { workflow: normalized.workflow } as AnalyzerContextV2;
}

const finding = (tracePath: unknown): ScanFinding => ({
  location: { nodeId: 'sink', nodeName: 'Sink' },
  evidence: { tracePath },
} as unknown as ScanFinding);

describe('candidate trace projection', () => {
  it('publishes a deterministic source-to-sink witness with admitted node subjects', () => {
    const value = context();
    const facts = ['a'.repeat(64)];
    const first = candidateTrace(finding(['source', 'sink']), value, facts);
    const second = candidateTrace(finding(['source', 'sink']), value, facts);
    expect(first).toBeDefined();
    expect(second).toEqual(first);
    expect(first!.traceId).toMatch(/^[0-9a-f]{64}$/);
    expect(first!.steps.map(({ kind }) => kind)).toEqual(['SOURCE', 'SINK']);
    expect(first!.steps.map(({ subject }) => subject.kind)).toEqual(['NODE', 'NODE']);
    for (const step of first!.steps) {
      if (step.subject.kind === 'NODE') {
        expect(step.subject.node).not.toHaveProperty('name');
        expect(step.subject.node).not.toHaveProperty('explicitId');
      }
    }
    expect(candidateTrace(finding(['source', 'sink']), value, facts, 1)).toBeUndefined();
    expect(candidateTrace(finding(['source', 'sink']), value, facts, 0)).toBeUndefined();
    expect(first!.steps[0]!.factRefs).toEqual(facts);
    expect(first!.steps[1]!.factRefs).toEqual(facts);
  });

  it('keeps witness identity stable when source-span retention changes', () => {
    const retained = context();
    const dropped = {
      ...retained,
      workflow: {
        ...retained.workflow,
        nodes: retained.workflow.nodes.map((node) => ({ ...node, ref: { ...node.ref, source: { ...node.ref.source, span: null } } })),
      },
    };
    const facts = ['a'.repeat(64)];
    const first = candidateTrace(finding(['source', 'sink']), retained, facts)!;
    const second = candidateTrace(finding(['source', 'sink']), dropped, facts)!;
    expect(first.steps[0].subject.kind === 'NODE' && first.steps[0].subject.node.source.span).not.toBeNull();
    expect(second.steps[0].subject.kind === 'NODE' && second.steps[0].subject.node.source.span).toBeNull();
    expect(second.traceId).toBe(first.traceId);
  });

  it('returns no trace for an unresolved path or absent fact references', () => {
    const value = context();
    expect(candidateTrace(finding(['source']), value, ['a'.repeat(64)])).toBeUndefined();
    expect(candidateTrace(finding(['source', 'missing']), value, ['a'.repeat(64)])).toBeUndefined();
    expect(candidateTrace(finding(['source', 'sink']), value, [])).toBeUndefined();
    expect(candidateTrace(finding('not-a-path'), value, ['a'.repeat(64)])).toBeUndefined();
    expect(candidateTrace(finding(['source', 'sink']), context('source'), ['a'.repeat(64)])).toBeUndefined();
  });
});
