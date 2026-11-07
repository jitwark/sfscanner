import type { SafeFactV2, SubjectV2, TraceV2 } from '../../capabilities/scheduler';
import { chargeGraphOperation, normalizeGraphOperationBudget, type GraphOperationBudgetInputV2, type GraphOperationBudgetV2 } from '../graph-v2/budget';
import { createTraceId, type IdentityContextV2 } from '../../result-v2/identities';
import { canonicalBytesV1 } from '../../result-v2/canonical-bytes';
import { readExhaustedGraphBudgetV2, type TaintTraceStepV2 } from './transfer';
import { admitFacts, resolveSubject, subjectIdentity, validStep, type MaterializationStep, type MaterializationPredecessor } from './trace-helpers';

export type MaterializeTraceInputV2 = Readonly<{
  kind: TraceV2['kind'];
  steps: readonly (TaintTraceStepV2 | MaterializationStep)[];
  facts?: readonly SafeFactV2[];
  subjects?: ReadonlyMap<number, SubjectV2>;
  context: IdentityContextV2;
  limits: Readonly<{ maxTraceStepsPerFinding: number; maxEvidenceBytes: number }>;
  graphBudget?: GraphOperationBudgetInputV2;
}>;

export type MaterializeTraceResultV2 = Readonly<{
  status: 'COMPLETE' | 'UNKNOWN' | 'LIMIT_EXCEEDED' | 'GRAPH_WORK_LIMIT_EXCEEDED';
  trace: TraceV2 | null;
  omitted: number;
  graphUsage?: GraphOperationBudgetV2;
}>;

type Candidate = Readonly<{ input: MaterializationStep; index: number }>;

type TraceLimitsV2 = Readonly<{ maxTraceStepsPerFinding: number; maxEvidenceBytes: number }>;
type TraceWorkBudget = { graphBudget: GraphOperationBudgetV2 | undefined };

