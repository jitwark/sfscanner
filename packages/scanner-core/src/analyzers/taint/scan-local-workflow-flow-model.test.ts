import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { parseSourceDocument } from '../../source/source-parser';
import { normalizeSecurityWorkflow } from '../../workflow-v2/normalize-security-workflow';
import type {
  EdgeRefV2, NormalizationAmbiguityV2, SecurityNodeV2, SecurityWorkflowV2,
} from '../../workflow-v2/security-workflow';
import type { ResolvedNodeSemanticsV2 } from '../../semantics/catalogue-schema';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from '../../semantics/builtin-catalogue';
import type { SemanticCatalogueViewV2 } from '../../capabilities/scheduler';
import { resolveNodeSemanticsForScan } from '../../semantics/generic-fallback';
import { compileScanLocalWorkflowFlowModelV1 } from './scan-local-workflow-flow-model';
import { compileWorkflowFlowWitnesses } from './scan-local-workflow-flow-witnesses';

const positive = {
  nodes: [
    { id: 'source', name: 'Source', type: 'n8n-nodes-base.webhook', typeVersion: 1,
      position: [100, 200], parameters: { httpMethod: 'POST', path: 'in' } },
    { id: 'sink', name: 'Sink', type: 'n8n-nodes-base.executeCommand', typeVersion: 1,
      position: [300, 200], parameters: { command: '={{ $json.body.cmd }}' } },
  ],
  connections: { Source: { main: [[{ node: 'Sink', type: 'main', index: 0 }]] } },
} as const;

function compile(raw: string, allowance = Number.MAX_SAFE_INTEGER) {
  const parsed = parseSourceDocument(new TextEncoder().encode(raw), DEFAULT_SCANNER_LIMITS_V2);
  if (!parsed.ok) throw new Error(parsed.message);
  const normalized = normalizeSecurityWorkflow(parsed.document, DEFAULT_SCANNER_LIMITS_V2);
  if (!normalized.ok) throw new Error(normalized.message);
  const resolved = new Map<string, ResolvedNodeSemanticsV2>();
  for (const node of normalized.workflow.nodes) {
    const result = resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, node);
    if (result) resolved.set(node.ref.identityDigest, result.semantics);
  }
  const semantics: SemanticCatalogueViewV2 = { id: BUILTIN_SEMANTIC_CATALOGUE_V2.id,
    version: BUILTIN_SEMANTIC_CATALOGUE_V2.version, digest: BUILTIN_SEMANTIC_CATALOGUE_V2.digest,
    resolvedNodeSemantics: resolved };
  let used = 0;
  const charge = (units: number): boolean => {
    if (units > allowance - used) return false;
    used += units;
    return true;
  };
  return { workflow: normalized.workflow, semantics, model: compileScanLocalWorkflowFlowModelV1({
    workflow: normalized.workflow, semantics, charge }) };
}

const ptrEscape = (value: string): string => value.replaceAll('~', '~0').replaceAll('/', '~1');
const edgePointer = (edge: EdgeRefV2): string => `/connections/${ptrEscape(edge.sourceLabel)}/`
  + `${ptrEscape(edge.connectionType)}/${String(edge.sourcePort)}/0`;

function mutate(workflow: SecurityWorkflowV2, change: (value: {
  nodes: SecurityNodeV2[]; edges: EdgeRefV2[]; ambiguities: NormalizationAmbiguityV2[];
}) => void) {
  const value = { nodes: [...workflow.nodes], edges: [...workflow.edges], ambiguities: [...workflow.ambiguities] };
  change(value);
  return { ...workflow, ...value };
}

