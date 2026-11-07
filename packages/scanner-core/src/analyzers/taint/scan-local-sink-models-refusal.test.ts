import { describe, expect, it } from 'vitest';
import { TAINTED_RULE_SINK_CLASSES_V1 } from '../../facts/safe-fact-registry';
import { TAINT_SINK_CATALOG } from './taint-sink-catalog';
import { compileScanLocalWorkflowFlowModelV1 } from './scan-local-workflow-flow-model';
import { compileFixture, dormantScan, publicScan, variants, workflowFor } from './scan-local-sink-models-test-support';

function unknownWorkflow(type: string, parameters: Record<string, unknown>, version = 1) {
  const workflow = workflowFor(variants[0]);
  workflow.nodes[1] = { ...workflow.nodes[1]!, type, parameters, typeVersion: version };
  return workflow;
}

const unsupported = [
  { sink: 'CODE', type: 'n8n-nodes-base.code', parameters: { jsCode: '={{ $json.body.cmd }}' } },
  { sink: 'HEADER', type: 'n8n-nodes-base.httpRequest', version: 4.2,
    parameters: { url: 'https://example.invalid', sendHeaders: true,
      headerParameters: { parameters: [{ name: 'x-input', value: '={{ $json.body.cmd }}' }] } } },
  { sink: 'PROMPT', type: '@n8n/n8n-nodes-langchain.agent', parameters: { text: '={{ $json.body.cmd }}' } },
] as const;

describe('catalogued sinks without reviewed terminal models', () => {
  it('keeps every existing class and rule mapping observable', () => {
    const observed = new Set([...variants.map((variant) => variant.sinkClass), ...unsupported.map((item) => item.sink)]);
    expect([...observed].sort()).toEqual([...new Set(TAINT_SINK_CATALOG.map((entry) => entry.sink))].sort());
    expect([...observed].sort()).toEqual(Object.values(TAINTED_RULE_SINK_CLASSES_V1).sort());
  });

  it.each(unsupported)('$sink is UNKNOWN in the actual model, public result and dormant candidate', (item) => {
    const workflow = unknownWorkflow(item.type, item.parameters, 'version' in item ? item.version : 1);
    const compiled = compileFixture(workflow);
    expect(compiled.model).toEqual({ status: 'UNKNOWN', reason: 'NO_REVIEWED_SINK_MODEL' });
    expect(compiled.used()).toBeGreaterThan(0);
    const result = publicScan(workflow);
    expect(result.analysis.status).toBe('DEGRADED');
    expect(result.analysis.diagnostics).toContainEqual(expect.objectContaining({ code: 'GRAPH_ANALYSIS_DEGRADED', observed: 1, omitted: 0 }));
    expect(result.facts.some((fact) => fact.kind.startsWith('dataflow.'))).toBe(false);
    expect(result.traces).toEqual([]);
    const dormant = dormantScan(workflow).byCapability.get('taint-integrity')!;
    expect(dormant.findings).toEqual([]);
    expect(dormant.diagnostics.length).toBeGreaterThan(0);
    expect(compileFixture(workflow, 1).model.status).toBe('LIMITED');
  });

  it.each(['n8n-nodes-base.microsoftSql', 'n8n-nodes-base.readWriteFile',
    'n8n-nodes-base.function', 'n8n-nodes-base.functionItem', '@n8n/n8n-nodes-langchain.chainLlm'])
  ('never guesses an implementation for catalog-only variant %s', (type) => {
    expect(compileFixture(unknownWorkflow(type, { query: '={{ $json.body.cmd }}' })).model)
      .toEqual({ status: 'UNKNOWN', reason: 'NO_REVIEWED_SINK_MODEL' });
  });
});

