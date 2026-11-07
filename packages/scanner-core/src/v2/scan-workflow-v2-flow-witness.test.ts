import { describe, expect, it } from 'vitest';
import { createFactId } from '../result-v2/identities';
import { scanWorkflowV2 } from './index';

const profile = { id: 'beta-default', version: '2.0.0' } as const;
const positive = {
  nodes: [
    { id: 'source', name: 'Source', type: 'n8n-nodes-base.webhook', typeVersion: 1,
      position: [100, 200], parameters: { httpMethod: 'POST', path: 'in' } },
    { id: 'sink', name: 'Sink', type: 'n8n-nodes-base.executeCommand', typeVersion: 1,
      position: [300, 200], parameters: { command: '={{ $json.body.cmd }}' } },
  ],
  connections: { Source: { main: [[{ node: 'Sink', type: 'main', index: 0 }]] } },
} as const;
const scan = (workflow: unknown, limits?: unknown) => scanWorkflowV2({
  bytes: new TextEncoder().encode(JSON.stringify(workflow)), profile, ...(limits === undefined ? {} : { limits }),
});

function flowEvidence(value: unknown) {
  const result = scan(value);
  if (!result.ok) throw new Error(result.code);
  return {
    result: result.result,
    facts: result.result.facts.filter((fact) => fact.kind === 'dataflow.provenance.v1' || fact.kind === 'dataflow.summary.v3'),
    coverage: result.result.facts.filter((fact) => fact.kind === 'dataflow.coverage.v1'),
    traces: result.result.traces.filter((trace) => trace.kind === 'CONFIDENTIALITY'),
  };
}

function expectApplicableUnknown(value: unknown): void {
  const { result, facts, coverage, traces } = flowEvidence(value);
  expect(facts).toEqual([]);
  expect(coverage).toEqual([]);
  expect(traces).toEqual([]);
  expect(result.analysis.status).toBe('DEGRADED');
  const diagnostics = result.analysis.diagnostics.filter((diagnostic) => diagnostic.code === 'GRAPH_ANALYSIS_DEGRADED'
    && diagnostic.capabilityId === 'structural-policies');
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ aggregateEffect: 'DEGRADED', assessmentEligible: true, observed: 1, omitted: 0 });
  expect(diagnostics[0]).not.toHaveProperty('maximum');
  const owner = result.analysis.capabilities.find((capability) => capability.id === 'structural-policies');
  expect(owner).toMatchObject({ required: true, omitted: 0 });
  expect(result.stats.omittedFindings).toBe(0);
}

function expectNonApplicableComplete(value: unknown): void {
  const { result, facts, coverage, traces } = flowEvidence(value);
  expect(result.analysis.status).toBe('COMPLETE');
  expect(facts).toEqual([]);
  expect(coverage).toHaveLength(1);
  expect(coverage[0]?.properties).toMatchObject({ capabilityId: 'taint-integrity', coverageStatus: 'COMPLETE',
    fieldsExamined: 0, emittedFlows: 0, taintChannels: [] });
  expect(traces).toEqual([]);
  expect(result.analysis.diagnostics.some((diagnostic) => diagnostic.code === 'GRAPH_ANALYSIS_DEGRADED')).toBe(false);
  expect(result.stats.omittedFindings).toBe(0);
}

