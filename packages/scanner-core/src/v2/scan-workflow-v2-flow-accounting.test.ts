import { describe, expect, it, vi } from 'vitest';
import { scanWorkflowV2 } from './index';
import * as runner from '../analyzers/taint/scan-local-traces';

const profile = { id: 'beta-default', version: '2.0.0' } as const;
const workflow = {
  nodes: [
    { id: 'source', name: 'Source', type: 'n8n-nodes-base.webhook', typeVersion: 1,
      position: [100, 200], parameters: { httpMethod: 'POST', path: 'in' } },
    { id: 'sink', name: 'Sink', type: 'n8n-nodes-base.executeCommand', typeVersion: 1,
      position: [300, 200], parameters: { command: '={{ $json.body.cmd }}' } },
  ],
  connections: { Source: { main: [[{ node: 'Sink', type: 'main', index: 0 }]] } },
};
const scan = (value: unknown, maxGraphOperations: number) => scanWorkflowV2({
  bytes: new TextEncoder().encode(JSON.stringify(value)), profile, limits: { maxGraphOperations },
});

describe('public flow accounting', () => {
  it('reports a nonempty graph that cannot be analyzed with zero graph budget', () => {
    const result = scan(workflow, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.result.analysis.status).toBe('INDETERMINATE');
    const diagnostic = result.result.analysis.diagnostics.find((d) => d.code === 'GRAPH_ANALYSIS_DEGRADED');
    expect(diagnostic?.omitted).toBeGreaterThan(0);
    expect(diagnostic).not.toHaveProperty('observed');
    const owner = result.result.analysis.capabilities.find((capability) => capability.id === 'structural-policies');
    expect(owner?.required).toBe(true);
    expect(owner?.omitted).toBe(diagnostic?.omitted);
    expect(result.result.stats.omittedFindings).toBe(0);
  });

  it('requires no graph work for an empty workflow at zero budget', () => {
    const result = scan({ nodes: [], connections: {} }, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.result.analysis.status).toBe('COMPLETE');
    expect(result.result.analysis.diagnostics.some((d) => d.code === 'GRAPH_ANALYSIS_DEGRADED')).toBe(false);
    expect(result.result.stats.omittedFindings).toBe(0);
  });

  it('reports a refused positive debit even when the graph budget is not exhausted', () => {
    const spy = vi.spyOn(runner, 'runScanLocalWithWitnesses');
    try {
      // The catalog-based pair search now prepays a 32-unit node/type lookup allowance before the runner.
      const result = scan(workflow, 128);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.results[0]?.value.analysis.status).toBe('LIMITED');
      expect(result.result.analysis.status).toBe('INDETERMINATE');
      const diagnostic = result.result.analysis.diagnostics.find((d) => d.code === 'GRAPH_ANALYSIS_DEGRADED');
      expect(diagnostic?.omitted).toBeGreaterThan(0);
      expect(diagnostic).not.toHaveProperty('observed');
      const owner = result.result.analysis.capabilities.find((capability) => capability.id === 'structural-policies');
      expect(owner?.required).toBe(true);
      expect(owner?.omitted).toBe(diagnostic?.omitted);
      expect(result.result.stats.omittedFindings).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it('retains the real positive witness with no unavailable evidence at standard budget', () => {
    const spy = vi.spyOn(runner, 'runScanLocalWithWitnesses');
    try {
      const result = scan(workflow, 100_000);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);
      const internal = spy.mock.results[0]?.value;
      expect(internal.witnessUnavailable).toBe(0);
      expect(internal.omittedTraceSteps).toBe(0);
      expect(result.result.facts.some((f) => f.kind === 'dataflow.summary.v3')).toBe(true);
      expect(result.result.analysis.status).toBe('COMPLETE');
      expect(result.result.analysis.diagnostics.some((d) => d.code === 'GRAPH_ANALYSIS_DEGRADED')).toBe(false);
      const owner = result.result.analysis.capabilities.find((capability) => capability.id === 'structural-policies');
      expect(owner?.required).toBe(true);
      expect(owner?.omitted).toBe(0);
      expect(result.result.stats.omittedFindings).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it('publishes an applicable UNKNOWN as zero-omission DEGRADED accounting', () => {
    const literal = {
      ...workflow,
      nodes: [workflow.nodes[0], { ...workflow.nodes[1], parameters: { command: 'echo fixed' } }],
    };
    const spy = vi.spyOn(runner, 'runScanLocalWithWitnesses');
    try {
      const result = scan(literal, 100_000);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);
      expect(spy).not.toHaveBeenCalled();
      expect(result.result.analysis.status).toBe('DEGRADED');
      expect(result.result.facts.some((fact) => fact.kind.startsWith('dataflow.'))).toBe(false);
      expect(result.result.traces).toEqual([]);
      const diagnostic = result.result.analysis.diagnostics.find((item) => item.code === 'GRAPH_ANALYSIS_DEGRADED');
      expect(diagnostic).toMatchObject({ capabilityId: 'structural-policies', aggregateEffect: 'DEGRADED',
        assessmentEligible: true, observed: 1, omitted: 0 });
      expect(diagnostic).not.toHaveProperty('maximum');
      const owner = result.result.analysis.capabilities.find((capability) => capability.id === 'structural-policies');
      expect(owner).toMatchObject({ required: true, omitted: 0 });
      expect(result.result.stats.omittedFindings).toBe(0);
    } finally { spy.mockRestore(); }
  });
});
