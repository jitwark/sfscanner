import type { SafeFactV2, SubjectV2 } from '../../capabilities/scheduler';
import { canonicalSubjectIdentity, createFactId, type IdentityContextV2 } from '../../result-v2/identities';
import type { NodeRefV2 } from '../../workflow-v2/security-workflow';
import { createNodeIdentityDigest } from '../../workflow-v2/node-edge-identity';
import type { SourceMemberRefV2 } from '../../source/source-types';
import type { TaintTraceStepV2 } from './transfer';

export type MaterializationPredecessor = Readonly<{ node: number; edge: number; field: string; item: number }>;
export type MaterializationStep = TaintTraceStepV2 & { predecessor?: MaterializationPredecessor };
export type AdmittedFacts = Readonly<{
  bySubject: ReadonlyMap<string, readonly string[]>;
  byId: ReadonlyMap<string, SafeFactV2>;
  subjectsByOrdinal: ReadonlyMap<number, SubjectV2>;
  invalidOrdinals: ReadonlySet<number>;
}>;

const TRACE_KINDS = new Set<MaterializationStep['kind']>(['SOURCE', 'PROPAGATION', 'SANITIZER', 'SINK']);
const DIGEST = /^[0-9a-f]{64}$/;

export function validStep(value: unknown): value is MaterializationStep {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!TRACE_KINDS.has(candidate.kind as MaterializationStep['kind'])
    || !Number.isSafeInteger(candidate.node) || (candidate.node as number) < 0
    || typeof candidate.field !== 'string' || candidate.field.length > 2_048
    || !Number.isSafeInteger(candidate.port) || (candidate.port as number) < 0
    || !Number.isSafeInteger(candidate.item) || (candidate.item as number) < 0) return false;
  if (!('predecessor' in candidate) || candidate.predecessor === undefined) return true;
  return validPredecessor(candidate.predecessor);
}

function validPredecessor(value: unknown): value is MaterializationPredecessor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Number.isSafeInteger(candidate.node) && (candidate.node as number) >= 0
    && Number.isSafeInteger(candidate.edge) && (candidate.edge as number) >= 0
    && typeof candidate.field === 'string' && candidate.field.length <= 2_048
    && Number.isSafeInteger(candidate.item) && (candidate.item as number) >= 0;
}

export function admitFacts(input: readonly SafeFactV2[] | undefined, context: IdentityContextV2): AdmittedFacts {
  const bySubject = new Map<string, string[]>();
  const byId = new Map<string, SafeFactV2>();
  const subjectsByOrdinal = new Map<number, SubjectV2>();
  const invalidOrdinals = new Set<number>();
  if (input === undefined) return { bySubject, byId, subjectsByOrdinal, invalidOrdinals };
  for (const fact of input) {
    try {
      if (fact === null || typeof fact !== 'object' || typeof fact.factId !== 'string' || !DIGEST.test(fact.factId)) continue;
      const expected = createFactId({ kind: fact.kind, subject: fact.subject, properties: fact.properties }, context);
      const subjectKey = subjectIdentity(fact.subject, context);
      if (expected !== fact.factId || subjectKey === undefined) {
        if (fact.subject?.kind === 'NODE' && Number.isSafeInteger(fact.subject.node?.ordinal)) invalidOrdinals.add(fact.subject.node.ordinal);
        continue;
      }
      byId.set(fact.factId, fact);
      if (fact.subject.kind === 'NODE') subjectsByOrdinal.set(fact.subject.node.ordinal, fact.subject);
      const refs = bySubject.get(subjectKey) ?? [];
      if (!refs.includes(fact.factId)) refs.push(fact.factId);
      bySubject.set(subjectKey, refs);
    } catch {
      if (fact && typeof fact === 'object' && 'subject' in fact) {
        const subject = fact.subject;
        if (subject !== null && typeof subject === 'object' && 'kind' in subject && subject.kind === 'NODE'
          && 'node' in subject && subject.node !== null && typeof subject.node === 'object'
          && 'ordinal' in subject.node && Number.isSafeInteger(subject.node.ordinal)) invalidOrdinals.add(subject.node.ordinal);
      }
    }
  }
  for (const refs of bySubject.values()) refs.sort();
  return { bySubject, byId, subjectsByOrdinal, invalidOrdinals };
}

