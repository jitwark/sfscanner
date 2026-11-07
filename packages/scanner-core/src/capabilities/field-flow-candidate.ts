import type { FieldFlowAccessorV1, FlowWitnessAnalysisV2 } from '../analyzers/taint/scan-local-workflow-flow-witnesses';
import type { AnalysisDiagnosticV2 } from '../diagnostics/registry';
import { TAINTED_RULE_SINK_CLASSES_V1 } from '../facts/safe-fact-registry';
import { admitCandidate, createDiagnostic } from './adapter-evidence';
import type { ProfileCapabilityV2 } from './profile-manifest';
import type { AnalyzerContextV2, CapabilityCandidateV2, FindingCandidateV2, SafeFactV2, TraceV2 } from './scheduler';
import { createCandidateFactId } from '../result-v2/identities';

type MappedRule = Readonly<{ ruleId: string; remediationId: string }>;

function diagnosticCounts(value: AnalysisDiagnosticV2): Pick<AnalysisDiagnosticV2, 'observed' | 'maximum' | 'omitted'> | undefined {
  if (value.observed === undefined && value.maximum === undefined && value.omitted === undefined) return undefined;
  return { ...(value.observed === undefined ? {} : { observed: value.observed }),
    ...(value.maximum === undefined ? {} : { maximum: value.maximum }),
    ...(value.omitted === undefined ? {} : { omitted: value.omitted }) };
}

function rehomeDiagnostics(analysis: FlowWitnessAnalysisV2, capability: ProfileCapabilityV2): AnalysisDiagnosticV2[] {
  const output: AnalysisDiagnosticV2[] = analysis.diagnostics.map((value) => createDiagnostic(value.code,
    capability.id, capability.required, value.location, diagnosticCounts(value)));
  if (analysis.status !== 'COMPLETE' && output.length === 0) output.push(createDiagnostic(
    'GRAPH_ANALYSIS_DEGRADED', capability.id, capability.required, undefined, { omitted: 1 }));
  return output;
}

function failure(context: AnalyzerContextV2, capability: ProfileCapabilityV2, code: 'DEPENDENCY_UNAVAILABLE' | 'GRAPH_ANALYSIS_DEGRADED'): CapabilityCandidateV2 {
  const seen = context.workflow.nodes.length;
  return admitCandidate({ findings: [], facts: [], traces: [],
    diagnostics: [createDiagnostic(code, capability.id, capability.required, undefined, { omitted: 1 })],
    seen, analyzed: seen, skipped: 0, omitted: 1 });
}

function mappedRule(context: AnalyzerContextV2, capability: ProfileCapabilityV2, sinkClass: unknown): MappedRule | undefined {
  if (typeof sinkClass !== 'string') return undefined;
  const ruleId = Object.keys(TAINTED_RULE_SINK_CLASSES_V1).find((id) => TAINTED_RULE_SINK_CLASSES_V1[id] === sinkClass);
  if (ruleId === undefined || !capability.ruleIds.includes(ruleId)) return undefined;
  const rule = context.rules.rules.get(ruleId);
  if (rule === undefined || rule.capabilityId !== capability.id || rule.evidenceSchemaId !== 'v1.taint') return undefined;
  return { ruleId, remediationId: rule.remediationId };
}

function provenanceFor(summary: SafeFactV2, facts: readonly SafeFactV2[]): SafeFactV2 | undefined {
  const reference = summary.properties.sourceProvenanceFactId;
  return typeof reference === 'string' ? facts.find((fact) => fact.kind === 'dataflow.provenance.v1' && fact.factId === reference) : undefined;
}

function sameNode(left: SafeFactV2['subject'], right: SafeFactV2['subject']): boolean {
  return left.kind === 'NODE' && right.kind === 'NODE'
    && left.node.ordinal === right.node.ordinal && left.node.identityDigest === right.node.identityDigest;
}

function supportingTrace(summary: SafeFactV2, provenance: SafeFactV2, traces: readonly TraceV2[]): TraceV2 | undefined {
  const channel = summary.properties.taintChannel;
  return traces.find((trace) => {
    const source = trace.steps[0], sink = trace.steps[trace.steps.length - 1];
    return trace.kind === channel && source?.kind === 'SOURCE' && sink?.kind === 'SINK'
      && source.factRefs.includes(provenance.factId) && sink.factRefs.includes(summary.factId)
      && sameNode(source.subject, provenance.subject) && sameNode(sink.subject, summary.subject);
  });
}

function findingFor(summary: SafeFactV2, rule: MappedRule, trace: TraceV2): FindingCandidateV2 {
  return { ruleId: rule.ruleId, evidenceClass: 'POTENTIAL_DATAFLOW',
    conclusion: summary.properties.knowledge === 'UNKNOWN' ? 'UNKNOWN' : 'OBSERVED',
    applicability: 'APPLICABLE', subject: summary.subject, factRefs: Object.freeze([summary.factId]),
    traceRefs: Object.freeze([trace.traceId]), remediationId: rule.remediationId };
}

export function fieldFlowCandidate(context: AnalyzerContextV2, capability: ProfileCapabilityV2,
  getFieldFlow?: FieldFlowAccessorV1): CapabilityCandidateV2 {
  if (getFieldFlow === undefined) return failure(context, capability, 'DEPENDENCY_UNAVAILABLE');
  let analysis: FlowWitnessAnalysisV2;
  try { analysis = getFieldFlow(); } catch { return failure(context, capability, 'GRAPH_ANALYSIS_DEGRADED'); }
  const facts = analysis.facts.map((fact): SafeFactV2 => fact.subject.kind === 'WORKFLOW'
    ? Object.freeze({ ...fact, factId: createCandidateFactId(fact) }) : fact);
  const diagnostics = rehomeDiagnostics(analysis, capability);
  const findings: FindingCandidateV2[] = [];
  const traces: TraceV2[] = [];
  let mappingOmissions = 0;
  for (const fact of facts) {
    if (fact.kind !== 'dataflow.summary.v3') continue;
    const provenance = provenanceFor(fact, facts);
    const rule = mappedRule(context, capability, fact.properties.sinkClass);
    const trace = provenance === undefined ? undefined : supportingTrace(fact, provenance, analysis.traces);
    if (provenance === undefined || rule === undefined || trace === undefined) { mappingOmissions += 1; continue; }
    findings.push(findingFor(fact, rule, trace));
    if (!traces.some((item) => item.traceId === trace.traceId)) traces.push(trace);
  }
  if (mappingOmissions > 0) diagnostics.push(createDiagnostic('GRAPH_ANALYSIS_DEGRADED',
    capability.id, capability.required, undefined, { omitted: mappingOmissions }));
  const omitted = diagnostics.reduce((sum, item) => sum + (item.omitted ?? 0), 0);
  const seen = context.workflow.nodes.length;
  return admitCandidate({ findings, diagnostics, facts, traces,
    seen, analyzed: seen, skipped: 0, omitted });
}
