import type { ScanFinding, ScanPolicy } from '../policy/policy';
import { createBetaDefaultPolicies } from '../policies/beta-policies';
import { analyzeWorkflowInsights } from '../scan-insights';
import { reviewedInertOrdinals, structureFactProperties, summarizeStructure } from '../analyzers/intelligence/structure';
import { summarizeDependencies } from '../analyzers/intelligence/dependencies';
import { summarizeConfiguredEffects } from '../analyzers/intelligence/configured-effects';
import type { AnalysisDiagnosticV2 } from '../diagnostics/registry';
import { toNativeWorkflow } from './adapter-workflow';
import { adaptDiagnostic, candidateFinding, createDiagnostic, emptyCandidate, makeFact, policyFailureDiagnostic, unknownRuleDiagnostic, admitCandidate } from './adapter-evidence';
import { scheduleCapabilities, type AnalyzerContextV2, type CapabilityCandidateV2, type CapabilityRegistryV2, type CapabilityScheduleV2, type CapabilitySpecV2, type FindingCandidateV2, type SafeFactV2 } from './scheduler';
import { BETA_DEFAULT_PROFILE_MANIFEST, type ProfileCapabilityV2, type ProfileManifestV2 } from './profile-manifest';
import type { SecurityNodeV2 } from '../workflow-v2/security-workflow';

export type BetaDefaultAdapterOptions = Readonly<{ policies?: readonly ScanPolicy[]; maxFindings?: number }>;

export function createBetaDefaultCapabilityRegistry(options: BetaDefaultAdapterOptions = {}): CapabilityRegistryV2 {
  const policies = options.policies ?? createBetaDefaultPolicies();
  const specs = BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map((capability): readonly [string, CapabilitySpecV2] => [capability.id, {
    ...capability,
    run: capability.id === 'source-normalization' ? (context) => sourceCandidate(context) : capability.id === 'workflow-insights' ? (context) => insightCandidate(context) : capability.id === 'structural-policies' ? (context) => structuralCandidate(context, capability, policies, options.maxFindings) : () => emptyCandidate(1),
  }]);
  return new Map(specs);
}

export function scanCapabilitiesV2(context: AnalyzerContextV2, profile: ProfileManifestV2 = BETA_DEFAULT_PROFILE_MANIFEST, registry: CapabilityRegistryV2 = createBetaDefaultCapabilityRegistry()): CapabilityScheduleV2 {
  return scheduleCapabilities(context, profile, registry);
}

function sourceCandidate(context: AnalyzerContextV2): CapabilityCandidateV2 {
  const fact = makeFact('workflow.fingerprint.v1', { kind: 'WORKFLOW' }, { value: context.source.rawSha256 });
  return admitCandidate({ findings: [], diagnostics: [], facts: [fact], traces: [], seen: 1, analyzed: 1, skipped: 0, omitted: 0 });
}

function insightCandidate(context: AnalyzerContextV2): CapabilityCandidateV2 {
  const workflow = toNativeWorkflow(context); const insights = analyzeWorkflowInsights(workflow); const facts: SafeFactV2[] = [];
  const subject = { kind: 'WORKFLOW' as const };
  facts.push(makeFact('workflow.summary.v1', subject, { connectionCount: insights.workflow.connectionCount }));
  facts.push(makeFact('workflow.function.v1', subject, { basicPurpose: insights.functionSummary.basicPurpose, triggerDescription: insights.functionSummary.triggerDescription, dataFlowSummary: insights.functionSummary.dataFlowSummary, businessCategory: insights.functionSummary.businessCategory, confidence: insights.functionSummary.confidence }));
  for (const integration of insights.integrations) facts.push(makeFact('integration.v1', subject, { service: integration.service, usage: integration.usage, nodeTypes: integration.nodeTypes, nodeCount: integration.nodeCount, riskNotes: integration.riskNotes }));
  return admitCandidate({ findings: [], diagnostics: [], facts, traces: [], seen: 1, analyzed: 1, skipped: 0, omitted: 0 });
}

function structuralCandidate(context: AnalyzerContextV2, capability: ProfileCapabilityV2, policies: readonly ScanPolicy[], maxFindings?: number): CapabilityCandidateV2 {
  const workflow = toNativeWorkflow(context);
  const semantics = context.semantics.resolvedNodeSemantics;
  const baseFacts: SafeFactV2[] = [
    makeFact('workflow.structure.v1', { kind: 'WORKFLOW' }, structureFactProperties(summarizeStructure({ nodes: context.workflow.nodes, edges: context.workflow.edges, inertOrdinals: reviewedInertOrdinals(context.workflow) }))),
    makeFact('workflow.dependencies.v1', { kind: 'WORKFLOW' }, summarizeDependencies({ workflow: context.workflow, semantics })),
    makeFact('workflow.effects.v1', { kind: 'WORKFLOW' }, summarizeConfiguredEffects({ workflow: context.workflow, semantics })),
  ];
  const baseIds = new Set(baseFacts.map((fact) => fact.factId));
  const facts: SafeFactV2[] = [...baseFacts]; const findings: FindingCandidateV2[] = []; const diagnostics = []; let omitted = 0;
  for (const policy of policies) {
    let produced: readonly ScanFinding[];
    try {
      produced = policy.evaluate(workflow);
      for (const diagnostic of policy.diagnose?.(workflow) ?? []) diagnostics.push(adaptDiagnostic(diagnostic, context, capability));
    } catch { diagnostics.push(policyFailureDiagnostic(capability)); omitted += 1; continue; }
    for (const finding of produced) {
      const node = findNode(context.workflow.nodes, finding.location.nodeId, finding.location.nodeName);
      if (!node) { diagnostics.push(unknownRuleDiagnostic(capability)); omitted += 1; continue; }
      const candidate = candidateFinding(finding, node, context, capability, facts);
      if (candidate) findings.push(candidate); else { diagnostics.push(unknownRuleDiagnostic(capability)); omitted += 1; }
    }
  }
  const cap = maxFindings === undefined ? findings.length : Math.max(0, Math.min(maxFindings, findings.length));
  if (cap < findings.length) { omitted += findings.length - cap; diagnostics.push(createDiagnostic('REQUIRED_LIMIT_EXCEEDED', capability.id, capability.required, undefined, { observed: findings.length, maximum: cap, omitted: findings.length - cap })); }
  const kept = findings.slice(0, cap); const refs = new Set(kept.flatMap((finding) => finding.factRefs));
  return admitCandidate({ findings: kept, diagnostics: uniqueDiagnostics(diagnostics), facts: facts.filter((fact) => baseIds.has(fact.factId) || refs.has(fact.factId)), traces: [], seen: workflow.nodes.length, analyzed: workflow.nodes.length, skipped: 0, omitted });
}

function findNode(nodes: readonly SecurityNodeV2[], id: string | undefined, name: string | undefined): SecurityNodeV2 | undefined {
  if (id === undefined && name === undefined) return undefined;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]; if (node && (id === undefined || node.ref.explicitId === id) && (name === undefined || node.ref.name === name)) return node;
  }
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]; if (node && ((id !== undefined && node.ref.explicitId === id) || (name !== undefined && node.ref.name === name))) return node;
  }
  return undefined;
}

function uniqueDiagnostics(diagnostics: readonly AnalysisDiagnosticV2[]): AnalysisDiagnosticV2[] {
  const seen = new Set<string>(); return diagnostics.filter((diagnostic) => seen.has(diagnostic.id) ? false : (seen.add(diagnostic.id), true));
}

export const BETA_DEFAULT_CAPABILITY_REGISTRY = createBetaDefaultCapabilityRegistry();