export function materializeTraceV2(input: MaterializeTraceInputV2): MaterializeTraceResultV2 {
  const limits = readLimits(input.limits);
  const exhaustedBudget = readExhaustedGraphBudgetV2(input.graphBudget);
  if (exhaustedBudget !== undefined) {
    return graphLimitResult(Math.max(1, Array.isArray(input.steps) ? input.steps.length : 1), exhaustedBudget);
  }
  const work: TraceWorkBudget = {
    graphBudget: input.graphBudget === undefined ? undefined : normalizeGraphOperationBudget(input.graphBudget),
  };
  const rawSteps = input.steps;
  if (!Array.isArray(rawSteps)) return unknownResult(1, work.graphBudget);
  const candidateCount = rawSteps.length;
  if (work.graphBudget?.exhausted) return graphLimitResult(candidateCount, work.graphBudget);
  if (!['CONFIDENTIALITY', 'INTEGRITY', 'CONTROL'].includes(input.kind)) return unknownResult(Math.max(1, candidateCount), work.graphBudget);
  if (input.facts !== undefined && !Array.isArray(input.facts)) return unknownResult(Math.max(1, candidateCount), work.graphBudget);
  if (candidateCount > limits.maxTraceStepsPerFinding) return limitResult(candidateCount, work.graphBudget);

  const candidates: Candidate[] = [];
  let malformed = 0;
  for (let index = 0; index < rawSteps.length; index += 1) {
    const value = rawSteps[index];
    if (!validStep(value)) { malformed += 1; continue; }
    candidates.push(Object.freeze({ input: value, index }));
  }
  if (malformed > 0 || candidates.length === 0) return unknownResult(Math.max(1, malformed), work.graphBudget);

  const selected = selectCandidates(candidates, work);
  if (work.graphBudget?.exhausted) return graphLimitResult(candidateCount, work.graphBudget);
  if (selected === undefined || selected.length === 0) return unknownResult(candidateCount, work.graphBudget);
  const facts = admitFacts(input.facts, input.context);
  const steps: TraceV2['steps'][number][] = [];
  const affected = new Set<number>();
  for (const candidate of selected) {
    const subject = resolveSubject(candidate.input.node, input.subjects, facts);
    if (subject === undefined) { affected.add(candidate.index); continue; }
    const subjectKey = subjectIdentity(subject, input.context);
    const factRefs = subjectKey === undefined ? [] : [...(facts.bySubject.get(subjectKey) ?? [])];
    if (input.facts !== undefined && ['SOURCE', 'SINK'].includes(candidate.input.kind) && factRefs.length === 0) affected.add(candidate.index);
    steps.push(Object.freeze({ ordinal: steps.length, kind: candidate.input.kind, subject, factRefs: Object.freeze(factRefs) }));
  }
  const invalid = selected.filter((candidate) => affected.has(candidate.index) || facts.invalidOrdinals.has(candidate.input.node)).length;
  if (invalid > 0 || steps.length !== selected.length) return unknownResult(Math.max(1, invalid, selected.length - steps.length), work.graphBudget);

  try {
    const traceWithoutId = { kind: input.kind, steps: Object.freeze(steps) } as const;
    const traceId = createTraceId(traceWithoutId, input.context);
    const trace = Object.freeze({ traceId, kind: input.kind, steps: Object.freeze(steps) });
    let evidenceBytes = canonicalBytesV1(trace).byteLength;
    const charged = new Set<string>();
    for (const step of trace.steps) {
      for (const factId of step.factRefs) {
        if (charged.has(factId)) continue;
        const fact = facts.byId.get(factId);
        if (fact === undefined) return unknownResult(candidateCount, work.graphBudget);
        if (evidenceBytes > limits.maxEvidenceBytes) return limitResult(candidateCount, work.graphBudget);
        const factBytes = canonicalBytesV1(fact).byteLength;
        if (factBytes > limits.maxEvidenceBytes - evidenceBytes) return limitResult(candidateCount, work.graphBudget);
        evidenceBytes += factBytes; charged.add(factId);
      }
    }
    if (evidenceBytes > limits.maxEvidenceBytes) return limitResult(candidateCount, work.graphBudget);
    return Object.freeze({
      status: 'COMPLETE' as const, trace, omitted: 0,
      ...(work.graphBudget === undefined ? {} : { graphUsage: work.graphBudget }),
    });
  } catch {
    return unknownResult(candidateCount, work.graphBudget);
  }
}

function readLimits(input: TraceLimitsV2): TraceLimitsV2 {
  if (input === null || typeof input !== 'object'
    || !Number.isSafeInteger(input.maxTraceStepsPerFinding) || input.maxTraceStepsPerFinding < 0
    || !Number.isSafeInteger(input.maxEvidenceBytes) || input.maxEvidenceBytes < 0) {
    throw new TypeError('Trace limits must be non-negative safe integers');
  }
  return input;
}

function chargeGraphWork(work: TraceWorkBudget, units = 1): boolean {
  if (work.graphBudget === undefined) return true;
  if (work.graphBudget.exhausted) return false;
  const charged = chargeGraphOperation(work.graphBudget, units);
  work.graphBudget = charged.counter;
  return charged.ok;
}


