import { analyzeAiCapabilities } from '../analyzers/ai/ai-capability-analysis';
import { analyzeWorkflowJavaScript } from '../analyzers/code/javascript-analysis';
import { analyzeWorkflowPython } from '../analyzers/code/python-analysis';
import type { TaintAccessorV1, TaintOutcomeV1 } from '../analyzers/taint/scan-local-taint';
import type { FieldFlowAccessorV1 } from '../analyzers/taint/scan-local-workflow-flow-witnesses';
import { BETA_DEFAULT_CAPABILITY_REGISTRY, type BetaDefaultAdapterOptions } from './beta-default';
import { adaptDiagnostic, admitCandidate, candidateFacts, candidateFinding, createDiagnostic, emptyCandidate, unknownRuleDiagnostic } from './adapter-evidence';
import { fieldFlowCandidate } from './field-flow-candidate';
import { toNativeWorkflow } from './adapter-workflow';
import { scheduleCapabilities, type AnalyzerContextV2, type CapabilityCandidateV2, type CapabilityRegistryV2, type CapabilityScheduleV2, type CapabilitySpecV2, type FindingCandidateV2, type SafeFactV2, type TraceV2 } from './scheduler';
import { candidateTrace } from './candidate-trace';
import { BETA_HARDENED_PROFILE_MANIFEST, type ProfileCapabilityV2, type ProfileManifestV2 } from './profile-manifest';
import type { AnalysisDiagnostic as NativeAnalysisDiagnostic, ScanFinding } from '../policy/policy';
import type { AnalysisDiagnosticV2 } from '../diagnostics/registry';
import type { SecurityNodeV2 } from '../workflow-v2/security-workflow';

export type BetaHardenedAdapterOptions = Readonly<BetaDefaultAdapterOptions & {
  onRun?: () => void;
  getTaint?: TaintAccessorV1;
  getFieldFlow?: FieldFlowAccessorV1;
}>;

export function createBetaHardenedCapabilityRegistry(options: BetaHardenedAdapterOptions = {}): CapabilityRegistryV2 {
  const base = new Map(BETA_DEFAULT_CAPABILITY_REGISTRY);
  const specs = BETA_HARDENED_PROFILE_MANIFEST.capabilities.map((capability): readonly [string, CapabilitySpecV2] => {
    const existing = base.get(capability.id); if (existing) return [capability.id, existing];
    return [capability.id, hardenedSpec(capability, options)];
  });
  return new Map([...base, ...specs]);
}

export function scanHardenedCapabilitiesV2(context: AnalyzerContextV2, profile: ProfileManifestV2 = BETA_HARDENED_PROFILE_MANIFEST, registry: CapabilityRegistryV2 = createBetaHardenedCapabilityRegistry()): CapabilityScheduleV2 {
  return scheduleCapabilities(context, profile, registry);
}

export const BETA_HARDENED_CAPABILITY_REGISTRY = createBetaHardenedCapabilityRegistry();

function hardenedSpec(capability: ProfileCapabilityV2, options: BetaHardenedAdapterOptions): CapabilitySpecV2 {
  const run = capability.id === 'expression-security' ? (context: AnalyzerContextV2) => codeFacts(context, capability, 'both') : capability.id === 'javascript-security' ? (context: AnalyzerContextV2) => codeCandidate(context, capability, 'javascript') : capability.id === 'python-security' ? (context: AnalyzerContextV2) => codeCandidate(context, capability, 'python') : capability.id === 'graph-semantics' || capability.id === 'taint-confidentiality' ? (context: AnalyzerContextV2) => taintFacts(context, capability, options) : capability.id === 'taint-integrity' ? (context: AnalyzerContextV2) => fieldFlowCandidate(context, capability, options.getFieldFlow) : capability.id === 'agentic-control' ? (context: AnalyzerContextV2) => agenticCandidate(context, capability, options) : () => { options.onRun?.(); return emptyCandidate(1); };
  return { ...capability, run };
}

function codeFacts(context: AnalyzerContextV2, capability: ProfileCapabilityV2, language: 'javascript' | 'python' | 'both'): CapabilityCandidateV2 {
  const workflow = toNativeWorkflow(context); const facts: SafeFactV2[] = []; const diagnostics: AnalysisDiagnosticV2[] = []; let omitted = 0;
  const results = language === 'javascript' ? [analyzeWorkflowJavaScript(workflow)] : language === 'python' ? [analyzeWorkflowPython(workflow)] : [analyzeWorkflowJavaScript(workflow), analyzeWorkflowPython(workflow)];
  for (const result of results) { omitted += result.diagnostics.length; appendFindings(result.findings, context, capability, facts, undefined, diagnostics); for (const diagnostic of result.diagnostics) diagnostics.push(adaptDiagnostic(diagnostic, context, capability)); }
  return admitCandidate({ findings: [], diagnostics: uniqueDiagnostics(diagnostics), facts, traces: [], seen: workflow.nodes.length, analyzed: workflow.nodes.length, skipped: 0, omitted });
}

function codeCandidate(context: AnalyzerContextV2, capability: ProfileCapabilityV2, language: 'javascript' | 'python'): CapabilityCandidateV2 {
  const workflow = toNativeWorkflow(context); const analysis = language === 'javascript' ? analyzeWorkflowJavaScript(workflow) : analyzeWorkflowPython(workflow); return findingsCandidate(analysis.findings, analysis.diagnostics, context, capability, workflow.nodes.length);
}

const FAILED_TAINT_OUTCOME: TaintOutcomeV1 = Object.freeze({
  status: 'FAILED', findings: Object.freeze([]), diagnostics: Object.freeze([]),
});

