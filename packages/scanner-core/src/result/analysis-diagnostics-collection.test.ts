import { describe, expect, it } from 'vitest';
import { parseWorkflowJson, type NormalizedWorkflow } from '../workflow';
import { collectAnalysisDiagnostics } from './analysis-diagnostics-collection';

function baseInput(workflow: NormalizedWorkflow) {
  return {
    workflow,
    analyzerDiagnostics: [],
    spanUnresolvedCount: 0,
    policyRejectedCount: 0,
    policyFailedCount: 0,
    findingCollapsedCount: 0,
    scanCapExceeded: false,
  };
}

function workflowWith(connections: Record<string, unknown>): NormalizedWorkflow {
  const parsed = parseWorkflowJson(JSON.stringify({
    nodes: [{ name: 'Source', type: 'n8n-nodes-base.webhook' }, { name: 'Target', type: 'n8n-nodes-base.noOp' }],
    connections,
  }));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.workflow;
}

describe('collectAnalysisDiagnostics — malformed connection index', () => {
  it('emits no diagnostic for a well-formed graph', () => {
    const workflow = workflowWith({ Source: { main: [[{ node: 'Target', type: 'main', index: 0 }]] } });
    expect(collectAnalysisDiagnostics(baseInput(workflow))).toEqual([]);
  });

  it('surfaces a source-located MALFORMED_CONNECTION_INDEX diagnostic for a malformed index', () => {
    const workflow = workflowWith({ Source: { main: [[{ node: 'Target', type: 'main', index: -1 }]] } });
    const diagnostics = collectAnalysisDiagnostics(baseInput(workflow));

    expect(diagnostics).toContainEqual({
      code: 'MALFORMED_CONNECTION_INDEX',
      category: 'GRAPH',
      location: { path: '/connections/Source/main/0/0/index' },
    });
    // The generic graph-degradation signal still fires alongside the specific one.
    expect(diagnostics).toContainEqual({ code: 'GRAPH_ANALYSIS_DEGRADED', category: 'GRAPH' });
  });

  it('does not echo the offending value, only its location', () => {
    const workflow = workflowWith({ Source: { main: [[{ node: 'Target', type: 'main', index: 'sk_live_secretvalue123' }]] } });
    const diagnostics = collectAnalysisDiagnostics(baseInput(workflow));
    expect(JSON.stringify(diagnostics)).not.toContain('sk_live_secretvalue123');
  });
});
