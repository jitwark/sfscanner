import { describe, expect, it } from 'vitest';
import { scanWorkflowV2 } from './index';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { measureFlowScan, reviewedCommandFlow } from './core-repair-flow.test-support';

const bytes = (value: string) => new TextEncoder().encode(value);
const profile = { id: 'beta-default', version: '2.0.0' } as const;

describe('C02 flow-witness scanner integration', () => {
  it('publishes paid zero-flow coverage without inventing a ManualTrigger/Code flow', () => {
    const workflow = {
      nodes: [
        { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [100, 200], parameters: {} },
        { id: 'code', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 1, position: [300, 200], parameters: { jsCode: 'return $input.all();' } },
      ],
      connections: {
        Start: { main: [[{ node: 'Code', type: 'main', index: 0 }]] },
      },
    };

    const result = scanWorkflowV2({ bytes: bytes(JSON.stringify(workflow)), profile });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.result.analysis.status).toBe('COMPLETE');
    expect(result.result.facts.filter((f) => f.kind === 'dataflow.summary.v3' || f.kind === 'dataflow.provenance.v1')).toEqual([]);
    const coverage = result.result.facts.filter((f) => f.kind === 'dataflow.coverage.v1');
    expect(coverage).toHaveLength(1);
    expect(coverage[0].properties).toMatchObject({ coverageStatus: 'COMPLETE', fieldsExamined: 0, emittedFlows: 0 });
    expect(result.result.traces).toEqual([]);
  });

  it('scans an unknown node type and degrades gracefully with SEMANTIC_CATALOGUE_MISS', () => {
    const workflow = {
      nodes: [
        { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [100, 200], parameters: {} },
        { id: 'custom', name: 'Custom Node', type: 'custom.unmodeled.plugin', typeVersion: 1, position: [300, 200], parameters: {} },
      ],
      connections: {
        Start: { main: [[{ node: 'Custom Node', type: 'main', index: 0 }]] },
      },
    };

    const result = scanWorkflowV2({ bytes: bytes(JSON.stringify(workflow)), profile });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Unknown node type causes degraded analysis
    expect(result.result.analysis.status).toBe('DEGRADED');
    expect(result.result.analysis.diagnostics.some((d) => d.code === 'SEMANTIC_CATALOGUE_MISS')).toBe(true);
  });

  it('scans identically regardless of node renaming when types and topology match', () => {
    const wf1 = {
      nodes: [
        { id: 'n1', name: 'TriggerNode', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [100, 200], parameters: {} },
        { id: 'n2', name: 'ExecuteNode', type: 'n8n-nodes-base.code', typeVersion: 1, position: [300, 200], parameters: { jsCode: 'return 1;' } },
      ],
      connections: {
        TriggerNode: { main: [[{ node: 'ExecuteNode', type: 'main', index: 0 }]] },
      },
    };

    const wf2 = {
      nodes: [
        { id: 'n1', name: 'RenamedTrigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [100, 200], parameters: {} },
        { id: 'n2', name: 'RenamedCode', type: 'n8n-nodes-base.code', typeVersion: 1, position: [300, 200], parameters: { jsCode: 'return 1;' } },
      ],
      connections: {
        RenamedTrigger: { main: [[{ node: 'RenamedCode', type: 'main', index: 0 }]] },
      },
    };

    const r1 = scanWorkflowV2({ bytes: bytes(JSON.stringify(wf1)), profile });
    const r2 = scanWorkflowV2({ bytes: bytes(JSON.stringify(wf2)), profile });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    expect(r1.result.analysis.status).toBe(r2.result.analysis.status);
    expect(r1.result.assessment?.score).toBe(r2.result.assessment?.score);
    expect(r1.result.assessment?.grade).toBe(r2.result.assessment?.grade);
    expect([...r1.result.facts.map((f) => f.kind)].sort()).toEqual([...r2.result.facts.map((f) => f.kind)].sort());
  });

  it('marks analysis limited when operations limit is exceeded', () => {
    const workflow = {
      nodes: [
        { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [100, 200], parameters: {} },
        { id: 'code', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 1, position: [300, 200], parameters: { jsCode: 'return 1;' } },
      ],
      connections: {
        Start: { main: [[{ node: 'Code', type: 'main', index: 0 }]] },
      },
    };

    const strictLimits = {
      ...DEFAULT_SCANNER_LIMITS_V2,
      maxGraphOperations: 1,
      maxTaintStates: 1,
    };

    const result = scanWorkflowV2({ bytes: bytes(JSON.stringify(workflow)), profile, limits: strictLimits });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.result.analysis.status).toBe('INDETERMINATE');
    expect(result.result.analysis.diagnostics.find((d) => d.code === 'GRAPH_ANALYSIS_DEGRADED')?.omitted).toBeGreaterThan(0);
  });

  it('refuses with WORKFLOW_TOO_COMPLEX and SERIALIZED_RESULT_LIMIT when result exceeds maxSerializedResultBytes', () => {
    const workflow = {
      nodes: [
        { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [100, 200], parameters: {} },
        { id: 'code', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 1, position: [300, 200], parameters: { jsCode: 'return 1;' } },
      ],
      connections: {
        Start: { main: [[{ node: 'Code', type: 'main', index: 0 }]] },
      },
    };

    const result = scanWorkflowV2({
      bytes: bytes(JSON.stringify(workflow)),
      profile,
      limits: {
        ...DEFAULT_SCANNER_LIMITS_V2,
        maxSerializedResultBytes: 10,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('WORKFLOW_TOO_COMPLEX');
    expect(result.cause).toBe('SERIALIZED_RESULT_LIMIT');
  });

  it('bounds aggregate graph operations across multiple triggers and marks required omission indeterminate', () => {
    const singleTriggerWorkflow = {
      nodes: [
        { id: 'start1', name: 'Start1', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [100, 100], parameters: {} },
        { id: 'set', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 1, position: [300, 200], parameters: {} },
      ],
      connections: {
        Start1: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
      },
    };
    const twoTriggerWorkflow = {
      nodes: [
        { id: 'start1', name: 'Start1', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [100, 100], parameters: {} },
        { id: 'start2', name: 'Start2', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [100, 300], parameters: {} },
        { id: 'set', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 1, position: [300, 200], parameters: {} },
      ],
      connections: {
        Start1: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
        Start2: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
      },
    };

    const single = measureFlowScan(singleTriggerWorkflow);
    const two = measureFlowScan(twoTriggerWorkflow);
    expect(single.result.analysis.status).toBe('COMPLETE');
    expect(two.result.analysis.status).toBe('COMPLETE');
    expect(two.used).toBeGreaterThan(single.used);
    const singleAtCap = measureFlowScan(singleTriggerWorkflow, single.used);
    expect(singleAtCap.result.analysis.status).toBe('COMPLETE');
    expect(singleAtCap.used).toBe(single.used);
    const refused = measureFlowScan(twoTriggerWorkflow, single.used);
    expect(refused.used).toBeLessThanOrEqual(single.used);
    expect(refused.events.some((event) => !event.accepted)).toBe(true);
    expect(refused.result.analysis.status).toBe('INDETERMINATE');
    expect(refused.result.analysis.diagnostics.find((d) => d.code === 'GRAPH_ANALYSIS_DEGRADED')?.omitted).toBeGreaterThan(0);
    expect(refused.result.facts.filter((f) => f.kind === 'dataflow.coverage.v1')).toEqual([]);
  });

  it('refuses small preflight budgets (5, 6, 7) without invariant failure or phantom flow facts', () => {
    const triggerToCodeWorkflow = {
      nodes: [
        { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [100, 100], parameters: {} },
        { id: 'code', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 1, position: [300, 200], parameters: { jsCode: 'return $input.all();' } },
      ],
      connections: { Start: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
    };

    for (const budget of [5, 6, 7]) {
      const result = scanWorkflowV2({
        bytes: bytes(JSON.stringify(triggerToCodeWorkflow)),
        profile,
        limits: { ...DEFAULT_SCANNER_LIMITS_V2, maxGraphOperations: budget },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.result.analysis.status).toBe('INDETERMINATE');
      expect(result.result.analysis.diagnostics.find((d) => d.code === 'GRAPH_ANALYSIS_DEGRADED')?.omitted).toBeGreaterThan(0);
      expect(result.result.assessment).toBeNull();
      expect(result.result.facts.filter((fact) => fact.kind.startsWith('dataflow.'))).toEqual([]);
    }
  });

  it('pins the measured shared boundary for the actual reviewed Webhook/command producer', () => {
    const measured = measureFlowScan(reviewedCommandFlow);
    expect(measured.result.analysis.status).toBe('COMPLETE');
    expect(measured.used).toBe(53_536);
    expect(measured.events.every((event) => event.accepted)).toBe(true);
    expect([...new Set(measured.events.map((event) => event.phase))].sort())
      .toEqual(['DERIVATION', 'MODEL', 'PUBLICATION', 'RUNNER']);
    expect(measured.result.facts.filter((fact) => fact.kind === 'dataflow.summary.v3')).toHaveLength(1);
    expect(measured.result.facts.filter((fact) => fact.kind === 'dataflow.provenance.v1')).toHaveLength(1);
    expect(measured.result.facts.filter((fact) => fact.kind === 'dataflow.coverage.v1')).toHaveLength(1);
    expect(measured.result.traces.filter((trace) => trace.kind === 'CONFIDENTIALITY')).toHaveLength(1);
    const unobserved = scanWorkflowV2({ bytes: bytes(JSON.stringify(reviewedCommandFlow)), profile,
      limits: { maxGraphOperations: 100_000 } });
    expect(unobserved.ok).toBe(true);
    if (!unobserved.ok) throw new Error(unobserved.code);
    expect(measured.result).toEqual(unobserved.result);
    expect(Object.fromEntries(['MODEL', 'RUNNER', 'DERIVATION', 'PUBLICATION'].map((phase) =>
      [phase, measured.events.filter((event) => event.phase === phase).reduce((sum, event) => sum + event.units, 0)])))
      .toEqual({ MODEL: 113, RUNNER: 27_234, DERIVATION: 10_531, PUBLICATION: 15_658 });
    const exact = measureFlowScan(reviewedCommandFlow, measured.used);
    expect(exact.used).toBe(measured.used);
    expect(exact.result.analysis.status).toBe('COMPLETE');
    expect(exact.result.facts).toEqual(measured.result.facts);
    expect(exact.result.traces).toEqual(measured.result.traces);
    const spare = measureFlowScan(reviewedCommandFlow, measured.used + 1);
    expect(spare.result.analysis.status).toBe('COMPLETE');
    expect(spare.used).toBe(measured.used);
    const below = measureFlowScan(reviewedCommandFlow, measured.used - 1);
    expect(below.used).toBeLessThanOrEqual(measured.used - 1);
    expect(below.events.find((event) => !event.accepted)?.phase).toBe('PUBLICATION');
    expect(below.events.slice(below.events.findIndex((event) => !event.accepted)).every((event) => !event.accepted)).toBe(true);
    expect(below.result.analysis.status).toBe('INDETERMINATE');
    expect(below.result.assessment).toBeNull();
    expect(below.result.facts.filter((fact) => fact.kind === 'dataflow.coverage.v1')).toEqual([]);
  });
});
