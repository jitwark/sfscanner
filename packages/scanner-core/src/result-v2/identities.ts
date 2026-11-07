import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { FindingV2, SafeFactV2, TraceStepV2, TraceV2 } from '../../../../contracts/scanner-v2-evidence';
import type { SubjectV2 } from '../../../../contracts/scanner-v2-source';
import { canonicalBytesV1 } from './canonical-bytes';
import { createEdgeIdentityDigest, encodeIdentityTuple } from '../workflow-v2/node-edge-identity';

type Subject = SubjectV2;
export type IdentityContextV2 = Readonly<{ semanticSha256: string }>;
export type FactIdentityInputV2 = Readonly<Pick<SafeFactV2, 'kind' | 'subject' | 'properties'>>;
export type TraceIdentityInputV2 = Readonly<Pick<TraceV2, 'kind' | 'steps'>>;
export type FindingIdentityInputV2 = Readonly<Pick<FindingV2,
  'ruleId' | 'ruleRevision' | 'evidenceClass' | 'conclusion' | 'applicability' | 'subject' | 'factRefs' | 'traceRefs'>>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DIGEST = /^[0-9a-f]{64}$/;

export function canonicalSubjectIdentity(subject: Subject, context?: IdentityContextV2): string {
  return subjectIdentity(subject, context);
}

function subjectIdentity(subject: Subject, context?: IdentityContextV2, unboundWorkflow = false): string {
  const record = exactRecord(subject, ['kind', 'node', 'edge', 'source']);
  if (record.kind === 'WORKFLOW') {
    if (Object.keys(record).length !== 1) throw new TypeError('Invalid workflow subject');
    if (unboundWorkflow) return 'WORKFLOW';
    const semanticSha256 = context?.semanticSha256;
    if (!DIGEST.test(semanticSha256 ?? '')) throw new TypeError('Workflow identity needs semanticSha256');
    return `WORKFLOW${semanticSha256}`;
  }
  if (record.kind === 'SOURCE') {
    if (Object.keys(record).length !== 2) throw new TypeError('Invalid source subject');
    const source = exactRecord(record.source, ['pointer', 'occurrencePath', 'astNodeId', 'span']);
    if (typeof source.astNodeId !== 'string' || !DIGEST.test(source.astNodeId)) throw new TypeError('Invalid source identity');
    return `SOURCE${source.astNodeId}`;
  }
  if (record.kind === 'NODE') {
    if (Object.keys(record).length !== 2) throw new TypeError('Invalid node subject');
    const node = exactRecord(record.node, ['ordinal', 'source', 'explicitId', 'name', 'identityDigest']);
    if (typeof node.identityDigest !== 'string' || !DIGEST.test(node.identityDigest)) throw new TypeError('Invalid node identity');
    return `NODE${node.identityDigest}`;
  }
  if (record.kind === 'EDGE') {
    if (Object.keys(record).length !== 2) throw new TypeError('Invalid edge subject');
    const edge = exactRecord(record.edge, ['ordinal', 'sourceNode', 'targetNode', 'sourceLabel', 'targetLabel', 'connectionType', 'sourcePort', 'targetPort', 'source', 'resolution']);
    return `EDGE${createEdgeIdentityDigest(normalizeEdge(edge))}`;
  }
  throw new TypeError('Invalid subject kind');
}

function normalizeEdge(edge: Record<string, unknown>): Parameters<typeof createEdgeIdentityDigest>[0] {
  const source = sourceDigestRecord(edge.source);
  const sourceNode = edge.sourceNode === undefined ? undefined : nodeDigestRecord(edge.sourceNode);
  const targetNode = edge.targetNode === undefined ? undefined : nodeDigestRecord(edge.targetNode);
  if (!Number.isSafeInteger(edge.ordinal) || (edge.ordinal as number) < 0 || typeof edge.sourceLabel !== 'string'
    || edge.targetLabel !== undefined && typeof edge.targetLabel !== 'string' || typeof edge.connectionType !== 'string'
    || !Number.isSafeInteger(edge.sourcePort) || (edge.sourcePort as number) < 0
    || !Number.isSafeInteger(edge.targetPort) || (edge.targetPort as number) < 0
    || !['RESOLVED', 'AMBIGUOUS', 'UNRESOLVED'].includes(edge.resolution as string)) throw new TypeError('Invalid edge identity');
  return { ordinal: edge.ordinal as number, sourceNode, targetNode, sourceLabel: edge.sourceLabel as string,
    targetLabel: edge.targetLabel as string | undefined, connectionType: edge.connectionType as string, sourcePort: edge.sourcePort as number,
    targetPort: edge.targetPort as number, source, resolution: edge.resolution as 'RESOLVED' | 'AMBIGUOUS' | 'UNRESOLVED' };
}

function sourceDigestRecord(value: unknown): Parameters<typeof createEdgeIdentityDigest>[0]['source'] {
  const source = exactRecord(value, ['pointer', 'occurrencePath', 'astNodeId', 'span']);
  if (typeof source.astNodeId !== 'string' || !DIGEST.test(source.astNodeId)) throw new TypeError('Invalid source identity');
  return source as Parameters<typeof createEdgeIdentityDigest>[0]['source'];
}