function selectCandidates(candidates: readonly Candidate[], work: TraceWorkBudget): readonly Candidate[] | undefined {
  let hasPredecessor = false;
  for (const candidate of candidates) {
    if (!chargeGraphWork(work)) return undefined;
    if (candidate.input.predecessor !== undefined) hasPredecessor = true;
  }
  if (!hasPredecessor) {
    if (candidates.length > 0 && !chargeGraphWork(work, candidates.length)) return undefined;
    return Object.freeze([...candidates]);
  }
  const sinks: Candidate[] = [];
  for (const candidate of candidates) {
    if (!chargeGraphWork(work)) return undefined;
    if (candidate.input.kind === 'SINK') sinks.push(candidate);
  }
  const targets = sinks.length > 0 ? sinks : [candidates[candidates.length - 1]!];
  let best: readonly Candidate[] | undefined;
  for (const target of targets) {
    if (!chargeGraphWork(work)) return undefined;
    const path = predecessorPath(target, candidates, new Set<string>(), work);
    if (work.graphBudget?.exhausted) return undefined;
    if (path === undefined) continue;
    if (best !== undefined && !chargeGraphWork(work, Math.max(path.length, best.length))) return undefined;
    if (best === undefined || comparePaths(path, best) < 0) best = path;

  }
  return best === undefined ? undefined : Object.freeze(best);
}
function predecessorPath(
  target: Candidate,
  candidates: readonly Candidate[],
  activeStates: Set<string>,
  work: TraceWorkBudget,
): readonly Candidate[] | undefined {
  if (!chargeGraphWork(work)) return undefined;
  const state = stateKey(target.input);
  if (activeStates.has(state)) return undefined;
  if (!chargeGraphWork(work, activeStates.size + 1)) return undefined;
  const nextStates = new Set(activeStates); nextStates.add(state);
  const predecessor = target.input.predecessor;
  if (predecessor === undefined) return Object.freeze([target]);
  let best: readonly Candidate[] | undefined;
  for (const candidate of candidates) {
    if (!chargeGraphWork(work)) return undefined;
    if (!matchesPredecessor(candidate, predecessor)) continue;
    const path = predecessorPath(candidate, candidates, nextStates, work);
    if (work.graphBudget?.exhausted) return undefined;
    if (path === undefined) continue;
    if (!chargeGraphWork(work, path.length + 1)) return undefined;
    const candidatePath = Object.freeze([...path, target]);
    if (best !== undefined && !chargeGraphWork(work, Math.max(candidatePath.length, best.length))) return undefined;
    if (best === undefined || comparePaths(candidatePath, best) < 0) best = candidatePath;
  }
  return best;
}
function stateKey(input: MaterializationStep): string {
  return `${input.node}|${input.field}|${input.port}|${input.item}`;
}

function matchesPredecessor(candidate: Candidate, predecessor: MaterializationPredecessor): boolean {
  return candidate.input.node === predecessor.node && candidate.input.field === predecessor.field && candidate.input.item === predecessor.item;
}

function comparePaths(left: readonly Candidate[], right: readonly Candidate[]): number {
  if (left.length !== right.length) return left.length - right.length;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!; const b = right[index]!;
    const compared = a.input.node - b.input.node || a.input.port - b.input.port
      || (a.input.predecessor?.edge ?? -1) - (b.input.predecessor?.edge ?? -1)
      || compareCodePointStrings(a.input.field, b.input.field) || a.input.item - b.input.item || a.index - b.index;
    if (compared !== 0) return compared;
  }
  return 0;
}

function compareCodePointStrings(left: string, right: string): number {
  const leftPoints = Array.from(left); const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftPoints[index]!.codePointAt(0)!; const b = rightPoints[index]!.codePointAt(0)!;
    if (a !== b) return a - b;
  }
  return leftPoints.length - rightPoints.length;
}

function unknownResult(omitted: number, graphUsage?: GraphOperationBudgetV2): MaterializeTraceResultV2 {
  return Object.freeze({ status: 'UNKNOWN' as const, trace: null, omitted: Math.max(1, omitted), ...(graphUsage === undefined ? {} : { graphUsage }) });
}

function limitResult(omitted: number, graphUsage?: GraphOperationBudgetV2): MaterializeTraceResultV2 {
  return Object.freeze({ status: 'LIMIT_EXCEEDED' as const, trace: null, omitted: Math.max(1, omitted), ...(graphUsage === undefined ? {} : { graphUsage }) });
}

function graphLimitResult(omitted: number, graphUsage: GraphOperationBudgetV2): MaterializeTraceResultV2 {
  return Object.freeze({
    status: 'GRAPH_WORK_LIMIT_EXCEEDED' as const, trace: null,
    omitted: Math.max(1, omitted, graphUsage.omitted), graphUsage,
  });
}
