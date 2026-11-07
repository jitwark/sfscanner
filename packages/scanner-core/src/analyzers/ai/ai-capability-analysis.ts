import type { NormalizedWorkflow, NormalizedWorkflowNode } from '../../workflow';
import { computeExecutionDominators, dominates } from '../../graph-dominators';
import type { AnalysisDiagnostic, ScanFinding } from '../../policy/policy';
import { nodeFinding } from '../../policy/policy-helpers';
import { buildAiCapabilityGraph } from './ai-capability-graph';
import { isCataloguedHumanGate } from './human-gate-catalog';
import { createTaintState, isTainted, orderedTaintLabels, type TaintState } from '../taint/taint-lattice';
import { incomingTaintFrom, type TaintPropagationResult } from '../taint/taint-propagation';

export const MAX_AI_CAPABILITY_FINDINGS = 25;
export type AiCapabilityAnalysisResult = { findings: ScanFinding[]; diagnostics: AnalysisDiagnostic[] };

type TaintCouplingV2 =
  | Readonly<{ status: 'ABSENT' }>
  | Readonly<{ status: 'UNUSABLE' }>
  | Readonly<{ status: 'READY'; states: readonly TaintState[] }>;

/**
 * The taint-to-AI coupling is an explicit value. The AI stage reads a per-node taint vector it owns,
 * or it reports the coupling as unusable; it never reads the producer's live working buffer. A
 * coupling that does not cover the workflow is never read as "no taint", which would be a false
 * clean, and no coupling shape can raise out of this stage.
 */
function readTaintCoupling(workflow: NormalizedWorkflow, propagation: TaintPropagationResult | undefined): TaintCouplingV2 {
  try {
    if (propagation === undefined || propagation === null) return { status: 'ABSENT' };
    const states: unknown = (propagation as Readonly<{ outputStates?: unknown }>).outputStates;
    if (!Array.isArray(states) || states.length !== workflow.nodes.length) return { status: 'UNUSABLE' };
    const owned: TaintState[] = [];
    for (const state of states) {
      const value = state as TaintState | null;
      if (value === null || typeof value !== 'object'
        || typeof value.labels?.has !== 'function' || typeof value.sanitizedFor?.has !== 'function') return { status: 'UNUSABLE' };
      owned.push(createTaintState(value.labels, value.sanitizedFor));
    }
    return { status: 'READY', states: Object.freeze(owned) };
  } catch { return { status: 'UNUSABLE' }; }
}

export function analyzeAiCapabilities(workflow: NormalizedWorkflow, propagation: TaintPropagationResult | undefined): AiCapabilityAnalysisResult {
  const coupling = readTaintCoupling(workflow, propagation);
  if (coupling.status === 'UNUSABLE') return { findings: [], diagnostics: [{ code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY' }] };
  if (coupling.status === 'ABSENT') return { findings: [], diagnostics: [] };
  const agents = buildAiCapabilityGraph(workflow).agents.filter((entry) => entry.toolNodeIndexes.length > 0);
  if (agents.length === 0) return { findings: [], diagnostics: [] };
  const gateIndexes = workflow.nodes.map((node, index) => (isCataloguedHumanGate(node) ? index : -1)).filter((index) => index >= 0);
  const dominators = gateIndexes.length === 0 ? undefined : computeExecutionDominators(workflow);
  if (dominators?.limitExceeded) {
    return { findings: [], diagnostics: [{ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' }] };
  }
  const findings: ScanFinding[] = [];
  const diagnostics: AnalysisDiagnostic[] = [];
  for (const entry of agents) {
    if (findings.length >= MAX_AI_CAPABILITY_FINDINGS) {
      diagnostics.push({ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT' });
      break;
    }
    const incoming = incomingTaintFrom(coupling.states, workflow, entry.nodeIndex, 0);
    if (!isTainted(incoming)) continue;
    if (dominators && gateIndexes.some((gate) => dominates(dominators, gate, entry.nodeIndex))) continue;
    findings.push(ungatedToolFinding(workflow.nodes[entry.nodeIndex], {
      toolCount: entry.toolNodeIndexes.length,
      contextCount: entry.contextNodeIndexes.length,
      taintLabels: orderedTaintLabels(incoming),
      humanGatePresent: gateIndexes.length > 0,
      humanGateDominates: false,
    }));
  }
  return { findings, diagnostics };
}

function ungatedToolFinding(node: NormalizedWorkflowNode, evidence: Record<string, unknown>): ScanFinding {
  return nodeFinding({
    policyId: 'AI_AGENT_UNGATED_TOOL',
    title: 'An AI agent can act on untrusted input without a human gate',
    severity: 'MEDIUM', node, evidence,
    message: 'This agent holds tools and receives data that entered the workflow from outside.',
    explanation: 'Untrusted data reaches this agent, the agent has connected tools it can invoke, and no wait or approval node stands on every execution path into it.',
    whyItMatters: 'A model cannot reliably separate instructions from content, so whoever controls the incoming data has partial influence over which tools the agent decides to use.',
    possibleImpact: 'The agent may take an action a caller asked for rather than one the workflow author intended.',
    remediation: 'Require human approval before the agent acts, or narrow the tools it can reach.',
    remediationSteps: [
      'Place a wait or approval node on every path into the agent, not only on one branch.',
      'Reduce the connected tools to the minimum the automation needs.',
      'Keep untrusted content in a delimited field separate from the instructions.',
    ],
    confidence: 'LOW',
  });
}
