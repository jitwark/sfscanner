import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { parseSourceDocument } from '../../source/source-parser';
import { normalizeSecurityWorkflow } from '../../workflow-v2/normalize-security-workflow';
import type { AnalyzerContextV2 } from '../../capabilities/scheduler';
import { createScanLocalTaint } from './scan-local-taint';
import { MAX_EXPRESSION_SEGMENT_BYTES } from './taint-expressions';
import { produceScanLocalTaintV1 } from './scan-local-producer';

const source = { id: 'source', name: 'Source', type: 'n8n-nodes-base.webhook', parameters: {} };
const command = (value: string) => ({ id: 'sink', name: 'Sink', type: 'n8n-nodes-base.executeCommand', parameters: { command: value } });
function contextFor(nodes: unknown[], connected = true): AnalyzerContextV2 {
  const text = JSON.stringify({ nodes, connections: connected ? { Source: { main: [[{ node: 'Sink', type: 'main', index: 0 }]] } } : {} });
  const parsed = parseSourceDocument(new TextEncoder().encode(text), DEFAULT_SCANNER_LIMITS_V2);
  if (!parsed.ok) throw new Error('source fixture failed');
  const normalized = normalizeSecurityWorkflow(parsed.document, DEFAULT_SCANNER_LIMITS_V2);
  if (!normalized.ok) throw new Error('workflow fixture failed');
  return {
    source: parsed.document, workflow: normalized.workflow, limits: DEFAULT_SCANNER_LIMITS_V2,
    target: { schemaVersion: 'scanner-target-v3', edition: 'COMMUNITY', deployment: 'SELF_HOSTED', role: 'OWNER', taskRunner: 'NATIVE', communityPackages: [], configuration: [], contextDigest: 'c'.repeat(64) },
    semantics: { id: 'semantics', version: '1', digest: 's'.repeat(64), resolvedNodeSemantics: new Map() },
    rules: { id: 'rules', version: '1', digest: 'r'.repeat(64), rules: new Map() }, priorOutcomes: new Map(),
  };
}

describe('real scan-local legacy producer', () => {
  it('retains supported source-to-command evidence and propagation', () => {
    const outcome = produceScanLocalTaintV1(contextFor([source, command('={{ $json.cmd }}')]));
    expect(outcome.status).toBe('COMPLETE');
    expect(outcome.findings).toEqual([expect.objectContaining({
      policyId: 'TAINTED_COMMAND', evidence: expect.objectContaining({ sourceNodeId: 'source', tracePath: ['source', 'sink'], taintLabels: expect.arrayContaining(['WEBHOOK_BODY']) }),
    })]);
    expect(outcome.propagation).toMatchObject({ limitExceeded: false, reachedFixedPoint: true });
  });

  it('marks real expression exhaustion LIMITED without discarding supported findings', () => {
    const oversized = `{{ ${'x'.repeat(MAX_EXPRESSION_SEGMENT_BYTES + 1)} }}`;
    const outcome = produceScanLocalTaintV1(contextFor([source, command(`={{ $json.cmd }} ${oversized}`)]));
    expect(outcome.status).toBe('LIMITED');
    expect(outcome.diagnostics).toContainEqual(expect.objectContaining({ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' }));
    expect(outcome.findings).toContainEqual(expect.objectContaining({ policyId: 'TAINTED_COMMAND' }));
  });

  it('retains unsupported-source diagnostics without inventing failure or taint', () => {
    const unreviewed = { ...source, type: 'n8n-nodes-base.unreviewedTrigger' };
    const outcome = produceScanLocalTaintV1(contextFor([unreviewed, command('={{ $json.cmd }}')]));
    expect(outcome.status).toBe('COMPLETE');
    expect(outcome.findings).toEqual([]);
    expect(outcome.diagnostics).toEqual([{ code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY', location: { path: '/nodes/0' } }]);
    expect(outcome.propagation).toBeUndefined();
  });

  it('shares real production within a scan but isolates a subsequent clean scan', () => {
    const context = contextFor([source, command('={{ $json.cmd }}')]);
    let calls = 0;
    const access = createScanLocalTaint(context, (value) => { calls += 1; return produceScanLocalTaintV1(value); });
    const first = access();
    const second = access();
    expect(first.findings).toContainEqual(expect.objectContaining({ policyId: 'TAINTED_COMMAND' }));
    expect(second.findings).toEqual(first.findings);
    expect(first.findings).not.toBe(second.findings);
    expect(calls).toBe(1);
    const clean = createScanLocalTaint(contextFor([source, command('echo fixed')]), produceScanLocalTaintV1)();
    expect(clean.status).toBe('COMPLETE');
    expect(clean.findings).toEqual([]);
    expect(second.findings).toContainEqual(expect.objectContaining({ policyId: 'TAINTED_COMMAND' }));
  });
});
