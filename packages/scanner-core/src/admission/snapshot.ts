import { SCANNER_LIMITS_V2_SCHEMA_VERSION, type ScannerLimitsV2 } from '@hub/contracts';
import type { AnalysisDiagnosticV2 } from '../diagnostics/registry';
import { parseSourceDocument } from '../source/source-parser';
import type { ReadonlySourceDocumentV2, SourceMemberRefV2, SourcePositionV2 } from '../source/source-types';
import type { EdgeRefV2, NodeRefV2 } from '../workflow-v2/security-workflow';
import type { CapabilityCandidateV2, FindingCandidateV2, SafeFactV2, SubjectV2, TraceV2 } from '../capabilities/scheduler';

declare const scannerAdmissionBrandV2: unique symbol;
export type ScannerAdmissionSnapshotV2<T> = Readonly<T> & { readonly [scannerAdmissionBrandV2]: 'private' };
export type AdmissionSnapshotResultV2<T> =
  | { ok: true; snapshot: ScannerAdmissionSnapshotV2<T> }
  | { ok: false; code: 'UNSAFE_INPUT' | 'LIMIT_EXCEEDED' };
export type ParserOwnedAdmissionBoundaryV2 = {
  fromBoundedBytes(bytes: Uint8Array, limits: ScannerLimitsV2): AdmissionSnapshotResultV2<ReadonlySourceDocumentV2>;
};

const admittedSnapshotsV2 = new WeakSet<object>();
const unsafeInput = Object.freeze({ ok: false, code: 'UNSAFE_INPUT' } as const);
const limitExceeded = Object.freeze({ ok: false, code: 'LIMIT_EXCEEDED' } as const);
export function isScannerAdmissionSnapshotV2<T = unknown>(value: unknown): value is ScannerAdmissionSnapshotV2<T> {
  return typeof value === 'object' && value !== null && admittedSnapshotsV2.has(value);
}
function brandSnapshot<T extends object>(value: T): ScannerAdmissionSnapshotV2<T> {
  admittedSnapshotsV2.add(value);
  if (!isScannerAdmissionSnapshotV2<T>(value)) throw new TypeError();
  return value;
}

function freezeGraph<T extends object>(value: T): T {
  const stack: object[] = [value]; const seen = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const key of Object.getOwnPropertyNames(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor && 'value' in descriptor && descriptor.value !== null && typeof descriptor.value === 'object') stack.push(descriptor.value);
    }
    Object.freeze(current);
  }
  return value;
}

