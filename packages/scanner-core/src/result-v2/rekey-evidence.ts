import type { SafeFactV2 } from '../../../../contracts/scanner-v2-evidence';
import type { CapabilityCandidateV2 } from '../capabilities/scheduler';
import { createFactId, createTraceId } from './identities';

function requiredReference(reference: unknown, identities: ReadonlyMap<string, string>): string {
  const resolved = typeof reference === 'string' ? identities.get(reference) : undefined;
  if (resolved === undefined) throw new TypeError('Unresolved evidence reference');
  return resolved;
}

function references(values: readonly string[], identities: ReadonlyMap<string, string>): readonly string[] {
  return Object.freeze(values.map((reference) => requiredReference(reference, identities)).sort());
}

// Input is already admitted. Resolve provenance before summaries, independent of fact order;
// each final identity is computed once, after its embedded identities are final.
function factSet(facts: readonly SafeFactV2[], semanticSha256: string) {
  const identities = new Map<string, string>();
  const context = { semanticSha256 };
  for (const fact of facts) {
    if (fact.kind !== 'dataflow.summary.v3') identities.set(fact.factId, createFactId(fact, context));
  }
  const output = facts.map((fact): SafeFactV2 => {
    if (fact.kind !== 'dataflow.summary.v3') {
      return Object.freeze({ ...fact, factId: requiredReference(fact.factId, identities) });
    }
    const properties = Object.freeze({
      ...fact.properties,
      sourceProvenanceFactId: requiredReference(fact.properties.sourceProvenanceFactId, identities),
    });
    const updated = { ...fact, properties };
    const factId = createFactId(updated, context);
    identities.set(fact.factId, factId);
    return Object.freeze({ ...updated, factId });
  });
  return { facts: Object.freeze(output), identities };
}

export function rekeyFacts(facts: readonly SafeFactV2[], semanticSha256: string): readonly SafeFactV2[] {
  return factSet(facts, semanticSha256).facts;
}

export function rekeyCandidates(candidates: readonly CapabilityCandidateV2[], semanticSha256: string): readonly CapabilityCandidateV2[] {
  return Object.freeze(candidates.map((candidate) => {
    const { facts, identities: factIds } = factSet(candidate.facts, semanticSha256);
    const traceIds = new Map<string, string>();
    const traces = candidate.traces.map((trace) => {
      const steps = Object.freeze(trace.steps.map((step) => Object.freeze({
        ...step, factRefs: references(step.factRefs, factIds),
      })));
      const traceId = createTraceId({ kind: trace.kind, steps }, { semanticSha256 });
      traceIds.set(trace.traceId, traceId);
      return Object.freeze({ ...trace, traceId, steps });
    });
    const findings = candidate.findings.map((finding) => Object.freeze({
      ...finding,
      factRefs: references(finding.factRefs, factIds),
      traceRefs: references(finding.traceRefs, traceIds),
    }));
    return Object.freeze({ ...candidate, facts, traces: Object.freeze(traces), findings: Object.freeze(findings) });
  }));
}
