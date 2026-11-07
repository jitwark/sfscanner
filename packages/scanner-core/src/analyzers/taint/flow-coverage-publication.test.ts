import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import type { SemanticCatalogueViewV2 } from '../../capabilities/scheduler';
import { admitCandidateCompositionFactsV1 } from '../../result-v2/field-flow-admission';
import { createFactId } from '../../result-v2/identities';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from '../../semantics/builtin-catalogue';
import type { ResolvedNodeSemanticsV2 } from '../../semantics/catalogue-schema';
import { resolveNodeSemanticsForScan } from '../../semantics/generic-fallback';
import { parseSourceDocument } from '../../source/source-parser';
import { normalizeSecurityWorkflow } from '../../workflow-v2/normalize-security-workflow';
import {
  deriveFlowCoverageV1, type FlowCoverageCountersV1, type FlowCoverageDerivationV1,
  type FlowCoverageInputV1,
} from './flow-coverage-derivation';
import { withFlowCoverageChargeV1 } from './flow-coverage-observation';
import { publishFlowCoverageV1 } from './flow-coverage-publication';
import { createScanLocalFlowFactEmitterV1 } from './scan-local-flow-witness-facts';
import type { ScanLocalChargeV1 } from './scan-local-state';
import { createScanLocalTransfer } from './scan-local-transfer';
import { runScanLocalWithWitnesses, type ScanLocalWitnessResultV1 } from './scan-local-traces';
import { compileScanLocalWorkflowFlowModelV1 } from './scan-local-workflow-flow-model';

const semanticSha256 = 'a'.repeat(64);
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
  const model = compileScanLocalWorkflowFlowModelV1({ workflow: normalized.workflow, semantics, charge: () => true });
  if (model.status !== 'SUPPORTED') throw new Error(`Expected supported model, received ${model.status}`);
  return model;
}