function readLimitNumber(input: object, field: string): number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(input, field);
  if (!descriptor || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) return undefined;
  return descriptor.value;
}
function readLimitSchemaVersion(input: object): typeof SCANNER_LIMITS_V2_SCHEMA_VERSION | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(input, 'schemaVersion');
  return descriptor && 'value' in descriptor && descriptor.value === SCANNER_LIMITS_V2_SCHEMA_VERSION ? SCANNER_LIMITS_V2_SCHEMA_VERSION : undefined;
}
function normalizeLimits(input: unknown): ScannerLimitsV2 | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return undefined;
  const schemaVersion = readLimitSchemaVersion(input);
  const maxBytes = readLimitNumber(input, 'maxBytes'); const maxNodes = readLimitNumber(input, 'maxNodes');
  const maxEdges = readLimitNumber(input, 'maxEdges'); const maxConnectionDepth = readLimitNumber(input, 'maxConnectionDepth');
  const maxParameterDepth = readLimitNumber(input, 'maxParameterDepth'); const maxParameterLeaves = readLimitNumber(input, 'maxParameterLeaves');
  const workerDeadlineMs = readLimitNumber(input, 'workerDeadlineMs'); const maxSyntaxNodes = readLimitNumber(input, 'maxSyntaxNodes');
  const maxDocumentDepth = readLimitNumber(input, 'maxDocumentDepth'); const maxMembersAndElements = readLimitNumber(input, 'maxMembersAndElements');
  const maxRawEdges = readLimitNumber(input, 'maxRawEdges'); const maxDuplicateKeys = readLimitNumber(input, 'maxDuplicateKeys');
  const maxDiagnostics = readLimitNumber(input, 'maxDiagnostics'); const maxStoredSourceSpans = readLimitNumber(input, 'maxStoredSourceSpans');
  const maxSourceWork = readLimitNumber(input, 'maxSourceWork');
  const maxExpressionTokens = readLimitNumber(input, 'maxExpressionTokens'); const maxCodeSyntaxNodes = readLimitNumber(input, 'maxCodeSyntaxNodes');
  const maxGraphOperations = readLimitNumber(input, 'maxGraphOperations'); const maxTaintStates = readLimitNumber(input, 'maxTaintStates');
  const maxTraceStepsPerFinding = readLimitNumber(input, 'maxTraceStepsPerFinding'); const maxFindings = readLimitNumber(input, 'maxFindings');
  const maxRedactionPatches = readLimitNumber(input, 'maxRedactionPatches'); const maxRedactedArtifactBytes = readLimitNumber(input, 'maxRedactedArtifactBytes');
  const maxEvidenceBytes = readLimitNumber(input, 'maxEvidenceBytes'); const maxSerializedResultBytes = readLimitNumber(input, 'maxSerializedResultBytes');
  const maxRuleOperations = readLimitNumber(input, 'maxRuleOperations');
  if (schemaVersion === undefined || maxDiagnostics === undefined || maxDiagnostics < 1 || maxBytes === undefined || maxNodes === undefined ||
    maxEdges === undefined || maxConnectionDepth === undefined || maxParameterDepth === undefined || maxParameterLeaves === undefined ||
    workerDeadlineMs === undefined || maxSyntaxNodes === undefined || maxDocumentDepth === undefined || maxMembersAndElements === undefined ||
    maxRawEdges === undefined || maxDuplicateKeys === undefined || maxStoredSourceSpans === undefined || maxSourceWork === undefined || maxExpressionTokens === undefined ||
    maxCodeSyntaxNodes === undefined || maxGraphOperations === undefined || maxTaintStates === undefined || maxTraceStepsPerFinding === undefined ||
    maxFindings === undefined || maxRedactionPatches === undefined || maxRedactedArtifactBytes === undefined || maxEvidenceBytes === undefined ||
    maxSerializedResultBytes === undefined || maxRuleOperations === undefined) return undefined;
  return Object.freeze({ schemaVersion, maxBytes, maxNodes, maxEdges, maxConnectionDepth, maxParameterDepth, maxParameterLeaves, workerDeadlineMs,
    maxSyntaxNodes, maxDocumentDepth, maxMembersAndElements, maxRawEdges, maxDuplicateKeys, maxDiagnostics, maxStoredSourceSpans,
    maxSourceWork, maxExpressionTokens, maxCodeSyntaxNodes, maxGraphOperations, maxTaintStates, maxTraceStepsPerFinding, maxFindings, maxRedactionPatches,
    maxRedactedArtifactBytes, maxEvidenceBytes, maxSerializedResultBytes, maxRuleOperations });
}

function fromBoundedBytes(bytes: Uint8Array, limits: ScannerLimitsV2): AdmissionSnapshotResultV2<ReadonlySourceDocumentV2> {
  try {
    const normalizedLimits = normalizeLimits(limits);
    if (normalizedLimits === undefined) return unsafeInput;
    const parsed = parseSourceDocument(bytes, normalizedLimits);
    if (!parsed.ok) return parsed.code === 'WORKFLOW_TOO_LARGE' || parsed.code === 'WORKFLOW_TOO_COMPLEX' ? limitExceeded : unsafeInput;
    return Object.freeze({ ok: true, snapshot: brandSnapshot(freezeGraph(parsed.document)) });
  } catch { return unsafeInput; }
}

function copyPosition(input: SourcePositionV2): SourcePositionV2 {
  return Object.freeze({ line: input.line, column: input.column, utf16Offset: input.utf16Offset, utf8ByteOffset: input.utf8ByteOffset });
}
function copyMemberRef(input: SourceMemberRefV2): SourceMemberRefV2 {
  const span = input.span === null ? null : Object.freeze({ start: copyPosition(input.span.start), end: copyPosition(input.span.end) });
  return Object.freeze({ pointer: input.pointer, occurrencePath: Object.freeze(input.occurrencePath.map((item) => item)), astNodeId: input.astNodeId, span });
}
function copyNode(input: NodeRefV2): NodeRefV2 {
  const copy: NodeRefV2 = { ordinal: input.ordinal, source: copyMemberRef(input.source), identityDigest: input.identityDigest };
  if (input.explicitId !== undefined) copy.explicitId = input.explicitId;
  if (input.name !== undefined) copy.name = input.name;
  return Object.freeze(copy);
}
function copyEdge(input: EdgeRefV2): EdgeRefV2 {
  const copy: EdgeRefV2 = { ordinal: input.ordinal, sourceLabel: input.sourceLabel, connectionType: input.connectionType, sourcePort: input.sourcePort,
    targetPort: input.targetPort, source: copyMemberRef(input.source), resolution: input.resolution };
  if (input.sourceNode !== undefined) copy.sourceNode = copyNode(input.sourceNode);
  if (input.targetNode !== undefined) copy.targetNode = copyNode(input.targetNode);
  if (input.targetLabel !== undefined) copy.targetLabel = input.targetLabel;
  return Object.freeze(copy);
}
function copySubject(input: SubjectV2): SubjectV2 {
  if (input.kind === 'WORKFLOW') return Object.freeze({ kind: 'WORKFLOW' });
  if (input.kind === 'NODE') return Object.freeze({ kind: 'NODE', node: copyNode(input.node) });
  if (input.kind === 'EDGE') return Object.freeze({ kind: 'EDGE', edge: copyEdge(input.edge) });
  return Object.freeze({ kind: 'SOURCE', source: copyMemberRef(input.source) });
}

