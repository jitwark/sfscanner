import { createCandidateTraceId } from '../result-v2/identities';
import type { ScanFinding } from '../policy/policy';
import type { SecurityNodeV2 } from '../workflow-v2/security-workflow';
import type { AnalyzerContextV2, SubjectV2, TraceV2 } from './scheduler';

type TraceStepV2 = TraceV2['steps'][number];

function admittedSource(source: SecurityNodeV2['ref']['source']): SecurityNodeV2['ref']['source'] {
  const span = source.span === null ? null : { start: { ...source.span.start }, end: { ...source.span.end } };
  return { pointer: source.pointer, occurrencePath: Array.prototype.slice.call(source.occurrencePath) as number[], astNodeId: source.astNodeId, span };
}
/** Trace subjects carry only identity and source; display labels remain outside the trace contract. */
function traceNode(ref: SecurityNodeV2['ref']): SubjectV2 {
  return { kind: 'NODE', node: { ordinal: ref.ordinal, source: admittedSource(ref.source), identityDigest: ref.identityDigest } };
}
function resolveNode(nodes: readonly SecurityNodeV2[], id: string): SecurityNodeV2 | undefined {
  const byId = nodes.filter((node) => node.ref.explicitId === id);
  const byName = nodes.filter((node) => node.ref.name === id);
  if (byId.length > 1 || byName.length > 1) return undefined;
  const idNode = byId[0]; const nameNode = byName[0];
  if (idNode !== undefined && nameNode !== undefined && idNode !== nameNode) return undefined;
  return idNode ?? nameNode;
}

/**
 * Projects a reviewed taint finding's bounded node path into the canonical trace contract.
 * The source and sink steps carry the finding's admitted facts; intermediate nodes carry none.
 * A missing or non-empty path resolves to no trace rather than a guessed witness.
 */
export function candidateTrace(
  finding: ScanFinding,
  context: AnalyzerContextV2,
  factRefs: readonly string[],
  maxSteps = 64,
): TraceV2 | undefined {
  const rawPath = finding.evidence.tracePath;
  const limit = Number.isSafeInteger(maxSteps) && maxSteps >= 0 ? Math.min(maxSteps, 10_000) : 64;
  if (!Array.isArray(rawPath) || rawPath.length < 2 || rawPath.length > limit || factRefs.length === 0) return undefined;
  const path: SecurityNodeV2[] = [];
  for (const id of rawPath) {
    if (typeof id !== 'string') return undefined;
    const node = resolveNode(context.workflow.nodes, id);
    if (node === undefined) return undefined;
    path.push(node);
  }
  const last = path.length - 1;
  const steps: TraceStepV2[] = path.map((node, index) => ({
    ordinal: index,
    kind: index === 0 ? 'SOURCE' : index === last ? 'SINK' : 'PROPAGATION',
    subject: traceNode(node.ref),
    factRefs: index === 0 || index === last ? Object.freeze([...factRefs]) : Object.freeze([]),
  }));
  const kind = 'INTEGRITY' as const;
  const traceId = createCandidateTraceId({ kind, steps });
  return Object.freeze({ traceId, kind, steps: Object.freeze(steps) });
}
