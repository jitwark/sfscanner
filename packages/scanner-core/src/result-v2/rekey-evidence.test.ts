import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SafeFactV2 } from '../../../../contracts/scanner-v2-evidence';
import type { CapabilityCandidateV2 } from '../capabilities/scheduler';
import { canonicalizeJson } from '../canonical-json';
import { canonicalSafeFactSubjectIdentity } from '../facts/safe-fact-validator';
import { encodeIdentityTuple } from '../workflow-v2/node-edge-identity';
import { createCandidateTraceId, createFactId, createTraceId } from './identities';
import { rekeyCandidates, rekeyFacts } from './rekey-evidence';
import vectors from '../../../../contracts/__fixtures__/Q04-FIELD-FACT-VECTORS.json';

const semanticSha256 = 'c'.repeat(64);
const hash = (parts: readonly string[]) => bytesToHex(sha256(new TextEncoder().encode(encodeIdentityTuple(parts))));
function candidate(): CapabilityCandidateV2 {
  const records: SafeFactV2[] = JSON.parse(JSON.stringify(vectors.facts));
  const facts = records.map((fact) => ({ ...fact, factId: hash(['secureflow-fact-id-v2', fact.kind, canonicalSafeFactSubjectIdentity(fact.subject), canonicalizeJson(fact.properties)]) }));
  const coverage = facts.find((fact) => fact.kind === 'dataflow.coverage.v1')!;
  const steps = [{ ordinal: 0, kind: 'SOURCE' as const, subject: { kind: 'WORKFLOW' as const }, factRefs: [coverage.factId] }];
  const traceId = createCandidateTraceId({ kind: 'CONFIDENTIALITY', steps });
  return {
    facts, traces: [{ traceId, kind: 'CONFIDENTIALITY', steps }], diagnostics: [],
    findings: [{ ruleId: 'TAINTED_SQL_QUERY', evidenceClass: 'POTENTIAL_DATAFLOW', conclusion: 'OBSERVED', applicability: 'APPLICABLE', subject: { kind: 'WORKFLOW' }, factRefs: facts.map((fact) => fact.factId).sort(), traceRefs: [traceId], remediationId: 'r' }],
    seen: 0, analyzed: 0, skipped: 0, omitted: 0,
  };
}

describe('admitted evidence final identity rekey', () => {
  it('binds workflow facts, embedded provenance and all finding and trace references regardless of fact order', () => {
    const original = candidate();
    const reversed = { ...original, facts: [...original.facts].reverse() };
    const [result] = rekeyCandidates([reversed], semanticSha256);
    const byKind = new Map(result.facts.map((fact) => [fact.kind, fact]));
    const provenance = byKind.get('dataflow.provenance.v1')!;
    const summary = byKind.get('dataflow.summary.v3')!;
    const coverage = byKind.get('dataflow.coverage.v1')!;
    const oldCoverage = original.facts.find((fact) => fact.kind === coverage.kind)!;
    expect(coverage.factId).not.toBe(oldCoverage.factId);
    expect(summary.properties.sourceProvenanceFactId).toBe(provenance.factId);
    expect(provenance.factId).toBe(original.facts.find((fact) => fact.kind === provenance.kind)!.factId);
    expect(summary.factId).toBe(original.facts.find((fact) => fact.kind === summary.kind)!.factId);
    for (const fact of result.facts) expect(fact.factId).toBe(createFactId(fact, { semanticSha256 }));
    expect(result.findings[0].factRefs).toEqual(result.facts.map((fact) => fact.factId).sort());
    expect(result.traces[0].steps[0].factRefs).toEqual([coverage.factId]);
    expect(result.traces[0].traceId).toBe(createTraceId(result.traces[0], { semanticSha256 }));
    expect(result.findings[0].traceRefs).toEqual([result.traces[0].traceId]);
    expect(original.facts.find((fact) => fact.kind === coverage.kind)!.factId).toBe(oldCoverage.factId);
    expect(original.traces[0].steps[0].factRefs).toEqual([oldCoverage.factId]);
    const [ordered] = rekeyCandidates([original], semanticSha256);
    expect([...ordered.facts].sort((a, b) => a.factId.localeCompare(b.factId))).toEqual([...result.facts].sort((a, b) => a.factId.localeCompare(b.factId)));
    expect(ordered.findings).toEqual(result.findings);
    expect(ordered.traces).toEqual(result.traces);
  });

  it('rekeys standalone fact sets without dropping zero-flow coverage or unreferenced provenance', () => {
    const original = candidate().facts.filter((fact) => fact.kind !== 'dataflow.summary.v3').map((fact) => {
      const properties = fact.kind === 'dataflow.coverage.v1'
        ? { ...fact.properties, knownEmptyFields: 2, positiveFields: 0, emittedFlows: 0 }
        : fact.properties;
      const factId = hash(['secureflow-fact-id-v2', fact.kind, canonicalSafeFactSubjectIdentity(fact.subject), canonicalizeJson(properties)]);
      return { ...fact, properties, factId };
    });
    const result = rekeyFacts(original, semanticSha256);
    expect(result.map((fact) => fact.kind).sort()).toEqual(['dataflow.coverage.v1', 'dataflow.provenance.v1']);
    expect(result.find((fact) => fact.kind === 'dataflow.coverage.v1')!.properties.emittedFlows).toBe(0);
    for (const fact of result) expect(fact.factId).toBe(createFactId(fact, { semanticSha256 }));
  });

  it.each(['provenance', 'step', 'findingFact', 'findingTrace'] as const)('refuses an unresolved %s reference rather than preserving an old identifier', (where) => {
    const original = candidate();
    const missing = 'f'.repeat(64);
    const broken: CapabilityCandidateV2 = {
      ...original,
      facts: where === 'provenance' ? original.facts.map((fact) => fact.kind === 'dataflow.summary.v3' ? { ...fact, properties: { ...fact.properties, sourceProvenanceFactId: missing } } : fact) : original.facts,
      traces: where === 'step' ? original.traces.map((trace) => ({ ...trace, steps: trace.steps.map((step) => ({ ...step, factRefs: [missing] })) })) : original.traces,
      findings: original.findings.map((finding) => ({ ...finding, factRefs: where === 'findingFact' ? [missing] : finding.factRefs, traceRefs: where === 'findingTrace' ? [missing] : finding.traceRefs })),
    };
    expect(() => rekeyCandidates([broken], semanticSha256)).toThrow(TypeError);
  });
});