function nodeDigestRecord(value: unknown): NonNullable<Parameters<typeof createEdgeIdentityDigest>[0]['sourceNode']> {
  const node = exactRecord(value, ['ordinal', 'source', 'explicitId', 'name', 'identityDigest']);
  if (typeof node.identityDigest !== 'string' || !DIGEST.test(node.identityDigest)) throw new TypeError('Invalid node identity');
  return node as NonNullable<Parameters<typeof createEdgeIdentityDigest>[0]['sourceNode']>;
}

export function createFactId(input: FactIdentityInputV2, context?: IdentityContextV2): string {
  return factIdentity(input, context);
}

/** Candidate workflow facts remain unbound until result rekeying. */
export function createCandidateFactId(input: FactIdentityInputV2): string {
  return factIdentity(input, undefined, true);
}

function factIdentity(input: FactIdentityInputV2, context?: IdentityContextV2, unboundWorkflow = false): string {
  const value = exactRecord(input, ['factId', 'kind', 'subject', 'properties']);
  if (typeof value.kind !== 'string' || value.kind.length === 0) throw new TypeError('Invalid fact identity');
  const subject = subjectIdentity(value.subject as Subject, context, unboundWorkflow);
  const properties = text(canonicalBytesV1(value.properties));
  return digest(['secureflow-fact-id-v2', value.kind, subject, properties]);
}

export function createTraceId(input: TraceIdentityInputV2, context?: IdentityContextV2): string {
  return traceIdentity(input, context);
}

/** Candidate workflow subjects remain unbound; every other subject uses final identity rules. */
export function createCandidateTraceId(input: TraceIdentityInputV2): string {
  return traceIdentity(input, undefined, true);
}

function traceIdentity(input: TraceIdentityInputV2, context?: IdentityContextV2, unboundWorkflow = false): string {
  const value = exactRecord(input, ['traceId', 'kind', 'steps']);
  if (typeof value.kind !== 'string' || !Array.isArray(value.steps)) throw new TypeError('Invalid trace identity');
  const steps = denseArray(value.steps).map((step) => canonicalTraceStep(step as TraceStepV2, context, unboundWorkflow));
  const encoded = text(canonicalBytesV1(steps));
  return digest(['secureflow-trace-id-v2', value.kind, encoded]);
}

export function createFindingId(input: FindingIdentityInputV2, context?: IdentityContextV2): string {
  const value = exactRecord(input, ['findingId', 'ruleId', 'ruleRevision', 'effect', 'severity', 'confidence', 'evidenceClass', 'conclusion', 'applicability', 'subject', 'factRefs', 'traceRefs', 'remediationId']);
  for (const key of ['ruleId', 'ruleRevision', 'evidenceClass', 'conclusion', 'applicability'] as const) if (typeof value[key] !== 'string') throw new TypeError('Invalid finding identity');
  const factRefs = sortedReferences(value.factRefs);
  const traceRefs = sortedReferences(value.traceRefs);
  return digest(['secureflow-finding-id-v2', value.ruleId, value.ruleRevision, value.evidenceClass,
    value.conclusion, value.applicability, canonicalSubjectIdentity(value.subject as Subject, context), ...factRefs, ...traceRefs]);
}

function canonicalTraceStep(step: TraceStepV2, context?: IdentityContextV2, unboundWorkflow = false): Record<string, unknown> {
  const value = exactRecord(step, ['ordinal', 'kind', 'subject', 'factRefs']);
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 0 || typeof value.kind !== 'string') throw new TypeError('Invalid trace step');
  return { ordinal: value.ordinal, kind: value.kind, subject: subjectIdentity(value.subject as Subject, context, unboundWorkflow), factRefs: sortedReferences(value.factRefs) };
}

function sortedReferences(value: unknown): string[] {
  const result = denseArray(value);
  if (result.some((item) => typeof item !== 'string' || !DIGEST.test(item as string))) throw new TypeError('Invalid identity reference');
  const strings = result as string[];
  strings.sort();
  for (let index = 1; index < strings.length; index += 1) if (strings[index] === strings[index - 1]) throw new TypeError('Duplicate identity reference');
  return strings;
}

function denseArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError('Invalid identity array');
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0) throw new TypeError('Invalid identity array');
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== length.value + 1 || names.some((name) => name !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(name) || Number(name) >= length.value)) throw new TypeError('Invalid identity array');
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) throw new TypeError('Invalid identity array');
    result.push(descriptor.value);
  }
  return result;
}

function exactRecord(value: unknown, allowed: readonly string[]): Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid identity record');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError('Unsafe identity record');
  const output: Record<string, any> = {};
  for (const name of Object.getOwnPropertyNames(value)) {
    if (!allowed.includes(name)) throw new TypeError('Unknown identity property');
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('Accessor identity property');
    output[name] = descriptor.value;
  }
  return output;
}

function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function digest(parts: readonly string[]): string {
  return bytesToHex(sha256(encoder.encode(encodeIdentityTuple(parts))));
}
