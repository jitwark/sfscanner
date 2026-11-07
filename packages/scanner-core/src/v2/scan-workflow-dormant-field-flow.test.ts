import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { createDiagnostic } from '../capabilities/adapter-evidence';
import { validateCapabilityCandidate } from '../capabilities/candidate-validator';
import { createSafeFactAdmissionSnapshotV2 } from '../admission/snapshot';
import { createBetaHardenedCapabilityRegistry } from '../capabilities/beta-hardened';
import { BETA_HARDENED_PROFILE_MANIFEST } from '../capabilities/profile-manifest';
import { validateFieldFlowCoherenceV1, validateFieldFlowWitnessesV1 } from '../../../../contracts/scanner-v2-field-flow-coherence';
import { SAFE_FACT_REGISTRY_V2 } from '../facts/safe-fact-registry';
import { validateSafeFact } from '../facts/safe-fact-validator';
import { createCandidateFactId, createCandidateTraceId } from '../result-v2/identities';
import type { CapabilityCandidateV2, SafeFactV2, TraceV2 } from '../capabilities/scheduler';
import type { FlowWitnessAnalysisV2 } from '../analyzers/taint/scan-local-workflow-flow-witnesses';
import { scanWorkflowDormantHardenedV2 } from './scan-workflow';

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

function bytes(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }

function dormant(value: unknown) {
  const result = scanWorkflowDormantHardenedV2({ bytes: bytes(value), profile, limits: DEFAULT_SCANNER_LIMITS_V2 });
  if (!result.ok) throw new Error(result.code);
  const candidate = result.byCapability.get('taint-integrity');
  if (candidate === undefined) throw new Error('Missing taint-integrity candidate');
  return { result, candidate };
}

function validate(candidate: CapabilityCandidateV2, context: ReturnType<typeof dormant>['result']['context']) {
  for (const fact of candidate.facts) {
    const schema = SAFE_FACT_REGISTRY_V2.schemas.find((item) => item.kind === fact.kind)!;
    const factResult = validateSafeFact(createSafeFactAdmissionSnapshotV2(fact), schema, context.limits);
    if (!factResult.ok) throw new Error(`fact ${fact.kind}: ${factResult.reason}`);
  }
  expect(validateFieldFlowCoherenceV1(candidate.facts, 'taint-integrity')).toBe(true);
  expect(validateFieldFlowWitnessesV1(candidate.facts, candidate.findings, candidate.traces)).toBe(true);
  const spec = createBetaHardenedCapabilityRegistry().get('taint-integrity')!;
  const rules = new Map(spec.ruleIds.map((ruleId) => [ruleId, context.rules.rules.get(ruleId)!]));
  const registries = { facts: SAFE_FACT_REGISTRY_V2, rules };
  const result = validateCapabilityCandidate(candidate, spec, registries, context.limits, context.workflow.nodes.length);
  if (!result.ok) throw new Error(`finding: ${JSON.stringify({ rejection: result, finding: candidate.findings[0],
    trace: candidate.traces[0], rule: context.rules.rules.get('TAINTED_COMMAND') })}`);
  return result;
}

describe('dormant hardened field-flow candidate', () => {
  it('converts the real confidential command flow into admitted v3 evidence', () => {
    const { result, candidate } = dormant(workflow);
    expect(candidate.findings).toHaveLength(1);
    expect(candidate.findings[0]).toMatchObject({ ruleId: 'TAINTED_COMMAND', evidenceClass: 'POTENTIAL_DATAFLOW',
      conclusion: 'OBSERVED', applicability: 'APPLICABLE' });
    expect(candidate.facts.filter((fact) => fact.kind === 'dataflow.coverage.v1')).toHaveLength(1);
    expect(candidate.facts.filter((fact) => fact.kind === 'dataflow.provenance.v1')).toHaveLength(1);
    expect(candidate.facts.filter((fact) => fact.kind === 'dataflow.summary.v3')).toHaveLength(1);
    expect(candidate.traces).toHaveLength(1);
    expect(candidate.traces[0]?.kind).toBe('CONFIDENTIALITY');
    expect(candidate.findings[0]?.traceRefs).toEqual([candidate.traces[0]?.traceId]);
    expect(validate(candidate, result.context)).toMatchObject({ ok: true });
  });

  it('preserves an UNKNOWN summary as an UNKNOWN finding', () => {
    const { result } = dormant(workflow);
    const provenance = result.byCapability.get('taint-integrity')!.facts.find((fact) => fact.kind === 'dataflow.provenance.v1')!;
    const summary = result.byCapability.get('taint-integrity')!.facts.find((fact) => fact.kind === 'dataflow.summary.v3')!;
    const coverage = result.byCapability.get('taint-integrity')!.facts.find((fact) => fact.kind === 'dataflow.coverage.v1')!;
    const trace = result.byCapability.get('taint-integrity')!.traces[0]!;
    const summaryDraft = { kind: summary.kind, subject: summary.subject,
      properties: Object.freeze({ ...summary.properties, knowledge: 'UNKNOWN', unknownReasons: ['UNMODELLED_TRANSFER'] }) };
    const unknownSummary: SafeFactV2 = Object.freeze({ ...summaryDraft, factId: createCandidateFactId(summaryDraft) });
    const steps = Object.freeze(trace.steps.map((step) => Object.freeze({ ...step,
      factRefs: step.kind === 'SINK' ? Object.freeze([unknownSummary.factId]) : step.factRefs })));
    const unknownTrace: TraceV2 = Object.freeze({ kind: trace.kind, steps, traceId: createCandidateTraceId({ kind: trace.kind, steps }) });
    const analysis: FlowWitnessAnalysisV2 = Object.freeze({ status: 'LIMITED', facts: Object.freeze([provenance, unknownSummary, coverage]),
      traces: Object.freeze([unknownTrace]), diagnostics: Object.freeze([createDiagnostic('GRAPH_ANALYSIS_DEGRADED',
        'structural-policies', false, undefined, { omitted: 1 })]) });
    const spec = createBetaHardenedCapabilityRegistry({ getFieldFlow: () => analysis }).get('taint-integrity')!;
    const candidate = spec.run(result.context);
    expect(candidate.findings).toHaveLength(1);
    expect(candidate.findings[0]).toMatchObject({ ruleId: 'TAINTED_COMMAND', conclusion: 'UNKNOWN' });
    expect(validate(candidate, result.context)).toMatchObject({ ok: true });
  });
});
