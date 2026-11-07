import type { FindingCandidateV2, SafeFactV2, SafeFactValueV2, TraceV2 } from './scanner-v2-evidence';
import type { SubjectV2 } from './scanner-v2-source';
import { FIELD_FLOW_ENUMS_V1 as ENUMS, isFieldFlowFactKindV1 } from './scanner-v2-field-flow';

/**
 * Relationship checks only. Every fact reaching this helper has already passed
 * kind, schema and subject validation; hashes, enums and per-property rules are
 * not re-validated here. The helper never filters, deduplicates or mutates its
 * input, so safe unreferenced origins and zero-flow coverage stay acceptable.
 */

const PROVENANCE_KIND = 'dataflow.provenance.v1';
const SUMMARY_KIND = 'dataflow.summary.v3';
const COVERAGE_KIND = 'dataflow.coverage.v1';
const ORIGIN_KEYS = ['sourceNodeOrdinal', 'sourceNodeDigest', 'sourceFieldPath', 'taintChannel', 'taintLabels'] as const;

type Properties = Readonly<Record<string, SafeFactValueV2>>;
type ScopeIndex = {
  provenance: ReadonlyMap<string, Properties>;
  coverage: ReadonlyMap<string, Properties>;
  coverageCount: number;
  coverageProperties: Properties | undefined;
};

/** Strict origin equality: element-for-element paths/labels, never set overlap. */
function sameOrigin(origin: Properties, summary: Properties): boolean {
  return ORIGIN_KEYS.every((key) => {
    if (!Object.hasOwn(origin, key) || !Object.hasOwn(summary, key)) return false;
    const left = origin[key];
    const right = summary[key];
    if (Array.isArray(left) && Array.isArray(right)) {
      return left.length === right.length && left.every((item, index) => item === right[index]);
    }
    return !Array.isArray(left) && !Array.isArray(right) && left === right;
  });
}

/** One linear index pass: provenance identities and coverage capability identities. */
function indexScope(facts: readonly SafeFactV2[]): ScopeIndex | undefined {
  const provenance = new Map<string, Properties>();
  const coverage = new Map<string, Properties>();
  let coverageCount = 0;
  let coverageProperties: Properties | undefined;
  for (const fact of facts) {
    if (!isFieldFlowFactKindV1(fact.kind)) continue;
    if (fact.kind === PROVENANCE_KIND) {
      // Duplicate provenance IDs fail even when the records are byte-identical.
      if (provenance.has(fact.factId)) return undefined;
      provenance.set(fact.factId, fact.properties);
    } else if (fact.kind === COVERAGE_KIND) {
      const capabilityId = fact.properties.capabilityId;
      if (typeof capabilityId !== 'string' || coverage.has(capabilityId)) return undefined;
      coverage.set(capabilityId, fact.properties);
      coverageCount += 1;
      coverageProperties = fact.properties;
    }
  }
  return { provenance, coverage, coverageCount, coverageProperties };
}

function hasCoveredChannel(channel: SafeFactValueV2, coverage: ReadonlyMap<string, Properties>): boolean {
  // The global reader does not infer an absent candidate's capability ownership.
  if (coverage.size === 0) return true;
  if (typeof channel !== 'string') return false;
  for (const properties of coverage.values()) {
    if (Array.isArray(properties.taintChannels) && properties.taintChannels.includes(channel)) return true;
  }
  return false;
}

/** Each summary must resolve to exactly one provenance fact and reproduce its origin half. */
function countCoherentSummaries(facts: readonly SafeFactV2[], scope: ScopeIndex, scopedCoverage: boolean): number | undefined {
  let summaries = 0;
  for (const fact of facts) {
    if (fact.kind !== SUMMARY_KIND) continue;
    summaries += 1;
    const reference = fact.properties.sourceProvenanceFactId;
    if (typeof reference !== 'string') return undefined;
    const origin = scope.provenance.get(reference);
    if (origin === undefined || !sameOrigin(origin, fact.properties)) return undefined;
    if (scopedCoverage && !hasCoveredChannel(fact.properties.taintChannel, scope.coverage)) return undefined;
  }
  return summaries;
}

