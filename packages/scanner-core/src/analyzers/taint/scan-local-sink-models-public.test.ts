import { describe, expect, it } from 'vitest';
import { validateFieldFlowCoherenceV1, validateFieldFlowWitnessesV1 } from '../../../../../contracts/scanner-v2-field-flow-coherence';
import { createBetaHardenedCapabilityRegistry } from '../../capabilities/beta-hardened';
import { validateCapabilityCandidate } from '../../capabilities/candidate-validator';
import { SAFE_FACT_REGISTRY_V2, TAINTED_RULE_SINK_CLASSES_V1 } from '../../facts/safe-fact-registry';
import { scanWorkflowV2 } from '../../v2/index';
import { compileFixture, dormantScan, encode, profile, publicScan, variants, workflowFor } from './scan-local-sink-models-test-support';

describe('source-bound terminal sink variants through the actual producer', () => {
  for (const variant of variants) for (const version of variant.versions) {
    it(`${variant.name} exact version ${version} publishes real bound evidence`, () => {
      const workflow = workflowFor(variant, version);
      const result = publicScan(workflow);
      const summary = result.facts.find((fact) => fact.kind === 'dataflow.summary.v3');
      const provenance = result.facts.find((fact) => fact.kind === 'dataflow.provenance.v1');
      expect(result.analysis.status).toBe('COMPLETE');
      expect(summary?.properties).toMatchObject({ sinkClass: variant.sinkClass,
        sinkParameterPath: `/${variant.parameter}`, sinkFieldPath: [variant.parameter], knowledge: 'KNOWN',
        sourceFieldPath: ['body', variant.sinkClass === 'COMMAND' ? 'cmd' : 'selected'],
        taintChannel: 'CONFIDENTIALITY', sinkChannel: 'DATA', edgeChannel: 'DATA',
        sourceProvenanceFactId: provenance?.factId });
      const trace = result.traces.find((item) => item.kind === 'CONFIDENTIALITY');
      expect(trace?.steps.map((step) => step.kind)).toEqual(['SOURCE', 'SINK']);
      expect(trace?.steps[1]?.factRefs).toEqual([summary?.factId]);
      expect(trace?.steps[1]?.subject).toMatchObject({ kind: 'NODE', node: { ordinal: 1,
        source: { pointer: '/nodes/1' } } });
      expect(validateFieldFlowWitnessesV1(result.facts, result.findings, result.traces)).toBe(true);
      const model = compileFixture(workflow);
      expect(model.model.status).toBe('SUPPORTED');
      expect(model.used()).toBeGreaterThan(0);
      if (model.model.status !== 'SUPPORTED') throw new Error('missing model');
      const sink = model.workflow.nodes[1]!;
      const request = model.model.witness.requests[0]!;
      expect(request.terminalInputRead?.carrier).toBe(model.model.witness.carriers.get(sink.ref.identityDigest));
      expect(sink.parameters.find((field) => field.pointer.endsWith(`/${variant.parameter}`))?.occurrences[0]?.span).not.toBeNull();
    });
  }

  it.each(variants)('$name reaches the dormant candidate without synthesizing legacy v3 facts', (variant) => {
    const result = dormantScan(workflowFor(variant));
    const candidate = result.byCapability.get('taint-integrity')!;
    const ruleId = Object.keys(TAINTED_RULE_SINK_CLASSES_V1).find((rule) => TAINTED_RULE_SINK_CLASSES_V1[rule] === variant.sinkClass);
    expect(candidate.findings).toHaveLength(1);
    expect(candidate.findings[0]).toMatchObject({ ruleId, conclusion: 'OBSERVED', evidenceClass: 'POTENTIAL_DATAFLOW' });
    expect(validateFieldFlowCoherenceV1(candidate.facts, 'taint-integrity')).toBe(true);
    expect(validateFieldFlowWitnessesV1(candidate.facts, candidate.findings, candidate.traces)).toBe(true);
    const spec = createBetaHardenedCapabilityRegistry().get('taint-integrity')!;
    const rules = new Map(spec.ruleIds.map((id) => [id, result.context.rules.rules.get(id)!]));
    expect(validateCapabilityCandidate(candidate, spec, { facts: SAFE_FACT_REGISTRY_V2, rules },
      result.context.limits, result.context.workflow.nodes.length)).toMatchObject({ ok: true });
  });

  it.each(variants)('$name remains deterministic, redacted and bounded', (variant) => {
    const workflow = workflowFor(variant);
    expect(JSON.stringify(publicScan(workflow))).toBe(JSON.stringify(publicScan(workflow)));
    const limited = publicScan(workflow, 1);
    expect(limited.analysis.diagnostics.find((item) => item.code === 'GRAPH_ANALYSIS_DEGRADED')?.omitted).toBeGreaterThan(0);
    expect(limited.facts.some((fact) => fact.kind === 'dataflow.summary.v3')).toBe(false);
    const result = publicScan(workflow);
    const evidence = { facts: result.facts.filter((fact) => fact.kind.startsWith('dataflow.')), traces: result.traces };
    expect(JSON.stringify(evidence)).not.toContain('$json');
    expect(result.stats.omittedFindings).toBe(0);
  });

  it('keeps public hardened admission closed', () => {
    const result = scanWorkflowV2({ bytes: encode(workflowFor(variants[1])), profile: { ...profile, id: 'beta-hardened' } });
    expect(result).toMatchObject({ ok: false, code: 'PROFILE_NOT_ADMITTED' });
  });
});
