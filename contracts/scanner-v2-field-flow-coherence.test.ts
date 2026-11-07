import { describe, expect, it } from 'vitest';
import vectors from '../docs/superpowers/plans/2026-10-21-scanner-deepseek/Q04-FIELD-FACT-VECTORS.json';
import type { FindingCandidateV2, SafeFactV2, SafeFactValueV2, TraceV2 } from './scanner-v2-evidence';
import { validateFieldFlowCoherenceV1, validateFieldFlowWitnessesV1 } from './scanner-v2-field-flow-coherence';

const fresh = (): SafeFactV2[] => JSON.parse(JSON.stringify(vectors.facts));
const changed = (fact: SafeFactV2, properties: Readonly<Record<string, SafeFactValueV2>>): SafeFactV2 =>
  ({ ...fact, properties: { ...fact.properties, ...properties } });

describe('field-flow evidence coherence', () => {
  it('retains one origin referenced by both known and unknown sinks', () => {
    const [origin, known, coverage] = fresh();
    const unknown = changed({ ...known, factId: 'e'.repeat(64) }, { knowledge: 'UNKNOWN', unknownReasons: ['DYNAMIC_FIELD'], sinkFieldPath: ['other'] });
    const facts = [origin, known, unknown, changed(coverage, { emittedFlows: 2 })];
    expect(validateFieldFlowCoherenceV1(facts, 'taint-confidentiality')).toBe(true);
    expect(validateFieldFlowCoherenceV1([coverage, unknown, known, origin].map((fact) => fact === coverage ? changed(fact, { emittedFlows: 2 }) : fact))).toBe(true);
  });

  it('rejects unresolved, wrong-kind and multiply-defined provenance references', () => {
    const [origin, summary, coverage] = fresh();
    expect(validateFieldFlowCoherenceV1([summary, coverage])).toBe(false);
    expect(validateFieldFlowCoherenceV1([origin, changed(summary, { sourceProvenanceFactId: coverage.factId }), coverage])).toBe(false);
    expect(validateFieldFlowCoherenceV1([origin, origin, summary, coverage])).toBe(false);
  });

  it('requires exact source identity, whole path, channel and label equality', () => {
    const [origin, summary, coverage] = fresh();
    const changes: SafeFactV2['properties'][] = [
      { sourceNodeOrdinal: 1 }, { sourceNodeDigest: 'a'.repeat(64) },
      { sourceFieldPath: ['body', 'other'] }, { sourceFieldPath: ['body'] },
      { sourceFieldPath: ['cmd', 'body'] },
      { taintChannel: 'INTEGRITY', taintLabels: ['INBOUND_MESSAGE'] },
      { taintLabels: ['WEBHOOK_BODY', 'WEBHOOK_QUERY'] },
    ];
    for (const properties of changes) expect(validateFieldFlowCoherenceV1([origin, changed(summary, properties), coverage])).toBe(false);
  });

  it('requires exactly one coverage fact for the attempted taint capability', () => {
    const [origin, summary, coverage] = fresh();
    expect(validateFieldFlowCoherenceV1([origin, summary], 'taint-confidentiality')).toBe(false);
    expect(validateFieldFlowCoherenceV1([origin, summary, coverage], 'taint-integrity')).toBe(false);
    expect(validateFieldFlowCoherenceV1([origin, summary, coverage, { ...coverage, factId: 'f'.repeat(64) }], 'taint-confidentiality')).toBe(false);
    expect(validateFieldFlowCoherenceV1([origin, summary, coverage, { ...coverage, factId: 'f'.repeat(64) }])).toBe(false);
    expect(validateFieldFlowCoherenceV1([], 'taint-integrity')).toBe(false);
  });

  it('checks emitted-flow totals within each candidate rather than after result deduplication', () => {
    const [origin, summary, coverage] = fresh();
    expect(validateFieldFlowCoherenceV1([origin, summary, changed(coverage, { emittedFlows: 0 })], 'taint-confidentiality')).toBe(false);
    expect(validateFieldFlowCoherenceV1([origin, summary, summary, changed(coverage, { emittedFlows: 2 })], 'taint-confidentiality')).toBe(true);
    const otherCoverage = changed({ ...coverage, factId: 'f'.repeat(64) }, { capabilityId: 'taint-integrity', emittedFlows: 2 });
    expect(validateFieldFlowCoherenceV1([origin, summary, coverage, otherCoverage])).toBe(true);
  });

  it('requires coverage to acknowledge every emitted taint channel without collapsing capabilities', () => {
    const [origin, summary, coverage] = fresh();
    for (const taintChannels of [[], ['INTEGRITY']]) {
      const facts = [origin, summary, changed(coverage, { taintChannels })];
      expect(validateFieldFlowCoherenceV1(facts, 'taint-confidentiality')).toBe(false);
    }
    const integrityOrigin = changed({ ...origin, factId: 'e'.repeat(64) }, { taintChannel: 'INTEGRITY', taintLabels: ['INBOUND_MESSAGE'] });
    const integritySummary = changed({ ...summary, factId: 'f'.repeat(64) }, {
      sourceProvenanceFactId: integrityOrigin.factId, taintChannel: 'INTEGRITY', taintLabels: ['INBOUND_MESSAGE'],
    });
    const integrityCoverage = changed({ ...coverage, factId: 'd'.repeat(64) }, {
      capabilityId: 'taint-integrity', taintChannels: ['INTEGRITY'],
    });
    expect(validateFieldFlowCoherenceV1([origin, summary, coverage, integrityOrigin, integritySummary, integrityCoverage])).toBe(true);
    const integrityZero = changed(integrityCoverage, { emittedFlows: 0, positiveFields: 0 });
    expect(validateFieldFlowCoherenceV1([origin, summary], 'graph-semantics')).toBe(true);
    expect(validateFieldFlowCoherenceV1([origin, summary, integrityZero])).toBe(true);
  });

  it('retains zero-flow and failed coverage and safe unreferenced origins', () => {
    const [origin, , coverage] = fresh();
    const zero = changed(coverage, { emittedFlows: 0, positiveFields: 0 });
    expect(validateFieldFlowCoherenceV1([origin, zero], 'taint-confidentiality')).toBe(true);
    const failed = { ...zero, properties: Object.fromEntries(Object.entries(zero.properties).map(([key, value]) => [key, typeof value === 'number' ? 0 : key === 'coverageStatus' ? 'FAILED' : value])) };
    expect(validateFieldFlowCoherenceV1([failed], 'taint-confidentiality')).toBe(true);
    expect(validateFieldFlowCoherenceV1([])).toBe(true);
    expect(validateFieldFlowCoherenceV1([origin], 'graph-semantics')).toBe(true);
    expect(validateFieldFlowCoherenceV1([fresh()[1]], 'graph-semantics')).toBe(false);
  });

  it('fails closed for malformed runtime shapes without exposing exception text', () => {
    const [origin, summary, coverage] = fresh();
    for (const malformed of [null, {}, [null], [{ ...coverage, properties: null }], [{ ...origin, properties: null }, summary]]) {
      expect(validateFieldFlowCoherenceV1(malformed as unknown as readonly SafeFactV2[])).toBe(false);
    }
    expect(validateFieldFlowCoherenceV1([origin, changed(summary, { sourceProvenanceFactId: 17 })])).toBe(false);
    for (const emittedFlows of ['1', 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(validateFieldFlowCoherenceV1([origin, summary, changed(coverage, { emittedFlows })], 'taint-confidentiality')).toBe(false);
    }
  });
});

describe('field-flow witness bindings', () => {
  const fixture = () => {
    const [origin, summary, coverage] = fresh();
    const trace: TraceV2 = {
      traceId: '1'.repeat(64), kind: 'CONFIDENTIALITY',
      steps: [
        { ordinal: 0, kind: 'SOURCE', subject: origin.subject, factRefs: [origin.factId] },
        { ordinal: 1, kind: 'SINK', subject: summary.subject, factRefs: [summary.factId] },
      ],
    };
    const finding: FindingCandidateV2 = {
      ruleId: 'TAINTED_COMMAND', evidenceClass: 'POTENTIAL_DATAFLOW', conclusion: 'POTENTIAL',
      applicability: 'APPLICABLE', subject: summary.subject, factRefs: [summary.factId],
      traceRefs: [trace.traceId], remediationId: 'tainted-command',
    };
    return { facts: [origin, summary, coverage], finding, trace, origin, summary };
  };

  it('retains supported findings without witnesses and checks complete endpoint bindings', () => {
    const { facts, finding, trace } = fixture();
    expect(validateFieldFlowWitnessesV1(facts, [finding], [trace])).toBe(true);
    expect(validateFieldFlowWitnessesV1(facts, [{ ...finding, traceRefs: [] }], [])).toBe(true);
    for (const kind of ['INTEGRITY', 'CONTROL'] as const) {
      expect(validateFieldFlowWitnessesV1(facts, [finding], [{ ...trace, kind }])).toBe(false);
    }
  });

  it('rejects unrelated finding subjects, swapped endpoint subjects and unsupported endpoint references', () => {
    const { facts, finding, trace, origin, summary } = fixture();
    expect(validateFieldFlowWitnessesV1(facts, [{ ...finding, subject: origin.subject }], [trace])).toBe(false);
    const [source, sink] = trace.steps;
    for (const steps of [
      [{ ...source, subject: summary.subject }, sink],
      [source, { ...sink, subject: origin.subject }],
      [{ ...source, factRefs: [summary.factId] }, sink],
      [source, { ...sink, factRefs: [origin.factId] }],
      [{ ...source, kind: 'PROPAGATION' as const }, sink],
      [source, { ...sink, kind: 'PROPAGATION' as const }],
    ]) expect(validateFieldFlowWitnessesV1(facts, [finding], [{ ...trace, steps }])).toBe(false);
  });

  it('accepts complete same-node witnesses with overlapping endpoint facts', () => {
    const { facts, finding, trace, origin, summary } = fixture();
    const sameNodeSummary = { ...summary, subject: origin.subject };
    const refs = [origin.factId, summary.factId];
    const sameNodeTrace = { ...trace, steps: trace.steps.map((step) => ({ ...step, subject: origin.subject, factRefs: refs })) };
    expect(validateFieldFlowWitnessesV1([origin, sameNodeSummary, facts[2]], [{ ...finding, subject: origin.subject }], [sameNodeTrace])).toBe(true);
    for (const only of [origin.factId, summary.factId]) {
      const incomplete = { ...sameNodeTrace, steps: sameNodeTrace.steps.map((step) => ({ ...step, factRefs: [only] })) };
      expect(validateFieldFlowWitnessesV1([origin, sameNodeSummary, facts[2]], [{ ...finding, subject: origin.subject }], [incomplete])).toBe(false);
    }
  });

  it('bounds witness matching by endpoint references rather than multiplying all finding facts and traces', () => {
    const { finding, trace, origin, summary } = fixture();
    const count = 64;
    const summaries = Array.from({ length: count }, (_, index) => ({ ...summary, factId: index.toString(16).padStart(64, '0') }));
    let comparisons = 0;
    const traces = Array.from({ length: count }, (_, index) => new Proxy({
      ...trace, traceId: (index + count).toString(16).padStart(64, '0'),
      steps: [trace.steps[0], { ...trace.steps[1], factRefs: [summaries[count - 1].factId] }],
    }, {
      get(target, key, receiver) {
        if (key === 'kind') comparisons += 1;
        return Reflect.get(target, key, receiver);
      },
    }));
    const many = { ...finding, factRefs: summaries.map((fact) => fact.factId), traceRefs: traces.map((item) => item.traceId) };
    expect(validateFieldFlowWitnessesV1([origin, ...summaries], [many], traces)).toBe(true);
    expect(comparisons).toBeLessThanOrEqual(count * 4);
  });
});
