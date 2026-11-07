import type { SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';
import type { SafeFactV2, TraceV2, AnalysisDiagnosticV2 } from '../../../../../contracts/scanner-v2-evidence';
import type { ScannerLimitsV2 } from '../../../../../contracts';
import type { SemanticCatalogueViewV2 } from '../../capabilities/scheduler';
import { createDiagnostic } from '../../capabilities/adapter-evidence';
import { deriveFlowCoverageV1, type FlowCoverageCountersV1, type FlowCoverageDerivationV1,
  type FlowCoverageInputV1 } from './flow-coverage-derivation';
import { withFlowCoverageChargeV1 } from './flow-coverage-observation';
import { publishFlowCoverageV1 } from './flow-coverage-publication';
import { createScanLocalTransfer } from './scan-local-transfer';
import { runScanLocalWithWitnesses, type ScanLocalWitnessInputV1 } from './scan-local-traces';
import { createScanLocalFlowFactEmitterV1 } from './scan-local-flow-witness-facts';
import type { ScanLocalChargeV1 } from './scan-local-state';
import { compileScanLocalWorkflowFlowModelV1 } from './scan-local-workflow-flow-model';

export type FlowWitnessAnalysisV2 = Readonly<{
  status: 'COMPLETE' | 'UNKNOWN' | 'LIMITED';
  facts: readonly SafeFactV2[];
  traces: readonly TraceV2[];
  diagnostics: readonly AnalysisDiagnosticV2[];
}>;

export type CompileWorkflowFlowWitnessesInput = Readonly<{
  workflow: SecurityWorkflowV2;
  semantics: SemanticCatalogueViewV2;
  limits: ScannerLimitsV2;
  semanticSha256: string;
}>;

const degraded = (observed = false): AnalysisDiagnosticV2 => createDiagnostic('GRAPH_ANALYSIS_DEGRADED',
  'structural-policies', false, undefined, observed ? { observed: 1, omitted: 0 } : { omitted: 1 });
const complete = (): FlowWitnessAnalysisV2 => Object.freeze({ status: 'COMPLETE', facts: Object.freeze([]),
  traces: Object.freeze([]), diagnostics: Object.freeze([]) });
const limited = (): FlowWitnessAnalysisV2 => Object.freeze({ status: 'LIMITED', facts: Object.freeze([]),
  traces: Object.freeze([]), diagnostics: Object.freeze([degraded()]) });

export type FieldFlowAccessorV1 = () => FlowWitnessAnalysisV2;

function snapshot(value: FlowWitnessAnalysisV2): FlowWitnessAnalysisV2 {
  return Object.freeze({ status: value.status, facts: Object.freeze([...value.facts]),
    traces: Object.freeze([...value.traces]), diagnostics: Object.freeze([...value.diagnostics]) });
}

export function createFieldFlowAccessorV1(input: CompileWorkflowFlowWitnessesInput): FieldFlowAccessorV1 {
  let state: 'IDLE' | 'RUNNING' | 'READY' = 'IDLE';
  let cached: FlowWitnessAnalysisV2 | undefined;
  return () => {
    if (state === 'READY') return cached!;
    if (state === 'RUNNING') return limited();
    state = 'RUNNING';
    try { cached = snapshot(compileWorkflowFlowWitnesses(input)); }
    catch { cached = limited(); }
    state = 'READY';
    return cached;
  };
}

function finish(base: FlowWitnessAnalysisV2, coverage: FlowCoverageDerivationV1,
  charge: Parameters<typeof publishFlowCoverageV1>[1], semanticSha256: string): FlowWitnessAnalysisV2 {
  const published = publishFlowCoverageV1({ coverage, existingFacts: base.facts, semanticSha256 }, charge);
  if (!published.ok) return finishRefusal(base);
  const coverageStatus = published.fact.properties.coverageStatus;
  return Object.freeze({ ...base, status: base.status === 'COMPLETE' && coverageStatus !== 'COMPLETE' ? 'LIMITED' : base.status,
    facts: published.facts });
}

function finishRefusal(base: FlowWitnessAnalysisV2): FlowWitnessAnalysisV2 {
  const status = base.status === 'COMPLETE' ? 'LIMITED' : base.status;
  const diagnostics = base.diagnostics.some((item) => item.code === 'GRAPH_ANALYSIS_DEGRADED')
    ? base.diagnostics : Object.freeze([...base.diagnostics, degraded()]);
  return Object.freeze({ ...base, status, diagnostics });
}

function terminalInput(result: ReturnType<typeof runScanLocalWithWitnesses>): FlowCoverageInputV1 {
  const counters: FlowCoverageCountersV1 = Object.freeze({ analysisStatus: result.analysis.status,
    flowsStatus: result.flows.status, analysisOmitted: result.analysis.omitted,
    invalidRequests: result.flows.invalidRequests, unmappedSources: result.flows.unmappedSources,
    unpublishedSinks: result.flows.unpublishedSinks, incompleteTransfers: result.flows.incompleteTransfers,
    omittedRequests: result.omittedRequests, witnessUnavailable: result.witnessUnavailable,
    omittedTraceSteps: result.omittedTraceSteps, suppressedRequests: result.suppressedRequests });
  return Object.freeze({ kind: 'TERMINAL', snapshot: result.flowCoverage, facts: result.facts, counters });
}

function finishTerminal(base: FlowWitnessAnalysisV2, result: ReturnType<typeof runScanLocalWithWitnesses>,
  semanticSha256: string): FlowWitnessAnalysisV2 {
  const input = terminalInput(result);
  const handoff = withFlowCoverageChargeV1(result.flowCoverage, (charge) => {
    const coverage: FlowCoverageDerivationV1 = result.flows.candidates.length === 0
      && result.flowCoverage.status === 'OBSERVED' && result.flowCoverage.rows.length === 0
      ? deriveFlowCoverageV1({ kind: 'NOT_APPLICABLE' }, charge) : deriveFlowCoverageV1(input, charge);
    return finish(base, coverage, charge, semanticSha256);
  });
  return handoff.ok ? handoff.value : finishRefusal(base);
}

export function compileWorkflowFlowWitnesses(input: CompileWorkflowFlowWitnessesInput): FlowWitnessAnalysisV2 {
  const { workflow, semantics, limits, semanticSha256 } = input;
  const allFacts: SafeFactV2[] = [];
  const allTraces: TraceV2[] = [];
  const maxOperations = limits.maxGraphOperations ?? 100_000;
  let operations = 0;
  let refusalLatched = false;
  const workflowCharge: ScanLocalChargeV1 = (units) => {
    if (refusalLatched) return false;
    if (!Number.isSafeInteger(units) || units < 0) throw new TypeError('charge units must be a non-negative safe integer');
    if (units > maxOperations - operations) { refusalLatched = true; return false; }
    operations += units;
    return true;
  };
  if (workflow.nodes.length === 0) return limits.maxGraphOperations === 0 ? complete()
    : finish(complete(), deriveFlowCoverageV1({ kind: 'NOT_APPLICABLE' }, workflowCharge), workflowCharge, semanticSha256);
  if (limits.maxGraphOperations === 0) return limited();
  const model = compileScanLocalWorkflowFlowModelV1({ workflow, semantics, charge: workflowCharge });
  if (model.status === 'LIMITED') {
    return Object.freeze({ status: 'LIMITED', facts: Object.freeze([]), traces: Object.freeze([]),
      diagnostics: Object.freeze([createDiagnostic('GRAPH_ANALYSIS_DEGRADED', 'structural-policies', false, undefined,
        { omitted: model.omittedLowerBound })]) });
  }
  if (model.status === 'UNKNOWN') {
    return Object.freeze({ status: 'UNKNOWN', facts: Object.freeze([]), traces: Object.freeze([]),
      diagnostics: Object.freeze([createDiagnostic('GRAPH_ANALYSIS_DEGRADED', 'structural-policies', false, undefined,
        { observed: 1, omitted: 0 })]) });
  }
  if (model.status === 'NOT_APPLICABLE') {
    return finish(complete(), deriveFlowCoverageV1({ kind: 'NOT_APPLICABLE' }, workflowCharge), workflowCharge, semanticSha256);
  }
  const remainingOps = Math.max(0, maxOperations - operations);
  if (remainingOps <= 0) {
    return Object.freeze({ status: 'LIMITED', facts: Object.freeze([]), traces: Object.freeze([]),
      diagnostics: Object.freeze([createDiagnostic('GRAPH_ANALYSIS_DEGRADED', 'structural-policies', false, undefined,
        { omitted: 1 })]) });
  }
  const emitFlow = createScanLocalFlowFactEmitterV1({ carriers: model.witness.carriers, subjects: model.witness.subjects,
    sinks: model.sinks, taintLabels: model.taintLabels, limits });
  const result = runScanLocalWithWitnesses({ entry: model.entry, graph: model.graph, initialState: model.initialState,
    transfer: createScanLocalTransfer(model.transferModels), maxStates: limits.maxTaintStates ?? 20,
    maxOperations: remainingOps, charge: workflowCharge }, { ...model.witness, context: { semanticSha256 },
    limits: { maxTraceStepsPerFinding: limits.maxTraceStepsPerFinding ?? 100, maxEvidenceBytes: limits.maxEvidenceBytes ?? 100_000 },
    maxWitnessOperations: Math.max(1, Math.min(10_000, remainingOps)), emitFlow });
  const worklistOmitted = Math.max(0, result.analysis.omitted - result.witnessUnavailable - result.omittedTraceSteps);
  const resourceOmitted = worklistOmitted > 0 || result.omittedRequests > 0 || result.omittedTraceSteps > 0
    || result.flows.incompleteTransfers > 0 || result.flows.omittedAtoms > 0 || result.flows.omittedTokens > 0;
  const isLimited = result.analysis.status === 'LIMITED' || result.flows.status === 'LIMITED' || resourceOmitted
    || result.witnessUnavailable > 0;
  const omittedLowerBound = resourceOmitted ? Math.max(worklistOmitted, result.omittedRequests, result.omittedTraceSteps,
    result.flows.incompleteTransfers, result.flows.omittedAtoms, result.flows.omittedTokens) : 0;
  allFacts.push(...result.facts);
  for (const witness of result.witnesses) if (witness.status === 'COMPLETE' && witness.trace !== null) allTraces.push(witness.trace);

  // Keep omitted work separate from requests that lacked a witness; unavailable is not a step count.
  const diagnostics: AnalysisDiagnosticV2[] = [
    ...(omittedLowerBound > 0 ? [createDiagnostic('GRAPH_ANALYSIS_DEGRADED', 'structural-policies', false, undefined, { omitted: omittedLowerBound })] : []),
    ...(result.witnessUnavailable > 0 ? [createDiagnostic('GRAPH_ANALYSIS_DEGRADED', 'structural-policies', false, undefined, { observed: result.witnessUnavailable })] : []),
    ...(isLimited && omittedLowerBound === 0 && result.witnessUnavailable === 0
      ? [createDiagnostic('GRAPH_ANALYSIS_DEGRADED', 'structural-policies', false)] : []),
  ];

  const base: FlowWitnessAnalysisV2 = Object.freeze({
    status: isLimited ? 'LIMITED' : 'COMPLETE',
    facts: Object.freeze(allFacts),
    traces: Object.freeze(allTraces),
    diagnostics: Object.freeze(diagnostics),
  });
  return finishTerminal(base, result, semanticSha256);
}
