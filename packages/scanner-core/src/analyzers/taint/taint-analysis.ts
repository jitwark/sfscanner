import type { NormalizedWorkflow, NormalizedWorkflowNode } from '../../workflow';
import type { AnalysisDiagnostic, FindingConfidence, ScanFinding } from '../../policy/policy';
import { nodeFinding } from '../../policy/policy-helpers';
import { createTaintState, isTainted, orderedTaintLabels, reachesSink, type TaintState } from './taint-lattice';
import { propagateTaint, type TaintPropagationResult } from './taint-propagation';
import { readParameterExpressions, type ExpressionReference } from './taint-expressions';
import { resolveWrapperChainSanitization } from './taint-sanitizers';
import { collectSinkReads, type SinkRead } from './taint-sink-catalog';
import { SINK_NARRATIVES } from './taint-finding-copy';
import { amplifyTaint, isUnsupportedTaintTriggerType, seedTaintStates } from './taint-sources';
import { buildTaintTraces, type TaintTrace } from './taint-traces';
import { indexesByName, originTrace, resolveReferenceState, type TaintResolutionContext } from './taint-reference-resolution';

export const MAX_TAINT_FINDINGS = 50;
export type TaintAnalysisResult = {
  findings: ScanFinding[];
  diagnostics: AnalysisDiagnostic[];
  propagation?: TaintPropagationResult;
};
type Context = TaintResolutionContext;

export function analyzeWorkflowTaint(workflow: NormalizedWorkflow): TaintAnalysisResult {
  const diagnostics: AnalysisDiagnostic[] = [];
  for (const node of workflow.nodes) {
    if (isUnsupportedTaintTriggerType(node.type)) diagnostics.push({
      code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY', location: { path: node.sourcePath },
    });
  }
  const seeds = seedTaintStates(workflow);
  if (!seeds.some(isTainted)) return { findings: [], diagnostics };
  const labels = new Map<string, number>();
  for (const node of workflow.nodes) labels.set(node.name, (labels.get(node.name) ?? 0) + 1);
  const propagation = propagateTaint(workflow, seeds, {
    transfer: (nodeIndex, state) => amplifyTaint(workflow.nodes[nodeIndex].type, state),
  });
  const context: Context = { workflow, propagation, traces: buildTaintTraces(workflow, seeds), nodeIndexesByName: indexesByName(workflow.nodes) };
  const findings: ScanFinding[] = [];
  if (propagation.limitExceeded) diagnostics.push({ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' });
  let capped = false;
  for (const [nodeIndex, node] of workflow.nodes.entries()) {
    if (capped) break;
    for (const read of collectSinkReads(node)) {
      const reading = readParameterExpressions(read.value, labels);
      for (const code of reading.diagnostics) diagnostics.push({
        code: code === 'EXPRESSION_PARSE_FAILED' ? 'EXPRESSION_PARSE_FAILED' : 'ANALYSIS_LIMIT_EXCEEDED',
        category: code === 'EXPRESSION_PARSE_FAILED' ? 'PARSER' : 'LIMIT', location: { path: node.sourcePath },
      });
      for (const reference of reading.references) {
        if (findings.length >= MAX_TAINT_FINDINGS) { capped = true; break; }
        const finding = evaluateReference(context, node, nodeIndex, read, reference);
        if (finding) findings.push(finding);
      }
      if (capped) break;
    }
  }
  if (capped) diagnostics.push({ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' });
  return { findings, diagnostics, propagation };
}

function evaluateReference(context: Context, node: NormalizedWorkflowNode, nodeIndex: number, read: SinkRead, reference: ExpressionReference): ScanFinding | undefined {
  const state = resolveReferenceState(context, nodeIndex, reference);
  if (!isTainted(state)) return undefined;
  const sanitized = resolveWrapperChainSanitization(reference.wrapperCallees);
  const atSink = createTaintState(state.labels, [...state.sanitizedFor, ...sanitized]);
  if (!reachesSink(atSink, read.sink)) return undefined;
  return createFinding(context, node, read, reference, state, originTrace(context, nodeIndex, reference));
}

function createFinding(context: Context, node: NormalizedWorkflowNode, read: SinkRead, reference: ExpressionReference, state: TaintState, trace: TaintTrace | undefined): ScanFinding {
  const source = trace === undefined ? undefined : context.workflow.nodes[trace.sourceNodeIndex];
  const narrative = SINK_NARRATIVES[read.sink];
  return nodeFinding({
    policyId: read.policyId, title: narrative.title, severity: read.severity, node,
    evidence: {
      sink: read.sink, parameterPath: read.parameterPath, referenceRoot: reference.root,
      ...(reference.propertyPath === undefined ? {} : { propertyPath: reference.propertyPath }),
      propertyPathComplete: reference.pathComplete, taintLabels: orderedTaintLabels(state),
      ...(source === undefined ? {} : { sourceNodeId: source.id, sourceNodeName: source.name }),
      ...(trace === undefined ? {} : { traceLength: trace.path.length, tracePath: trace.path.map((index) => context.workflow.nodes[index].id) }),
    },
    message: narrative.message, explanation: narrative.explanation, whyItMatters: narrative.whyItMatters,
    possibleImpact: narrative.possibleImpact, remediation: narrative.remediation,
    remediationSteps: narrative.remediationSteps, confidence: confidenceFor(reference),
  });
}

function confidenceFor(reference: ExpressionReference): FindingConfidence {
  if (reference.root === 'DYNAMIC_NODE') return 'LOW';
  return reference.pathComplete ? 'MEDIUM' : 'LOW';
}