export function resolveSubject(
  ordinal: number,
  subjects: ReadonlyMap<number, SubjectV2> | undefined,
  facts: AdmittedFacts,
): SubjectV2 | undefined {
  let direct: SubjectV2 | undefined;
  try { direct = subjects === undefined ? undefined : subjects.get(ordinal); } catch { return undefined; }
  const candidate = safeNodeSubject(direct, ordinal) ?? safeNodeSubject(facts.subjectsByOrdinal.get(ordinal), ordinal);
  return candidate === undefined ? undefined : cloneSubject(candidate);
}

function safeNodeSubject(value: SubjectV2 | undefined, ordinal: number): SubjectV2 | undefined {
  try {
    if (value?.kind !== 'NODE' || value.node.ordinal !== ordinal || !safeNodeRef(value.node)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function safeNodeRef(value: NodeRefV2): boolean {
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 0 || !DIGEST.test(value.identityDigest)
    || !safeSource(value.source) || value.explicitId !== undefined && !safeText(value.explicitId)
    || value.name !== undefined && !safeText(value.name)) return false;
  try { return value.identityDigest === createNodeIdentityDigest(value.ordinal, value.source); } catch { return false; }
}

function safeSource(value: SourceMemberRefV2): boolean {
  if (typeof value.pointer !== 'string' || !safeText(value.pointer) || typeof value.astNodeId !== 'string' || !DIGEST.test(value.astNodeId)
    || !Array.isArray(value.occurrencePath) || value.occurrencePath.some((item) => !Number.isSafeInteger(item) || item < 0)) return false;
  return value.span !== null && safeSpan(value.span);
}

function safeSpan(value: NonNullable<SourceMemberRefV2['span']>): boolean {
  const positions = [value.start, value.end];
  if (positions.some((position) => position === null || typeof position !== 'object')) return false;
  if (positions.some((position) => !Number.isSafeInteger(position.line) || position.line < 1 || !Number.isSafeInteger(position.column) || position.column < 1
    || !Number.isSafeInteger(position.utf16Offset) || position.utf16Offset < 0 || !Number.isSafeInteger(position.utf8ByteOffset) || position.utf8ByteOffset < 0)) return false;
  if (value.end.line < value.start.line || value.end.line === value.start.line && value.end.column <= value.start.column) return false;
  return value.end.utf16Offset > value.start.utf16Offset && value.end.utf8ByteOffset > value.start.utf8ByteOffset;
}

function safeText(value: string): boolean {
  return value.length <= 4_096 && !value.includes('\0');
}

export function subjectIdentity(subject: SubjectV2, context: IdentityContextV2): string | undefined {
  try { return canonicalSubjectIdentity(subject, context); } catch { return undefined; }
}

function cloneSubject(subject: SubjectV2): SubjectV2 | undefined {
  if (subject.kind !== 'NODE') return undefined;
  const node = subject.node;
  const source = node.source;
  const span = source.span === null ? null : Object.freeze({
    start: Object.freeze({ ...source.span.start }), end: Object.freeze({ ...source.span.end }),
  });
  const sourceCopy = Object.freeze({ pointer: source.pointer, occurrencePath: Object.freeze([...source.occurrencePath]), astNodeId: source.astNodeId, span });
  const nodeCopy = Object.freeze({ ordinal: node.ordinal, source: sourceCopy, ...(node.explicitId === undefined ? {} : { explicitId: node.explicitId }), ...(node.name === undefined ? {} : { name: node.name }), identityDigest: node.identityDigest });
  return Object.freeze({ kind: 'NODE' as const, node: nodeCopy });
}
