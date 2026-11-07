import type { NormalizedWorkflow } from '../../workflow';
import { createTaintState, isTainted, type TaintLabel, type TaintState } from './taint-lattice';
import { incomingTaint, type TaintPropagationResult } from './taint-propagation';
import type { ExpressionReference } from './taint-expressions';
import { upstreamNodeIndexes, type TaintTrace } from './taint-traces';

export type TaintResolutionContext = {
  workflow: NormalizedWorkflow;
  propagation: TaintPropagationResult;
  traces: Map<number, TaintTrace>;
  nodeIndexesByName: Map<string, number[]>;
};

export function resolveReferenceState(context: TaintResolutionContext, nodeIndex: number, reference: ExpressionReference): TaintState {
  if (reference.root === 'CURRENT_ITEM') return incomingTaint(context.propagation, context.workflow, nodeIndex, 0);
  const named = namedNodeIndex(context, reference);
  if (named !== undefined) return context.propagation.outputStates[named];
  return joinUpstream(context, nodeIndex);
}

export function originTrace(context: TaintResolutionContext, nodeIndex: number, reference: ExpressionReference): TaintTrace | undefined {
  const named = namedNodeIndex(context, reference);
  if (named !== undefined) return extend(context.traces.get(named), nodeIndex);
  const contributors = reference.root === 'CURRENT_ITEM'
    ? context.workflow.graph.views.execution
      .filter((edge) => edge.toNodeIndex === nodeIndex && edge.toInputIndex === 0)
      .map((edge) => edge.fromNodeIndex)
    : [...upstreamNodeIndexes(context.workflow, nodeIndex)];
  return extend(contributors
    .filter((index) => isTainted(context.propagation.outputStates[index]))
    .sort((left, right) => left - right)
    .map((index) => context.traces.get(index))
    .find((candidate) => candidate !== undefined), nodeIndex);
}

export function indexesByName(nodes: ReadonlyArray<{ name: string }>): Map<string, number[]> {
  const result = new Map<string, number[]>();
  nodes.forEach((node, index) => result.set(node.name, [...(result.get(node.name) ?? []), index]));
  return result;
}

function namedNodeIndex(context: TaintResolutionContext, reference: ExpressionReference): number | undefined {
  if (reference.root !== 'NAMED_NODE') return undefined;
  const matches = context.nodeIndexesByName.get(reference.nodeName ?? '');
  return matches?.length === 1 ? matches[0] : undefined;
}

function joinUpstream(context: TaintResolutionContext, nodeIndex: number): TaintState {
  const labels = new Set<TaintLabel>();
  for (const upstream of upstreamNodeIndexes(context.workflow, nodeIndex)) {
    for (const label of context.propagation.outputStates[upstream].labels) labels.add(label);
  }
  return createTaintState(labels, []);
}

function extend(trace: TaintTrace | undefined, nodeIndex: number): TaintTrace | undefined {
  if (trace === undefined) return undefined;
  return trace.path.includes(nodeIndex) ? trace : { sourceNodeIndex: trace.sourceNodeIndex, path: [...trace.path, nodeIndex] };
}