describe('supported sink model refusal boundaries', () => {
  it.each(variants)('$name refuses aliases, literals, dynamic/wrapped reads and absent/future versions', (variant) => {
    for (const value of ['literal-canary', '={{ $json.body[$json.key] }}', '=prefix {{ $json.body.selected }}',
      '={{ $json.body.other + 1 }}', "={{ $('Source').item.json.body.selected }}",
      "={{ $json.body['a.b'] }}", '={{ $json.body.nested.value }}']) {
      const compiled = compileFixture(workflowFor(variant, variant.versions[0], { ...variant.extra, [variant.parameter]: value }));
      expect(compiled.model.status, value).toBe('UNKNOWN');
      expect(compiled.used()).toBeGreaterThan(0);
    }
    expect(compileFixture(workflowFor(variant, variant.versions[0], { ...variant.extra,
      guessedAlias: '={{ $json.body.selected }}' })).model.status).toBe('UNKNOWN');
    expect(compileFixture(workflowFor(variant, 99)).model).toEqual({ status: 'UNKNOWN', reason: 'UNSUPPORTED_VERSION' });
    const missing = workflowFor(variant);
    delete (missing.nodes[1] as { typeVersion?: number }).typeVersion;
    expect(compileFixture(missing).model).toEqual({ status: 'UNKNOWN', reason: 'UNSUPPORTED_VERSION' });
  });

  it.each(variants)('$name dynamic or disconnected input stays UNKNOWN at both consumers', (variant) => {
    const workflow = workflowFor(variant, variant.versions[0], { ...variant.extra,
      [variant.parameter]: '={{ $json.body[$json.key] }}' });
    for (const input of [workflow, { ...workflowFor(variant), connections: {} }]) {
      const result = publicScan(input);
      expect(result.analysis.status).toBe('DEGRADED');
      expect(result.facts.some((fact) => fact.kind.startsWith('dataflow.'))).toBe(false);
      expect(dormantScan(input).byCapability.get('taint-integrity')?.findings).toEqual([]);
    }
  });

  it.each(variants.slice(1))('$name binds reviewed semantics, exact occurrence and graph channel', (variant) => {
    const base = compileFixture(workflowFor(variant));
    const sink = base.workflow.nodes[1]!;
    const semantics = base.semantics.resolvedNodeSemantics.get(sink.ref.identityDigest)!;
    const alteredSemantics = new Map(base.semantics.resolvedNodeSemantics);
    alteredSemantics.set(sink.ref.identityDigest, { ...semantics, provenance: { ...semantics.provenance, sourceDigest: '0'.repeat(64) } });
    expect(compileScanLocalWorkflowFlowModelV1({ ...base, semantics: { ...base.semantics,
      resolvedNodeSemantics: alteredSemantics } }).status).toBe('UNKNOWN');
    const noSpan = { ...sink, parameters: sink.parameters.map((field) => field.pointer.endsWith(`/${variant.parameter}`)
      ? { ...field, occurrences: field.occurrences.map((occurrence) => ({ ...occurrence, span: null })) } : field) };
    expect(compileScanLocalWorkflowFlowModelV1({ ...base, workflow: { ...base.workflow,
      nodes: [base.workflow.nodes[0]!, noSpan] } })).toEqual({ status: 'UNKNOWN', reason: 'MISSING_SPAN' });
    const edge = base.workflow.edges[0]!;
    expect(compileScanLocalWorkflowFlowModelV1({ ...base, workflow: { ...base.workflow,
      edges: [{ ...edge, connectionType: 'ai_tool' }] } })).toEqual({ status: 'UNKNOWN', reason: 'UNSUPPORTED_EDGE' });
    expect(compileScanLocalWorkflowFlowModelV1({ ...base, workflow: { ...base.workflow,
      edges: [{ ...edge, targetPort: 1 }] } })).toEqual({ status: 'UNKNOWN', reason: 'UNSUPPORTED_PORT' });
  });

  it.each(variants.filter((variant) => variant.sinkClass === 'SQL'))('$name requires explicit static database/executeQuery selectors', (variant) => {
    for (const extra of [{ resource: 'database', operation: 'insert' }, { operation: 'executeQuery' },
      { resource: 'database', operation: '={{ $json.operation }}' }]) {
      expect(compileFixture(workflowFor(variant, variant.versions[0], { ...extra, query: '={{ $json.body.selected }}' })).model.status).toBe('UNKNOWN');
    }
  });

  it('does not silently choose URL over an unmodelled header read', () => {
    const workflow = workflowFor(variants[1], 4.2, { url: '={{ $json.body.selected }}', sendHeaders: true,
      headerParameters: { parameters: [{ name: 'x-input', value: '={{ $json.body.secret }}' }] } });
    expect(compileFixture(workflow).model).toEqual({ status: 'UNKNOWN', reason: 'NO_REVIEWED_SINK_MODEL' });
  });

  it('charges the exact preprocessing boundary and latches a refused debit', () => {
    const workflow = workflowFor(variants[2]);
    const baseline = compileFixture(workflow);
    expect(compileFixture(workflow, baseline.used()).model.status).toBe('SUPPORTED');
    expect(compileFixture(workflow, baseline.used() - 1).model.status).toBe('LIMITED');
    let calls = 0;
    expect(compileScanLocalWorkflowFlowModelV1({ ...baseline, charge: () => { calls += 1; return false; } }).status).toBe('LIMITED');
    expect(calls).toBe(1);
  });

  it('refuses source-receipt drift for every supported sink', () => {
    for (const variant of variants) {
      const base = compileFixture(workflowFor(variant));
      const source = base.workflow.nodes[0]!;
      const semantics = base.semantics.resolvedNodeSemantics.get(source.ref.identityDigest)!;
      const resolvedNodeSemantics = new Map(base.semantics.resolvedNodeSemantics);
      resolvedNodeSemantics.set(source.ref.identityDigest, { ...semantics,
        provenance: { ...semantics.provenance, sourceDigest: '0'.repeat(64) } });
      expect(compileScanLocalWorkflowFlowModelV1({ ...base,
        semantics: { ...base.semantics, resolvedNodeSemantics } })).toEqual({ status: 'UNKNOWN', reason: 'NO_REVIEWED_PAIR' });
    }
  });
});