type SafeFactScalarV2 = string | number | boolean | null;
type SafeFactPropertyV2 = SafeFactScalarV2 | readonly SafeFactScalarV2[];
function copyFact(input: SafeFactV2): SafeFactV2 {
  const properties: Record<string, SafeFactPropertyV2> = {};
  for (const key of Object.keys(input.properties)) {
    const value = input.properties[key]; properties[key] = Array.isArray(value) ? Object.freeze(value.map((item) => item)) : value;
  }
  return Object.freeze({ factId: input.factId, kind: input.kind, subject: copySubject(input.subject), properties: Object.freeze(properties) });
}
function copyFinding(input: FindingCandidateV2): FindingCandidateV2 {
  return Object.freeze({ ruleId: input.ruleId, evidenceClass: input.evidenceClass, conclusion: input.conclusion, applicability: input.applicability,
    subject: copySubject(input.subject), factRefs: Object.freeze(input.factRefs.map((item) => item)), traceRefs: Object.freeze(input.traceRefs.map((item) => item)), remediationId: input.remediationId });
}
type MutableDiagnosticV2 = { -readonly [K in keyof AnalysisDiagnosticV2]: AnalysisDiagnosticV2[K] };
function copyDiagnostic(input: AnalysisDiagnosticV2): AnalysisDiagnosticV2 {
  const copy: MutableDiagnosticV2 = { id: input.id, code: input.code, category: input.category, capabilityId: input.capabilityId,
    aggregateEffect: input.aggregateEffect, assessmentEligible: input.assessmentEligible };
  if (input.location !== undefined) copy.location = copyMemberRef(input.location);
  if (input.observed !== undefined) copy.observed = input.observed;
  if (input.maximum !== undefined) copy.maximum = input.maximum;
  if (input.omitted !== undefined) copy.omitted = input.omitted;
  return Object.freeze(copy);
}
type TraceStepV2 = TraceV2['steps'][number];
type MutableTraceStepV2 = { -readonly [K in keyof TraceStepV2]: TraceStepV2[K] };
function copyTraceStep(input: TraceStepV2): TraceStepV2 {
  const copy: MutableTraceStepV2 = { ordinal: input.ordinal, kind: input.kind, subject: copySubject(input.subject), factRefs: Object.freeze(input.factRefs.map((item) => item)) };
  return Object.freeze(copy);
}
function copyTrace(input: TraceV2): TraceV2 {
  return Object.freeze({ traceId: input.traceId, kind: input.kind, steps: Object.freeze(input.steps.map(copyTraceStep)) });
}

export function createSafeFactAdmissionSnapshotV2(fact: SafeFactV2): ScannerAdmissionSnapshotV2<SafeFactV2> {
  return brandSnapshot(freezeGraph(copyFact(fact)));
}
export function createCapabilityCandidateAdmissionSnapshotV2(candidate: CapabilityCandidateV2): ScannerAdmissionSnapshotV2<CapabilityCandidateV2> {
  const copy = { findings: Object.freeze(candidate.findings.map(copyFinding)), diagnostics: Object.freeze(candidate.diagnostics.map(copyDiagnostic)),
    facts: Object.freeze(candidate.facts.map(copyFact)), traces: Object.freeze(candidate.traces.map(copyTrace)),
    seen: candidate.seen, analyzed: candidate.analyzed, skipped: candidate.skipped, omitted: candidate.omitted };
  return brandSnapshot(freezeGraph(Object.freeze(copy)));
}
export const ParserOwnedAdmissionBoundaryV2: ParserOwnedAdmissionBoundaryV2 = Object.freeze({ fromBoundedBytes });