/**
 * A scan without an injected accessor has not computed taint, and this adapter never recomputes it:
 * an absent dependency is published as the typed failure every consumer routes through, never as a
 * guessed clean result.
 */
function taintOutcome(options: BetaHardenedAdapterOptions): TaintOutcomeV1 {
  return options.getTaint?.() ?? FAILED_TAINT_OUTCOME;
}

function failedTaint(context: AnalyzerContextV2, capability: ProfileCapabilityV2): CapabilityCandidateV2 {
  const seen = context.workflow.nodes.length;
  return admitCandidate({
    findings: [], facts: [], traces: [],
    diagnostics: [createDiagnostic('REQUIRED_CAPABILITY_FAILED', capability.id, capability.required)],
    seen, analyzed: seen, skipped: 0, omitted: 1,
  });
}

function taintFacts(context: AnalyzerContextV2, capability: ProfileCapabilityV2, options: BetaHardenedAdapterOptions): CapabilityCandidateV2 {
  const analysis = taintOutcome(options);
  if (analysis.status === 'FAILED') return failedTaint(context, capability);
  const workflow = toNativeWorkflow(context); const facts: SafeFactV2[] = []; const diagnostics: AnalysisDiagnosticV2[] = [];
  appendFindings(analysis.findings, context, capability, facts, undefined, diagnostics); for (const diagnostic of analysis.diagnostics) diagnostics.push(adaptDiagnostic(diagnostic, context, capability));
  if (analysis.status === 'LIMITED') diagnostics.push(limitedDiagnostic(capability));
  return admitCandidate({ findings: [], diagnostics: uniqueDiagnostics(diagnostics), facts, traces: [], seen: workflow.nodes.length, analyzed: workflow.nodes.length, skipped: 0, omitted: analysis.diagnostics.length + (analysis.status === 'LIMITED' ? 1 : 0) });
}

function agenticCandidate(context: AnalyzerContextV2, capability: ProfileCapabilityV2, options: BetaHardenedAdapterOptions): CapabilityCandidateV2 {
  const taint = taintOutcome(options);
  if (taint.status === 'FAILED') return failedTaint(context, capability);
  const workflow = toNativeWorkflow(context);
  const ai = analyzeAiCapabilities(workflow, taint.propagation);
  return findingsCandidate(ai.findings, [...taint.diagnostics, ...ai.diagnostics], context, capability, workflow.nodes.length, taint.status === 'LIMITED' ? [limitedDiagnostic(capability)] : []);
}

function findingsCandidate(findings: readonly ScanFinding[], nativeDiagnostics: readonly NativeAnalysisDiagnostic[], context: AnalyzerContextV2, capability: ProfileCapabilityV2, seen: number, extra: readonly AnalysisDiagnosticV2[] = []): CapabilityCandidateV2 {
  const facts: SafeFactV2[] = []; const diagnostics: AnalysisDiagnosticV2[] = [...extra]; const output: FindingCandidateV2[] = []; const traces: TraceV2[] = [];
  appendFindings(findings, context, capability, facts, output, diagnostics, traces); for (const diagnostic of nativeDiagnostics) diagnostics.push(adaptDiagnostic(diagnostic, context, capability));
  const refs = new Set(output.flatMap((item) => item.factRefs)); return admitCandidate({ findings: output, diagnostics: uniqueDiagnostics(diagnostics), facts: facts.filter((fact) => refs.has(fact.factId)), traces, seen, analyzed: seen, skipped: 0, omitted: nativeDiagnostics.length + extra.length });
}

function limitedDiagnostic(capability: ProfileCapabilityV2): AnalysisDiagnosticV2 {
  return createDiagnostic('OPTIONAL_LIMIT_EXCEEDED', capability.id, capability.required, undefined, { observed: 1, maximum: 0, omitted: 1 });
}

function appendFindings(findings: readonly ScanFinding[], context: AnalyzerContextV2, capability: ProfileCapabilityV2, facts: SafeFactV2[], output: FindingCandidateV2[] | undefined, diagnostics: AnalysisDiagnosticV2[], traces?: TraceV2[]): void {
  for (const finding of findings) {
    const node = findNode(context.workflow.nodes, finding.location.nodeId, finding.location.nodeName);
    if (!node) { diagnostics.push(unknownRuleDiagnostic(capability)); continue; }
    candidateFacts(finding, node, facts);
    const candidate = output === undefined ? undefined : candidateFinding(finding, node, context, capability, facts);
    if (output && candidate) {
      const trace = traces === undefined ? undefined : candidateTrace(finding, context, candidate.factRefs, context.limits.maxTraceStepsPerFinding);
      if (trace !== undefined) traces!.push(trace);
      output.push(trace === undefined ? candidate : { ...candidate, traceRefs: [trace.traceId] });
    } else if (output) diagnostics.push(unknownRuleDiagnostic(capability));
  }
}

function findNode(nodes: readonly SecurityNodeV2[], id: string | undefined, name: string | undefined): SecurityNodeV2 | undefined {
  if (id === undefined && name === undefined) return undefined;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]; if (node && ((id !== undefined && node.ref.explicitId === id) || (name !== undefined && node.ref.name === name))) return node;
  }
  return undefined;
}

function uniqueDiagnostics(values: readonly AnalysisDiagnosticV2[]): AnalysisDiagnosticV2[] {
  const seen = new Set<string>(); const output: AnalysisDiagnosticV2[] = [];
  for (const value of values) if (!seen.has(value.id)) { seen.add(value.id); output.push(value); }
  return output;
}