describe('reviewed Webhook v1 to ExecuteCommand v1 model', () => {
  it('builds the exact DATA edge, carriers, subjects and same-object terminal read', () => {
    const { workflow, semantics, model } = compile(JSON.stringify(positive));
    expect(model.status).toBe('SUPPORTED');
    if (model.status !== 'SUPPORTED') return;
    const [source, sink] = workflow.nodes;
    if (!source || !sink) throw new Error('missing fixture nodes');
    expect(model.entry).toBe(source.ref.identityDigest);
    expect(model.graph.get(model.entry)).toEqual([sink.ref.identityDigest]);
    expect(model.transferModels.get(model.entry)).toEqual({ kind: 'COPY' });
    expect(model.transferModels.get(sink.ref.identityDigest)).toEqual({ kind: 'COPY' });
    expect(model.taintLabels).toEqual(['WEBHOOK_BODY']);
    expect(model.initialState).toMatchObject({ knowledge: 'KNOWN', atoms: [{
      sourceId: source.ref.identityDigest, field: ['body', 'cmd'], channel: 'CONFIDENTIALITY' }] });
    expect(model.witness.carriers.get(model.entry)).toEqual({ kind: 'SOURCE', node: source.ref.ordinal,
      field: 'body.cmd', port: 0, item: 0 });
    expect(model.witness.carriers.get(sink.ref.identityDigest)).toEqual({ kind: 'SINK', node: sink.ref.ordinal,
      field: '/command', port: 0, item: 0 });
    expect(model.witness.edges.get(model.entry)?.get(sink.ref.identityDigest)).toEqual({
      ordinal: workflow.edges[0]!.ordinal, channel: 'DATA', supported: true });
    expect(model.witness.subjects.get(source.ref.ordinal)).toEqual({ kind: 'NODE', node: source.ref });
    expect(model.witness.subjects.get(sink.ref.ordinal)).toEqual({ kind: 'NODE', node: sink.ref });
    expect(model.sinks.get(sink.ref.identityDigest)).toEqual({ sinkClass: 'COMMAND', sinkParameterPath: '/command',
      sinkFieldPath: ['command'], sinkChannel: 'DATA', edgeChannel: 'DATA' });
    const request = model.witness.requests[0]!;
    expect(request).toMatchObject({ sink: sink.ref.identityDigest, channel: 'DATA',
      terminalInputRead: { channel: 'DATA', path: ['body', 'cmd'], sinkParameterPath: '/command' } });
    expect(request.terminalInputRead?.carrier).toBe(model.witness.carriers.get(sink.ref.identityDigest));
    expect(workflow.nodes[0]!.ref.source.span).not.toBeNull();
    const edge = workflow.edges[0]!;
    expect(edge.source.span).not.toBeNull();
    expect(edge.source.pointer).toBe(edgePointer(edge));
    expect(workflow.edges[0]!.source.span).toBe(edge.source.span);
    expect(edge.source.occurrencePath).toHaveLength(5);
    expect(edge.source.occurrencePath.every((part) => Number.isSafeInteger(part) && part >= 0)).toBe(true);
    expect(workflow.nodes[1]!.parameters.find((field) => field.pointer.endsWith('/command'))?.occurrences[0]?.span)
      .not.toBeNull();
    expect(semantics.resolvedNodeSemantics.size).toBe(2);
  });

  it('derives the pointer with JSON-pointer escapes from the normalized edge', () => {
    const escaped = {
      ...positive,
      nodes: [{ ...positive.nodes[0], name: 'Source/~' }, positive.nodes[1]],
      connections: { 'Source/~': positive.connections.Source },
    };
    const { workflow, model } = compile(JSON.stringify(escaped));
    expect(model.status).toBe('SUPPORTED');
    expect(workflow.edges[0]!.source.pointer).toBe('/connections/Source~1~0/main/0/0');
  });

  it.each([
    ['literal command', 'echo fixed', 'NO_REVIEWED_PAIR'],
    ['dynamic selector', '={{ $json.body[$json.key] }}', 'DYNAMIC_FIELD'],
    ['expression wrapper', '=prefix {{ $json.body.cmd }}', 'UNSUPPORTED_EXPRESSION'],
    ['operator expression', '={{ 1 + $json.body.cmd }}', 'UNSUPPORTED_EXPRESSION'],
    ['extra expression island', '={{ $json.body.cmd }} {{ $json.body.cmd }}', 'UNSUPPORTED_EXPRESSION'],
    ['named-node reference', "={{ $('Source').item.json.body.cmd }}", 'UNSUPPORTED_EXPRESSION'],
  ])('%s remains explicit and unsupported', (_name, command, reason) => {
    const value = { ...positive, nodes: [positive.nodes[0], { ...positive.nodes[1], parameters: { command } }] };
    const { model } = compile(JSON.stringify(value));
    expect(model).toEqual({ status: 'UNKNOWN', reason });
  });

  it('publishes an applicable model failure internally as UNKNOWN', () => {
    const value = { ...positive, nodes: [positive.nodes[0], { ...positive.nodes[1], parameters: { command: 'echo fixed' } }] };
    const { workflow, semantics } = compile(JSON.stringify(value));
    const analysis = compileWorkflowFlowWitnesses({ workflow, semantics, limits: DEFAULT_SCANNER_LIMITS_V2,
      semanticSha256: '0'.repeat(64) });
    expect(analysis.status).toBe('UNKNOWN');
    expect(analysis.facts).toEqual([]);
    expect(analysis.traces).toEqual([]);
    expect(analysis.diagnostics).toHaveLength(1);
    expect(analysis.diagnostics[0]).toMatchObject({ code: 'GRAPH_ANALYSIS_DEGRADED',
      capabilityId: 'structural-policies', aggregateEffect: 'DEGRADED', assessmentEligible: true,
      observed: 1, omitted: 0 });
    expect(analysis.diagnostics[0]).not.toHaveProperty('maximum');
  });

  it('returns DISCONNECTED without inventing a ManualTrigger source', () => {
    const disconnected = { ...positive, connections: {} };
    const manual = { ...positive, nodes: [{ ...positive.nodes[0], type: 'n8n-nodes-base.manualTrigger',
      parameters: {} }, positive.nodes[1]], connections: {} };
    expect(compile(JSON.stringify(disconnected)).model).toEqual({ status: 'UNKNOWN', reason: 'DISCONNECTED' });
    expect(compile(JSON.stringify(manual)).model).toEqual({ status: 'NOT_APPLICABLE' });
  });

  it('rejects unsupported versions, ports, edges, spans and ambiguity', () => {
    const base = compile(JSON.stringify(positive));
    const wrongVersion = mutate(base.workflow, ({ nodes }) => {
      nodes[0] = { ...nodes[0]!, typeVersion: '2.0.0' };
    });
    const wrongPort = mutate(base.workflow, ({ edges }) => {
      edges[0] = { ...edges[0]!, sourcePort: 1 };
    });
    const wrongType = mutate(base.workflow, ({ edges }) => {
      edges[0] = { ...edges[0]!, connectionType: 'ai_tool' };
    });
    const missingNodeSpan = mutate(base.workflow, ({ nodes }) => {
      nodes[0] = { ...nodes[0]!, ref: { ...nodes[0]!.ref, source: { ...nodes[0]!.ref.source, span: null } } };
    });
    const missingCommandSpan = mutate(base.workflow, ({ nodes }) => {
      nodes[1] = { ...nodes[1]!, parameters: nodes[1]!.parameters.map((field) => field.pointer.endsWith('/command')
        ? { ...field, occurrences: field.occurrences.map((occurrence) => ({ ...occurrence, span: null })) } : field) };
    });
    const missingEdgeSpan = mutate(base.workflow, ({ edges }) => {
      edges[0] = { ...edges[0]!, source: { ...edges[0]!.source, span: null } };
    });
    const cases = [
      [wrongVersion, 'UNSUPPORTED_VERSION'], [wrongPort, 'UNSUPPORTED_PORT'], [wrongType, 'UNSUPPORTED_EDGE'],
      [missingNodeSpan, 'MISSING_SPAN'], [missingCommandSpan, 'MISSING_SPAN'], [missingEdgeSpan, 'MISSING_SPAN'],
    ] as const;
    for (const [workflow, reason] of cases) {
      let used = 0;
      const model = compileScanLocalWorkflowFlowModelV1({ workflow, semantics: base.semantics,
        charge: () => { used += 1; return true; } });
      expect(model, reason).toEqual({ status: 'UNKNOWN', reason });
      expect(used).toBeGreaterThan(0);
    }
    const duplicateRaw = JSON.stringify(positive).replace('"command":"={{ $json.body.cmd }}"',
      '"command":"={{ $json.body.cmd }}","command":"echo other"');
    expect(compile(duplicateRaw).model).toEqual({ status: 'UNKNOWN', reason: 'AMBIGUOUS_IR' });
  });

  it('rejects forged pointers, identity drift, versions, eligibility and target slots', () => {
    const base = compile(JSON.stringify(positive));
    const modelFor = (change: Parameters<typeof mutate>[1]) => compileScanLocalWorkflowFlowModelV1({
      workflow: mutate(base.workflow, change), semantics: base.semantics, charge: () => true,
    });
    const sparsePath = [0, 0, 0, 0, 0];
    delete sparsePath[2];
    const cases: readonly [Parameters<typeof mutate>[1], string][] = [
      [({ nodes }) => { nodes[0] = { ...nodes[0]!, ref: { ...nodes[0]!.ref,
        source: { ...nodes[0]!.ref.source, pointer: '/nodes/1' } } }; }, 'MISSING_SPAN'],
      [({ nodes }) => { nodes[1] = { ...nodes[1]!, ref: { ...nodes[1]!.ref,
        source: { ...nodes[1]!.ref.source, pointer: '/nodes/0' } } }; }, 'MISSING_SPAN'],
      [({ edges }) => { edges[0] = { ...edges[0]!, source: { ...edges[0]!.source,
        pointer: '/connections/Wrong/main/0/0' } }; }, 'MISSING_SPAN'],
      [({ edges }) => { edges[0] = { ...edges[0]!, source: { ...edges[0]!.source,
        pointer: '/connections/Source/main/0/1' } }; }, 'MISSING_SPAN'],
      [({ edges }) => { edges[0] = { ...edges[0]!, sourceLabel: '', source: { ...edges[0]!.source,
        pointer: '/connections//main/0/0' } }; }, 'MISSING_SPAN'],
      [({ edges }) => { edges[0] = { ...edges[0]!, source: { ...edges[0]!.source,
        occurrencePath: [0, 0, 0, 0] } }; }, 'MISSING_SPAN'],
      [({ edges }) => { edges[0] = { ...edges[0]!, source: { ...edges[0]!.source,
        occurrencePath: sparsePath } }; }, 'MISSING_SPAN'],
      [({ nodes }) => { nodes[1] = { ...nodes[1]!, parameters: nodes[1]!.parameters.map((field) =>
        field.pointer.endsWith('/command') ? { ...field, occurrences: field.occurrences.map((occurrence) =>
          ({ ...occurrence, pointer: '/nodes/1/parameters/other' })) } : field) }; }, 'MISSING_SPAN'],
      [({ edges }) => { edges[0] = { ...edges[0]!, targetPort: 1 }; }, 'UNSUPPORTED_PORT'],
      [({ edges }) => { edges[0] = { ...edges[0]!, resolution: 'UNRESOLVED' }; }, 'UNSUPPORTED_EDGE'],
      [({ edges }) => { edges[0] = { ...edges[0]!, sourceNode: { ...edges[0]!.sourceNode!,
        identityDigest: '0'.repeat(64) } }; }, 'DISCONNECTED'],
      [({ edges }) => { edges[0] = { ...edges[0]!, targetNode: { ...edges[0]!.targetNode!,
        identityDigest: '0'.repeat(64) } }; }, 'DISCONNECTED'],
      [({ nodes }) => { nodes[0] = { ...nodes[0]!, typeVersion: undefined };
        nodes[1] = { ...nodes[1]!, typeVersion: undefined }; }, 'UNSUPPORTED_VERSION'],
      [({ nodes }) => { nodes[1] = { ...nodes[1]!, typeVersion: '2.0.0' }; }, 'UNSUPPORTED_VERSION'],
      [({ nodes }) => { nodes[0] = { ...nodes[0]!, typeVersion: undefined }; }, 'UNSUPPORTED_VERSION'],
      [({ nodes }) => { nodes[1] = { ...nodes[1]!, typeVersion: undefined }; }, 'UNSUPPORTED_VERSION'],
      [({ nodes }) => { nodes[0] = { ...nodes[0]!, disabled: true }; }, 'AMBIGUOUS_IR'],
      [({ nodes }) => { nodes[1] = { ...nodes[1]!, scoringEligibility: 'INDETERMINATE' }; }, 'AMBIGUOUS_IR'],
    ];
    for (const [change, reason] of cases) {
      expect(modelFor(change), reason).toEqual({ status: 'UNKNOWN', reason });
    }
  });

  it('reports measured LIMITED when the shared charge refuses', () => {
    const { model } = compile(JSON.stringify(positive), 0);
    expect(model).toEqual({ status: 'LIMITED', omittedLowerBound: 1 });
  });
});