export function validateFieldFlowCoherenceV1(facts: readonly SafeFactV2[], capabilityId?: string): boolean {
  try {
    if (!Array.isArray(facts)) return false;
    const scope = indexScope(facts);
    if (scope === undefined) return false;
    const scopedCoverage = typeof capabilityId === 'string' && (ENUMS.fieldFlowCapability as readonly string[]).includes(capabilityId);
    const summaries = countCoherentSummaries(facts, scope, scopedCoverage);
    if (summaries === undefined) return false;
    // Global reads have no candidate ownership: do not attribute coverage or recount deduplicated summaries.
    if (!scopedCoverage) return true;
    // Exactly one coverage fact total, and it must own the attempted taint capability.
    if (scope.coverageCount !== 1) return false;
    const coverage = scope.coverageProperties;
    if (coverage === undefined || coverage.capabilityId !== capabilityId) return false;
    const emittedFlows = coverage.emittedFlows;
    return typeof emittedFlows === 'number' && Number.isSafeInteger(emittedFlows) && emittedFlows === summaries;
  } catch { return false; }
}

function sameNode(left: SubjectV2, right: SubjectV2): boolean {
  return left.kind === 'NODE' && right.kind === 'NODE'
    && left.node.ordinal === right.node.ordinal && left.node.identityDigest === right.node.identityDigest;
}

/** Index each trace by its own endpoint facts, never by every fact owned by a finding. */
function supportedSummaries(trace: TraceV2, facts: ReadonlyMap<string, SafeFactV2>): ReadonlySet<string> {
  const supported = new Set<string>();
  if (trace.steps.length < 2) return supported;
  const source = trace.steps[0];
  const sink = trace.steps[trace.steps.length - 1];
  if (source.kind !== 'SOURCE' || sink.kind !== 'SINK') return supported;
  const sourceFacts = new Set(source.factRefs);
  const channel = trace.kind;
  for (const reference of sink.factRefs) {
    const summary = facts.get(reference);
    if (summary?.kind !== SUMMARY_KIND || summary.properties.taintChannel !== channel) continue;
    const originReference = summary.properties.sourceProvenanceFactId;
    const origin = typeof originReference === 'string' ? facts.get(originReference) : undefined;
    if (origin?.kind === PROVENANCE_KIND && sourceFacts.has(origin.factId)
      && sameNode(source.subject, origin.subject) && sameNode(sink.subject, summary.subject)) supported.add(summary.factId);
  }
  return supported;
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size > right.size) return intersects(right, left);
  for (const reference of left) if (right.has(reference)) return true;
  return false;
}

/** Channel/endpoint binding only; callers have already validated shapes and references. */
export function validateFieldFlowWitnessesV1(
  facts: readonly SafeFactV2[],
  findings: readonly FindingCandidateV2[],
  traces: readonly TraceV2[],
): boolean {
  try {
    if (!facts.some((fact) => fact.kind === SUMMARY_KIND)) return true;
    const factIndex = new Map<string, SafeFactV2>();
    for (const fact of facts) if (fact.kind === SUMMARY_KIND || fact.kind === PROVENANCE_KIND) factIndex.set(fact.factId, fact);
    const traceIndex = new Map<string, TraceV2>();
    for (const trace of traces) traceIndex.set(trace.traceId, trace);
    const supportIndex = new Map<string, ReadonlySet<string>>();
    for (const finding of findings) {
      const summaries = new Set<string>();
      for (const reference of finding.factRefs) {
        const fact = factIndex.get(reference);
        if (fact?.kind !== SUMMARY_KIND) continue;
        if (!sameNode(finding.subject, fact.subject)) return false;
        summaries.add(fact.factId);
      }
      if (summaries.size === 0) continue;
      for (const reference of finding.traceRefs) {
        const trace = traceIndex.get(reference);
        if (trace === undefined) return false;
        let supported = supportIndex.get(reference);
        if (supported === undefined) {
          supported = supportedSummaries(trace, factIndex);
          supportIndex.set(reference, supported);
        }
        if (!intersects(summaries, supported)) return false;
      }
    }
    return true;
  } catch { return false; }
}