function run(charge: ScanLocalChargeV1 = () => true): ScanLocalWitnessResultV1 {
  const model = compile();
  const emitFlow = createScanLocalFlowFactEmitterV1({ carriers: model.witness.carriers,
    subjects: model.witness.subjects, sinks: model.sinks, taintLabels: model.taintLabels,
    limits: DEFAULT_SCANNER_LIMITS_V2 });
  return runScanLocalWithWitnesses({ entry: model.entry, graph: model.graph, initialState: model.initialState,
    transfer: createScanLocalTransfer(model.transferModels), maxStates: 20, maxOperations: 100_000, charge },
  { ...model.witness, context: { semanticSha256 }, limits: { maxTraceStepsPerFinding: 100, maxEvidenceBytes: 100_000 },
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

function producer() {
  const actual = run();
  const input: FlowCoverageInputV1 = { kind: 'TERMINAL', snapshot: actual.flowCoverage,
    facts: actual.facts, counters: counters(actual) };
  const handoff = withFlowCoverageChargeV1(actual.flowCoverage, (charge) => deriveFlowCoverageV1(input, charge));
  if (!handoff.ok || !handoff.value.ok) throw new Error('Expected real derived flow coverage');
  return { actual, coverage: handoff.value };
}

describe('paid flow coverage publication', () => {
  it('charges the header before inspecting derivation or existing facts', () => {
    let inspected = 0, charged = false;
    const coverage = new Proxy({ ok: false as const, reason: 'TELEMETRY_UNAVAILABLE' as const }, {
      get() { inspected += 1; return undefined; },
      getOwnPropertyDescriptor() { inspected += 1; return undefined; },
    });
    const facts = new Proxy([] as never[], {
      get() { inspected += 1; return undefined; },
      getOwnPropertyDescriptor() { inspected += 1; return undefined; },
    });
    const result = publishFlowCoverageV1({ coverage, existingFacts: facts, semanticSha256 }, () => {
      charged = true; return false;
    });
    expect(result).toEqual({ ok: false, reason: 'BUDGET_EXHAUSTED' });
    expect(charged).toBe(true);
    expect(inspected).toBe(0);
  });

  it('charges dynamic list work before traversing its first element', () => {
    const { coverage } = producer();
    let remaining = 35, elementReads = 0;
    const channelList = coverage.properties.taintChannels;
    if (!Array.isArray(channelList)) throw new Error('Expected taint channel list');
    const taintChannels = new Proxy([...channelList], {
      getOwnPropertyDescriptor(target, key) {
        if (key !== 'length') elementReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const guarded: FlowCoverageDerivationV1 = { ok: true,
      properties: Object.freeze({ ...coverage.properties, taintChannels }) };
    const charge: ScanLocalChargeV1 = (units) => {
      if (units > remaining) return false;
      remaining -= units;
      return true;
    };
    expect(publishFlowCoverageV1({ coverage: guarded, existingFacts: [], semanticSha256 }, charge))
      .toEqual({ ok: false, reason: 'BUDGET_EXHAUSTED' });
    expect(elementReads).toBe(0);
  });

  it('returns a derivation refusal without inspecting retained facts', () => {
    let reads = 0;
    const facts = new Proxy([] as never[], {
      get() { reads += 1; return undefined; },
      getOwnPropertyDescriptor() { reads += 1; return undefined; },
    });
    expect(publishFlowCoverageV1({ coverage: { ok: false, reason: 'TELEMETRY_UNAVAILABLE' },
      existingFacts: facts, semanticSha256 }, () => true)).toEqual({ ok: false, reason: 'TELEMETRY_UNAVAILABLE' });
    expect(reads).toBe(0);
  });

  it('publishes one semantic fact from the real producer and admits composition', () => {
    const { actual, coverage } = producer();
    const result = publishFlowCoverageV1({ coverage, existingFacts: actual.facts, semanticSha256 }, () => true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.ok).toBe(true);
    expect(result.fact).toMatchObject({ kind: 'dataflow.coverage.v1', subject: { kind: 'WORKFLOW' },
      properties: { capabilityId: 'taint-integrity', coverageStatus: 'COMPLETE', fieldsExamined: 2,
        knownFields: 2, positiveFields: 2, emittedFlows: 1, taintChannels: ['CONFIDENTIALITY'] } });
    expect(result.fact.factId).toBe(createFactId(result.fact, { semanticSha256 }));
    expect(result.facts).toEqual([...actual.facts, result.fact]);
    expect(result.facts.slice(0, -1)).toEqual(actual.facts);
    expect(admitCandidateCompositionFactsV1(result.facts, { semanticSha256 })).toHaveLength(3);
  });

  it('refuses duplicate coverage without returning a partial fact set', () => {
    const { actual, coverage } = producer();
    const first = publishFlowCoverageV1({ coverage, existingFacts: actual.facts, semanticSha256 }, () => true);
    if (!first.ok) throw new Error(first.reason);
    const second = publishFlowCoverageV1({ coverage, existingFacts: first.facts, semanticSha256 }, () => true);
    expect(second).toEqual({ ok: false, reason: 'INCOHERENT_EVIDENCE' });
    expect(second).not.toHaveProperty('facts');
  });

  it('refuses coverage owned by a different capability', () => {
    const { actual, coverage } = producer();
    const properties = { ...coverage.properties, capabilityId: 'taint-confidentiality' };
    expect(publishFlowCoverageV1({ coverage: { ok: true, properties }, existingFacts: actual.facts, semanticSha256 },
      () => true)).toEqual({ ok: false, reason: 'INCOHERENT_EVIDENCE' });
  });

  it('maps a late-cache REFUSED snapshot to typed telemetry failure with no publication', () => {
    let required = 0;
    run((units) => { required += units; return true; });
    let paid = 0;
    const charge: ScanLocalChargeV1 = (units) => {
      if (units > required - paid - 1) return false;
      paid += units; return true;
    };
    const actual = run(charge);
    expect(actual.flowCoverage).toEqual({ status: 'REFUSED', reason: 'BUDGET_EXHAUSTED' });
    const input: FlowCoverageInputV1 = { kind: 'TERMINAL', snapshot: actual.flowCoverage,
      facts: actual.facts, counters: counters(actual) };
    const derived = deriveFlowCoverageV1(input, charge);
    expect(derived).toEqual({ ok: false, reason: 'TELEMETRY_UNAVAILABLE' });
    expect(publishFlowCoverageV1({ coverage: derived, existingFacts: actual.facts, semanticSha256 }, charge))
      .toEqual({ ok: false, reason: 'BUDGET_EXHAUSTED' });
  });

  it('keeps the real positive publication within the standard shared budget', () => {
    const actual = run();
    const input: FlowCoverageInputV1 = { kind: 'TERMINAL', snapshot: actual.flowCoverage,
      facts: actual.facts, counters: counters(actual) };
    const derived = withFlowCoverageChargeV1(actual.flowCoverage, (stored) => deriveFlowCoverageV1(input, stored));
    if (!derived.ok || !derived.value.ok) throw new Error('Expected a published real flow');
    let total = 0, peak = 0;
    const charge: ScanLocalChargeV1 = (units) => { total += units; peak = Math.max(peak, units); return total <= 100_000; };
    const published = publishFlowCoverageV1({ coverage: derived.value, existingFacts: actual.facts, semanticSha256 }, charge);
    expect(published.ok).toBe(true);
    expect({ total, peak }).toEqual({ total: 15_658, peak: 11_924 });
    expect(total).toBeLessThanOrEqual(100_000);
  });
});