describe('public reviewed field witness', () => {
  it('composes one exact post-rekey Webhook body.cmd to command witness', () => {
    const { result, facts, coverage, traces } = flowEvidence(positive);
    expect(facts.filter((fact) => fact.kind === 'dataflow.provenance.v1')).toHaveLength(1);
    expect(facts.filter((fact) => fact.kind === 'dataflow.summary.v3')).toHaveLength(1);
    expect(traces).toHaveLength(1);
    expect(coverage).toHaveLength(1);
    expect(coverage[0]?.properties).toMatchObject({ capabilityId: 'taint-integrity', coverageStatus: 'COMPLETE',
      fieldsExamined: 2, knownFields: 2, positiveFields: 2, emittedFlows: 1,
      taintChannels: ['CONFIDENTIALITY'], sinkChannels: ['DATA'], edgeChannels: ['DATA'] });
    expect(coverage[0]?.factId).toBe(createFactId(coverage[0]!, { semanticSha256: result.input.semanticSha256 }));
    const provenance = facts.find((fact) => fact.kind === 'dataflow.provenance.v1')!;
    const summary = facts.find((fact) => fact.kind === 'dataflow.summary.v3')!;
    const trace = traces[0]!;
    expect(provenance.properties).toMatchObject({ sourceNodeOrdinal: 0, sourceFieldPath: ['body', 'cmd'],
      taintChannel: 'CONFIDENTIALITY', taintLabels: ['WEBHOOK_BODY'] });
    expect(summary.properties).toMatchObject({ sourceNodeOrdinal: 0, sourceFieldPath: ['body', 'cmd'],
      taintChannel: 'CONFIDENTIALITY', taintLabels: ['WEBHOOK_BODY'], sinkClass: 'COMMAND',
      sinkParameterPath: '/command', sinkFieldPath: ['command'], sinkChannel: 'DATA', edgeChannel: 'DATA',
      knowledge: 'KNOWN', sourceProvenanceFactId: provenance.factId });
    expect(trace.steps.map((step) => step.kind)).toEqual(['SOURCE', 'SINK']);
    const [sourceStep, sinkStep] = trace.steps;
    expect(sourceStep).toMatchObject({ subject: { kind: 'NODE', node: { ordinal: 0,
      source: { pointer: '/nodes/0' } } }, factRefs: [provenance.factId] });
    expect(sinkStep).toMatchObject({ subject: { kind: 'NODE', node: { ordinal: 1,
      source: { pointer: '/nodes/1' } } }, factRefs: [summary.factId] });
    if (sourceStep?.subject.kind !== 'NODE' || sinkStep?.subject.kind !== 'NODE') throw new Error('expected node endpoints');
    expect(sourceStep.subject.node.source.span).not.toBeNull();
    expect(sinkStep.subject.node.source.span).not.toBeNull();
    expect(result.stats.omittedFindings).toBe(0);
    expect(JSON.stringify({ facts, traces })).not.toContain('$json');
    expect(JSON.stringify({ facts, traces })).not.toContain('{{');
  });

  it('is byte-identical across repeated scans', () => {
    const first = flowEvidence(positive);
    const second = flowEvidence(positive);
    expect(JSON.stringify({ facts: second.facts, coverage: second.coverage, traces: second.traces }))
      .toBe(JSON.stringify({ facts: first.facts, coverage: first.coverage, traces: first.traces }));
  });

  it('keeps zero-budget pre-field loss explicit without fabricating coverage', () => {
    const result = scan(positive, { maxGraphOperations: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const coverage = result.result.facts.filter((fact) => fact.kind === 'dataflow.coverage.v1');
    expect(coverage).toEqual([]);
    expect(result.result.analysis.diagnostics.some((diagnostic) => diagnostic.code === 'GRAPH_ANALYSIS_DEGRADED')).toBe(true);
  });

  it.each([
    ['fixed literal', { ...positive, nodes: [positive.nodes[0], { ...positive.nodes[1], parameters: { command: 'echo fixed' } }] }],
    ['dynamic selector', { ...positive, nodes: [positive.nodes[0], { ...positive.nodes[1], parameters: { command: '={{ $json.body[$json.key] }}' } }] }],
    ['expression wrapper', { ...positive, nodes: [positive.nodes[0], { ...positive.nodes[1], parameters: { command: '=prefix {{ $json.body.cmd }}' } }] }],
    ['operator', { ...positive, nodes: [positive.nodes[0], { ...positive.nodes[1], parameters: { command: '={{ 1 + $json.body.cmd }}' } }] }],
    ['extra island', { ...positive, nodes: [positive.nodes[0], { ...positive.nodes[1], parameters: { command: '={{ $json.body.cmd }} {{ $json.body.cmd }}' } }] }],
    ['named node', { ...positive, nodes: [positive.nodes[0], { ...positive.nodes[1], parameters: { command: "={{ $('Source').item.json.body.cmd }}" } }] }],
    ['disconnected', { ...positive, connections: {} }],
    ['source port', { ...positive, connections: { Source: { main: [[], [{ node: 'Sink', type: 'main', index: 0 }]] } } }],
    ['target port', { ...positive, connections: { Source: { main: [[{ node: 'Sink', type: 'main', index: 1 }]] } } }],
    ['absent versions', { ...positive, nodes: [
      { ...positive.nodes[0], typeVersion: undefined }, { ...positive.nodes[1], typeVersion: undefined },
    ] }],
    ['disabled source', { ...positive, nodes: [{ ...positive.nodes[0], disabled: true }, positive.nodes[1]] }],
  ])('%s is an applicable UNKNOWN published as DEGRADED', (_name, workflow) => {
    expectApplicableUnknown(workflow);
  });

  it.each([
    ['empty', { nodes: [], connections: {} }],
    ['ManualTrigger pair', { ...positive, nodes: [{ ...positive.nodes[0], type: 'n8n-nodes-base.manualTrigger',
      parameters: {} }, positive.nodes[1]] }],
    ['Webhook only', { nodes: [positive.nodes[0]], connections: {} }],
  ])('%s stays non-applicable and COMPLETE', (_name, workflow) => {
    expectNonApplicableComplete(workflow);
  });

  it('does not propagate the reviewed COPY to an unmodeled downstream node', () => {
    const downstream = {
      ...positive,
      nodes: [...positive.nodes, { id: 'after', name: 'After', type: 'n8n-nodes-base.noOp', typeVersion: 1,
        position: [500, 200], parameters: {} }],
      connections: { Source: positive.connections.Source,
        Sink: { main: [[{ node: 'After', type: 'main', index: 0 }]] } },
    };
    expectApplicableUnknown(downstream);
  });
});
