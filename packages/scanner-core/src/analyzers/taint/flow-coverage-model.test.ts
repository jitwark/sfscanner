import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { validateFieldFlowCoherenceV1 } from '../../../../../contracts/scanner-v2-field-flow-coherence';
import { readFieldFlowPropertiesV1, validateFieldFlowSubject } from '../../../../../contracts/scanner-v2-field-flow-validation';
import type { SafeFactV2, SemanticCatalogueViewV2 } from '../../capabilities/scheduler';
import { createCandidateFactId } from '../../result-v2/identities';
import { resolveNodeSemanticsForScan } from '../../semantics/generic-fallback';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from '../../semantics/builtin-catalogue';
import type { ResolvedNodeSemanticsV2 } from '../../semantics/catalogue-schema';
import { parseSourceDocument } from '../../source/source-parser';
import { normalizeSecurityWorkflow } from '../../workflow-v2/normalize-security-workflow';
import {
  deriveFlowCoverageV1, type FlowCoverageCountersV1, type FlowCoverageInputV1,
} from './flow-coverage-derivation';
import { withFlowCoverageChargeV1 } from './flow-coverage-observation';
import { createScanLocalFlowFactEmitterV1 } from './scan-local-flow-witness-facts';
import type { ScanLocalChargeV1 } from './scan-local-state';
import { createScanLocalTransfer } from './scan-local-transfer';
import { runScanLocalWithWitnesses, type ScanLocalWitnessResultV1 } from './scan-local-traces';
import { compileScanLocalWorkflowFlowModelV1 } from './scan-local-workflow-flow-model';

const positive = {
  nodes: [
    { id: 'source', name: 'Source', type: 'n8n-nodes-base.webhook', typeVersion: 1,
      position: [100, 200], parameters: { httpMethod: 'POST', path: 'in' } },
    { id: 'sink', name: 'Sink', type: 'n8n-nodes-base.executeCommand', typeVersion: 1,
      position: [300, 200], parameters: { command: '={{ $json.body.cmd }}' } },
  ],
  connections: { Source: { main: [[{ node: 'Sink', type: 'main', index: 0 }]] } },
} as const;

function compile() {
  const parsed = parseSourceDocument(new TextEncoder().encode(JSON.stringify(positive)), DEFAULT_SCANNER_LIMITS_V2);
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
  const charge: ScanLocalChargeV1 = () => true;
  const model = compileScanLocalWorkflowFlowModelV1({ workflow: normalized.workflow, semantics, charge });
  if (model.status !== 'SUPPORTED') throw new Error(`Expected supported model, received ${model.status}`);
  return { model, semantics };
}

function run(model: ReturnType<typeof compile>['model']): ScanLocalWitnessResultV1 {
  const emitFlow = createScanLocalFlowFactEmitterV1({ carriers: model.witness.carriers,
    subjects: model.witness.subjects, sinks: model.sinks, taintLabels: model.taintLabels,
    limits: DEFAULT_SCANNER_LIMITS_V2 });
  const charge: ScanLocalChargeV1 = () => true;
  return runScanLocalWithWitnesses({
    entry: model.entry, graph: model.graph, initialState: model.initialState,
    transfer: createScanLocalTransfer(model.transferModels), maxStates: 20, maxOperations: 100_000, charge,
  }, { ...model.witness, context: { semanticSha256: '0'.repeat(64) },
    limits: { maxTraceStepsPerFinding: 100, maxEvidenceBytes: 100_000 },
    maxWitnessOperations: 10_000, emitFlow });
}

function counters(result: ScanLocalWitnessResultV1): FlowCoverageCountersV1 {
  return Object.freeze({ analysisStatus: result.analysis.status, flowsStatus: result.flows.status,
    analysisOmitted: result.analysis.omitted, invalidRequests: result.flows.invalidRequests,
    unmappedSources: result.flows.unmappedSources, unpublishedSinks: result.flows.unpublishedSinks,
    incompleteTransfers: result.flows.incompleteTransfers, omittedRequests: result.omittedRequests,
    witnessUnavailable: result.witnessUnavailable, omittedTraceSteps: result.omittedTraceSteps,
    suppressedRequests: result.suppressedRequests });
}

describe('flow coverage from the reviewed workflow model', () => {
  it('retains the accepted CONFIDENTIALITY channel through the real runner', () => {
    const { model } = compile();
    const actual = run(model);
    expect(actual.flowCoverage.status).toBe('OBSERVED');
    expect(actual.facts).toHaveLength(2);
    expect(actual.facts[0]?.properties).toMatchObject({ taintChannel: 'CONFIDENTIALITY' });
    expect(actual.facts[1]?.properties).toMatchObject({ taintChannel: 'CONFIDENTIALITY' });
    const input: FlowCoverageInputV1 = { kind: 'TERMINAL', snapshot: actual.flowCoverage,
      facts: actual.facts, counters: counters(actual) };
    const handoff = withFlowCoverageChargeV1(actual.flowCoverage, (charge) => deriveFlowCoverageV1(input, charge));
    expect(handoff.ok).toBe(true);
    if (!handoff.ok || !handoff.value.ok) throw new Error('Expected derived coverage from observed terminal flow');
    expect(handoff.value.properties).toMatchObject({ capabilityId: 'taint-integrity', coverageStatus: 'COMPLETE',
      fieldsExamined: 2, knownFields: 2, positiveFields: 2, emittedFlows: 1,
      taintChannels: ['CONFIDENTIALITY'], sinkChannels: ['DATA'], edgeChannels: ['DATA'] });
    const coverage = { kind: 'dataflow.coverage.v1' as const, subject: { kind: 'WORKFLOW' as const },
      properties: handoff.value.properties };
    const retained: SafeFactV2 = Object.freeze({ ...coverage, factId: createCandidateFactId(coverage) });
    expect(readFieldFlowPropertiesV1(retained.kind, retained.properties)).toEqual(handoff.value.properties);
    expect(validateFieldFlowSubject(retained.kind, retained.subject, retained.properties)).toBe(true);
    expect(validateFieldFlowCoherenceV1([...actual.facts, retained], 'taint-integrity')).toBe(true);
  });
});
