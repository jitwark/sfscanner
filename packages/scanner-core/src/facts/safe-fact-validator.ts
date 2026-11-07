import type { ScannerLimitsV2 } from '@hub/contracts';
import { isFieldFlowFactKindV1 } from '@hub/contracts/scanner-v2-field-flow';
import {
  readFieldFlowPropertiesV1, validateFieldFlowSubject,
  SAFE_FACT_SECRET_PATTERN as SECRET, SAFE_FACT_PATH_PATTERN as PATH, SAFE_FACT_PROSE_PATTERN as PROSE,
} from '@hub/contracts/scanner-v2-field-flow-validation';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalizeJson } from '../canonical-json';
import { readAdvisoryFactPropertiesV1 } from '../advisories/advisory-fact-properties';
import { createEdgeIdentityDigest, createNodeIdentityDigest } from '../workflow-v2/node-edge-identity';
import type { SafeFactV2, SubjectV2 } from '../capabilities/scheduler';
import type { EdgeRefV2, NodeRefV2 } from '../workflow-v2/security-workflow';
import type { SourceMemberRefV2, SourcePositionV2, SourceSpanV2 } from '../source/source-types';
import { createSafeFactAdmissionSnapshotV2, isScannerAdmissionSnapshotV2 } from '../admission/snapshot';
import {
  SAFE_FACT_ENUMS_V2, SAFE_FACT_REGISTRY_V2, SAFE_FACT_REQUIRED_PROPERTIES_V2, SAFE_FACT_SPAN_POLICIES_V2,
  SAFE_FACT_SUBJECT_KINDS_V2, type SafeFactSchemaV2,
} from './safe-fact-registry';

export type SafeFactRejectionReasonV2 = 'UNKNOWN_FACT_KIND' | 'UNKNOWN_PROPERTY' | 'INVALID_PROPERTY' | 'INVALID_SUBJECT' | 'FORBIDDEN_CONTENT' | 'LIMIT_EXCEEDED' | 'UNSAFE_INPUT' | 'REGISTRY_MISMATCH';
export type SafeFactValidationResultV2 = Readonly<{ ok: true; fact: SafeFactV2 } | { ok: false; code: 'SAFE_FACT_REJECTED'; reason: SafeFactRejectionReasonV2 }>;
export type SafeFactSubjectV2 = Readonly<SubjectV2>;
type Bad = SafeFactRejectionReasonV2;
type Property = string | number | boolean | null | readonly (string | number | boolean | null)[];
type RecordValue = Record<string, unknown>;

const LIMITS = ['schemaVersion', 'maxBytes', 'maxNodes', 'maxEdges', 'maxConnectionDepth', 'maxParameterDepth', 'maxParameterLeaves', 'workerDeadlineMs', 'maxSyntaxNodes', 'maxDocumentDepth', 'maxMembersAndElements', 'maxRawEdges', 'maxDuplicateKeys', 'maxDiagnostics', 'maxStoredSourceSpans', 'maxSourceWork', 'maxExpressionTokens', 'maxCodeSyntaxNodes', 'maxGraphOperations', 'maxTaintStates', 'maxTraceStepsPerFinding', 'maxFindings', 'maxRedactionPatches', 'maxRedactedArtifactBytes', 'maxEvidenceBytes', 'maxSerializedResultBytes', 'maxRuleOperations'] as const;
const FACT_KEYS = ['factId', 'kind', 'subject', 'properties'];
const CODE = /\b(?:require|import|export|const|let|var|function|return|class)\b|\bprocess\.env\b|\bconsole\.[A-Za-z_$][\w$]*\s*\(|\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(|\(\s*["']/;
function fail(reason: Bad): never { throw reason; }
export function readPlainRecord(input: unknown, allowed: readonly string[], required: readonly string[] = allowed, rejectSymbols = true): RecordValue { const value = record(input, allowed, 'UNKNOWN_PROPERTY'); if (!rejectSymbols && Object.getOwnPropertySymbols(value).length !== 0) fail('UNSAFE_INPUT'); for (const key of required) data(value, key, 'INVALID_PROPERTY'); return value; }
export function readArrayLength(input: unknown, maximum: number, dense = true): number { if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail('UNSAFE_INPUT'); const descriptor = Object.getOwnPropertyDescriptor(input, 'length'); if (!descriptor || !('value' in descriptor)) fail('UNSAFE_INPUT'); const length = integer(descriptor.value, 0, 'UNSAFE_INPUT'); if (length > maximum) fail('LIMIT_EXCEEDED'); if (dense) readDenseArray(input, maximum); return length; }
export function readArrayItem(input: unknown, index: number): unknown { if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail('UNSAFE_INPUT'); return data(input, String(index), 'UNSAFE_INPUT'); }
export function readDenseArray(input: unknown, maximum: number): unknown[] { const length = readArrayLength(input, maximum, false); const names = Object.getOwnPropertyNames(input as object); if (names.length !== length + 1 || Object.getOwnPropertySymbols(input as object).length !== 0) fail('UNSAFE_INPUT'); for (const name of names) if (name !== 'length' && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= length)) fail('UNSAFE_INPUT'); const output: unknown[] = []; for (let index = 0; index < length; index += 1) output.push(readArrayItem(input, index)); return output; }
export function readSourceMemberRef(input: unknown, limits: ScannerLimitsV2): SourceMemberRefV2 { return sourceRef(input, { maxMembersAndElements: limits.maxMembersAndElements, maxStoredSourceSpans: limits.maxStoredSourceSpans }, true); }
export function readSubject(input: unknown, limits: ScannerLimitsV2): SafeFactSubjectV2 { return subject(input, '', { maxNodes: limits.maxNodes, maxMembersAndElements: limits.maxMembersAndElements, maxStoredSourceSpans: limits.maxStoredSourceSpans }); }
export function freezeData<T>(value: T): T { if (value !== null && typeof value === 'object') { for (const key of Object.getOwnPropertyNames(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (descriptor && 'value' in descriptor) freezeData(descriptor.value); } Object.freeze(value); } return value; }
function data(input: object, key: string, missing: Bad = 'UNSAFE_INPUT'): unknown { const descriptor = Object.getOwnPropertyDescriptor(input, key); if (!descriptor) fail(missing); if (!('value' in descriptor)) fail('UNSAFE_INPUT'); return descriptor.value; }
function record(input: unknown, allowed: readonly string[], unknownReason: Bad, maximum?: number): RecordValue {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) fail('UNSAFE_INPUT');
  const value = input as RecordValue; const names = Object.getOwnPropertyNames(value);
  if (maximum !== undefined && names.length > maximum) fail('LIMIT_EXCEEDED'); if (Object.getOwnPropertySymbols(value).length !== 0) fail('UNSAFE_INPUT');
  for (const name of names) if (!allowed.includes(name)) fail(unknownReason); for (const name of names) data(value, name);
  return value;
}
function exactRecord(input: unknown, keys: readonly string[], reason: Bad): RecordValue { const value = record(input, keys, reason); if (Object.getOwnPropertyNames(value).length !== keys.length) fail(reason); return value; }
function integer(input: unknown, minimum = 0, reason: Bad = 'INVALID_PROPERTY'): number { if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum) fail(reason); return input; }
function utf8Bytes(value: string, maximum: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index); const next = value.charCodeAt(index + 1);
    if (code === 0 || code >= 0xdc00 && code <= 0xdfff || code >= 0xd800 && code <= 0xdbff && (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff)) fail('FORBIDDEN_CONTENT');
    if (code >= 0xd800) { bytes += 4; index += 1; } else bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    if (bytes > maximum) fail('LIMIT_EXCEEDED');
  } return bytes; }
function stringValue(input: unknown, maximum: number): string { if (typeof input !== 'string') fail('INVALID_PROPERTY'); utf8Bytes(input, maximum); return input; }
function safeText(input: unknown, maximum: number): string { const value = stringValue(input, maximum); if (SECRET.test(value) || PROSE.test(value) || PATH.test(value) || CODE.test(value)) fail('FORBIDDEN_CONTENT'); return value; }
// A display name is text the user chose, so every visible class is admissible: letters, marks,
// numbers, punctuation, symbols, and spaces. Only the invisible classes stay refused — control,
// format, surrogate, private-use, unassigned, and line/paragraph separators — with the two text
// joiners exempted because ZWJ and ZWNJ compose real scripts and emoji sequences. `INVISIBLE`
// exempts them by inspection, so `JOINERS_ONLY` keeps an all-joiner string (invisible content) out.
const INVISIBLE = /(?![\u200C\u200D])[\p{C}\p{Zl}\p{Zp}]/u;
const JOINERS_ONLY = /^[\u200C\u200D]*$/u;
function display(input: unknown, maximum: number): string { const value = safeText(input, maximum); if (INVISIBLE.test(value) || JOINERS_ONLY.test(value)) fail('FORBIDDEN_CONTENT'); return value; }
function pointer(input: unknown): string { const value = stringValue(input, 2_048); if (!/^(?:|\/(?:[^~]|~0|~1)*)$/.test(value)) fail('INVALID_PROPERTY'); return value; }
export function readSafeFactStringV2(kind: string, key: string, input: unknown, maximum: number): string {
  if (key === 'member') { const value = stringValue(input, maximum); if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) || SECRET.test(value)) fail('FORBIDDEN_CONTENT'); return value; }
  if (key === 'header') { const value = stringValue(input, maximum); if (!/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(value)) fail('FORBIDDEN_CONTENT'); return value; }
  if (key === 'parameterPath' || key === 'propertyPath') return pointer(input);
  if (key === 'referenceRoot') { const value = stringValue(input, maximum); const parts = value.split('.'); const first = parts.shift() ?? ''; const valid = (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(first) || /^[A-Z][A-Z0-9_]*$/.test(first)) && parts.every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part)); if (!valid) fail('FORBIDDEN_CONTENT'); return value; }
  if (key === 'nodeType' || key === 'nodeTypes') { const value = stringValue(input, maximum); if (!/^@?[A-Za-z0-9][A-Za-z0-9._/@-]*\.[A-Za-z0-9_$-]+$/.test(value) || SECRET.test(value)) fail('FORBIDDEN_CONTENT'); return value; }
  if (key === 'nodePackage') { const value = stringValue(input, maximum); if (!/^@?[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || SECRET.test(value)) fail('FORBIDDEN_CONTENT'); return value; }
  if (key === 'sourceNodeId') { const value = stringValue(input, maximum); if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value) || SECRET.test(value)) fail('FORBIDDEN_CONTENT'); return value; }
  if (key === 'sourceNodeName' || key === 'sourceLabel' || key === 'targetLabel' || key === 'connectionType') return display(input, maximum);
  if (kind === 'integration.v1' && key === 'service') { const value = display(input, maximum); if (/\b(?:api[ _-]*key|password|secret|credential|authorization|cookie|bearer|basic auth|token)\b/i.test(value)) fail('FORBIDDEN_CONTENT'); return value; }
  return safeText(input, maximum);
}
function enumValue(input: unknown, key: string, kind: string, maximum: number): string { const value = stringValue(input, maximum); const enumKey = kind === 'node.configuration.v2' && key === 'indicator' ? 'configurationIndicator' : key === 'capabilities' ? 'capability' : key === 'taintLabels' ? 'taintLabel' : key === 'reason' ? 'destinationReason' : key === 'errorCode' ? 'destinationErrorCode' : key; const values = SAFE_FACT_ENUMS_V2[enumKey]; if (values === undefined || !values.includes(value)) fail('INVALID_PROPERTY'); return value; }
function boundedLimit(input: unknown, key: string): number {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) fail('UNSAFE_INPUT');
  const value = data(input, key);
  if (key === 'schemaVersion') { if (value !== 'scanner-limits-v2') fail('UNSAFE_INPUT'); return 0; }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || key === 'maxDiagnostics' && value < 1) fail('UNSAFE_INPUT');
  return value;
}
function limitsSnapshot(input: unknown): Record<string, number> { const result: Record<string, number> = {}; for (const key of LIMITS) result[key] = boundedLimit(input, key); return result; }
function arrayValue(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail('UNSAFE_INPUT');
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length'); if (!lengthDescriptor || !('value' in lengthDescriptor)) fail('UNSAFE_INPUT'); const length = integer(lengthDescriptor.value, 0, 'UNSAFE_INPUT'); if (length > maximum) fail('LIMIT_EXCEEDED');
  const names = Object.getOwnPropertyNames(input); if (names.length !== length + 1 || Object.getOwnPropertySymbols(input).length !== 0) fail('UNSAFE_INPUT'); for (const name of names) if (name !== 'length' && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= length)) fail('UNSAFE_INPUT');
  const result: unknown[] = []; for (let index = 0; index < length; index += 1) result.push(data(input, String(index), 'UNSAFE_INPUT')); return result;
}
function position(input: unknown): SourcePositionV2 { const value = exactRecord(input, ['line', 'column', 'utf16Offset', 'utf8ByteOffset'], 'INVALID_SUBJECT'); return { line: integer(data(value, 'line', 'INVALID_SUBJECT'), 1), column: integer(data(value, 'column', 'INVALID_SUBJECT'), 1), utf16Offset: integer(data(value, 'utf16Offset', 'INVALID_SUBJECT')), utf8ByteOffset: integer(data(value, 'utf8ByteOffset', 'INVALID_SUBJECT')) }; }
function sourceRef(input: unknown, limits: Record<string, number>, allowSpan: boolean): SourceMemberRefV2 { const value = exactRecord(input, ['pointer', 'occurrencePath', 'astNodeId', 'span'], 'INVALID_SUBJECT');
  const occurrencePath = arrayValue(data(value, 'occurrencePath', 'INVALID_SUBJECT'), limits.maxMembersAndElements).map((item) => integer(item, 0, 'INVALID_SUBJECT'));
  const astNodeId = stringValue(data(value, 'astNodeId', 'INVALID_SUBJECT'), 64);
  if (!/^[0-9a-f]{64}$/.test(astNodeId)) fail('INVALID_SUBJECT');
  const rawSpan = data(value, 'span', 'INVALID_SUBJECT'); let span: SourceSpanV2 | null = null;
  if (rawSpan !== null) {
    if (!allowSpan) fail('INVALID_SUBJECT'); if (limits.maxStoredSourceSpans < 1) fail('LIMIT_EXCEEDED');
    const spanValue = exactRecord(rawSpan, ['start', 'end'], 'INVALID_SUBJECT'); const start = position(data(spanValue, 'start', 'INVALID_SUBJECT')); const end = position(data(spanValue, 'end', 'INVALID_SUBJECT'));
    if (!(end.line > start.line || end.line === start.line && end.column > start.column) || end.utf16Offset <= start.utf16Offset || end.utf8ByteOffset <= start.utf8ByteOffset) fail('INVALID_SUBJECT'); span = { start, end };
  }
  return { pointer: pointer(data(value, 'pointer', 'INVALID_SUBJECT')), occurrencePath, astNodeId, span };
}
function nodeRef(input: unknown, limits: Record<string, number>, allowSpan: boolean): NodeRefV2 { const value = record(input, ['ordinal', 'source', 'identityDigest', 'explicitId', 'name'], 'INVALID_SUBJECT');
  const ordinal = integer(data(value, 'ordinal', 'INVALID_SUBJECT'));
  if (ordinal >= limits.maxNodes) fail('LIMIT_EXCEEDED');
  const source = sourceRef(data(value, 'source', 'INVALID_SUBJECT'), limits, allowSpan);
  const identityDigest = stringValue(data(value, 'identityDigest', 'INVALID_SUBJECT'), 64);
  if (!/^[0-9a-f]{64}$/.test(identityDigest) || identityDigest !== createNodeIdentityDigest(ordinal, source)) fail('INVALID_SUBJECT');
  const result: NodeRefV2 = { ordinal, source, identityDigest };
  if (Object.prototype.hasOwnProperty.call(value, 'explicitId')) result.explicitId = display(data(value, 'explicitId'), 4_096);
  if (Object.prototype.hasOwnProperty.call(value, 'name')) result.name = display(data(value, 'name'), 4_096);
  return result;
}
function subject(input: unknown, kind: string, limits: Record<string, number>): SafeFactSubjectV2 {
  const value = record(input, ['kind', 'node', 'source'], 'INVALID_SUBJECT');
  const subjectKind = data(value, 'kind', 'INVALID_SUBJECT');
  const allowSpan = kind === '' || SAFE_FACT_SPAN_POLICIES_V2[kind] === 'OPTIONAL_HALF_OPEN';
  if (subjectKind === 'WORKFLOW') { exactRecord(value, ['kind'], 'INVALID_SUBJECT'); return { kind: 'WORKFLOW' }; }
  if (subjectKind === 'NODE') { exactRecord(value, ['kind', 'node'], 'INVALID_SUBJECT'); return { kind: 'NODE', node: nodeRef(data(value, 'node', 'INVALID_SUBJECT'), limits, allowSpan) }; }
  if (subjectKind === 'SOURCE') { exactRecord(value, ['kind', 'source'], 'INVALID_SUBJECT'); return { kind: 'SOURCE', source: sourceRef(data(value, 'source', 'INVALID_SUBJECT'), limits, allowSpan) }; }
  fail('INVALID_SUBJECT');
}
function properties(kind: string, schema: SafeFactSchemaV2, input: unknown, limits: Record<string, number>): Record<string, Property> {
  const allowed = Object.getOwnPropertyNames(schema.properties);
  const value = record(input, allowed, 'UNKNOWN_PROPERTY', limits.maxMembersAndElements);
  const required = SAFE_FACT_REQUIRED_PROPERTIES_V2[kind]; if (required === undefined) fail('UNKNOWN_FACT_KIND');
  for (const key of required) data(value, key, 'INVALID_PROPERTY');
  if (isFieldFlowFactKindV1(kind)) {
    const output = readFieldFlowPropertiesV1(kind, value);
    if (output === undefined) fail('INVALID_PROPERTY');
    for (const item of Object.values(output)) if (Array.isArray(item) && item.length > limits.maxMembersAndElements) fail('LIMIT_EXCEEDED');
    return output;
  }
  const advisory = readAdvisoryFactPropertiesV1(kind, value);
  if (advisory !== undefined) return advisory as Record<string, Property>;
  if (kind.startsWith('advisory.')) fail('UNKNOWN_FACT_KIND');
  const observation = kind === 'node.configuration.v2' ? enumValue(data(value, 'observation', 'INVALID_PROPERTY'), 'observation', kind, schema.maxStringBytes) : undefined;
  if (observation === 'AUTH_HEADER') exactRecord(value, ['observation', 'header', 'literalValue'], 'INVALID_PROPERTY');
  if (observation === 'SECRET_INDICATOR') exactRecord(value, ['observation', 'parameterPath', 'secretKind', 'indicator', 'hasLiteralValue'], 'INVALID_PROPERTY');
  let malformedAuth = false;
  if (kind === 'ingress.v2') {
    const auth = data(value, 'authentication', 'INVALID_PROPERTY');
    if (auth !== null) { try { const text = stringValue(auth, schema.maxStringBytes); malformedAuth = !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(text) || SECRET.test(text) || PATH.test(text); } catch { malformedAuth = true; } }
  }
  const output: Record<string, Property> = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || malformedAuth && key !== 'authentication') continue;
    const raw = data(value, key); const type = schema.properties[key];
    if (kind === 'code.indicator.v2' && key === 'member') {
      if (typeof raw !== 'string') continue;
      try { output[key] = readSafeFactStringV2(kind, key, raw, schema.maxStringBytes); } catch (error) {
        if (error === 'LIMIT_EXCEEDED' || raw.includes('\0') || /(?:https?|ftp):\/\//i.test(raw)) continue;
        throw error;
      }
      continue;
    }
    if (kind === 'ingress.v2' && key === 'authentication' && malformedAuth) { output[key] = null; continue; }
    if (type === 'STRING') output[key] = ['businessCategory', 'confidence', 'namespaceClass', 'language', 'parseState', 'flowKind', 'sink', 'scheme', 'authorityState', 'valueMode', 'authenticationState', 'applicability', 'reviewState', 'observation', 'secretKind', 'indicator', 'reason', 'inventoryStatus'].includes(key) ? enumValue(raw, key, kind, schema.maxStringBytes) : readSafeFactStringV2(kind, key, raw, schema.maxStringBytes);
    else if (type === 'NULLABLE_STRING') output[key] = raw === null ? null : key === 'hostname' ? stringValue(raw, 253) : readSafeFactStringV2(kind, key, raw, schema.maxStringBytes);
    else if (type === 'BOOLEAN') { if (typeof raw !== 'boolean') fail('INVALID_PROPERTY'); output[key] = raw; }
    else if (type === 'INTEGER') output[key] = integer(raw, key === 'nodeCount' ? 1 : 0);
    else if (type === 'STRING_LIST') {
      const maximum = kind === 'workflow.risk-summary.v1' || key === 'riskNotes' ? 3 : kind === 'integration.v1' && key === 'nodeTypes' ? Math.min(schema.maxItems, limits.maxNodes) : Math.min(schema.maxItems, limits.maxMembersAndElements);
      output[key] = Object.freeze(arrayValue(raw, maximum).map((item) => ['capabilities', 'taintLabels'].includes(key) ? enumValue(item, key, kind, schema.maxStringBytes) : key === 'errorCodes' ? enumValue(item, 'errorCode', kind, schema.maxStringBytes) : readSafeFactStringV2(kind, key, item, schema.maxStringBytes)));
    } else if (type === 'INTEGER_LIST') output[key] = Object.freeze(arrayValue(raw, Math.min(schema.maxItems, limits.maxMembersAndElements)).map((item) => integer(item)));
    else fail('REGISTRY_MISMATCH');
  }
  if (malformedAuth) return { authentication: null, authenticationState: 'UNKNOWN', legacyAuthenticated: false };
  if (kind === 'code.indicator.v2' && typeof output.start === 'number' && typeof output.end === 'number' && output.start >= output.end) fail('INVALID_PROPERTY');
  if (kind === 'workflow.fingerprint.v1' && (typeof output.value !== 'string' || !/^[0-9a-f]{64}$/.test(output.value))) fail('INVALID_PROPERTY');
  if ((kind === 'destination.v2' || kind === 'destination.v3') && typeof output.hostname === 'string' && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(output.hostname)) fail('INVALID_PROPERTY');
  return output;
}
/**
 * The producer-side half of the invariant `validateSafeFact` enforces when it recomputes a fact's
 * ID: the ID hashes the canonical properties, not the ones a capability handed in. Property values
 * that survive validation are returned unchanged, so every admissible fact keeps the ID it had.
 *
 * The one rewrite is the ingress quarantine: a value the ingress rule refuses becomes
 * `{ authentication: null, authenticationState: 'UNKNOWN', legacyAuthenticated: false }`, and
 * `code.indicator.v2` drops an inadmissible `member`. A producer that hashed the raw value was
 * rejected for an ID mismatch and its whole capability was dropped (65-F1), even though the policy
 * had already reported the finding.
 *
 * `undefined` means the validator would refuse these properties outright. The caller hashes them
 * unchanged then, so the fact still fails closed at validation exactly as before. The collection
 * bounds here are deliberately unbounded: the validator applies the real limit before any ID is
 * compared, so binding here could only manufacture a second, different refusal.
 */
export function canonicalSafeFactProperties(kind: string, input: unknown): Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]> | undefined {
  const schema = SAFE_FACT_REGISTRY_V2.schemas.find((item) => item.kind === kind);
  if (schema === undefined) return undefined;
  const unbounded = { maxMembersAndElements: Number.MAX_SAFE_INTEGER, maxNodes: Number.MAX_SAFE_INTEGER };
  try { return properties(kind, schema, input, unbounded); } catch { return undefined; }
}
function writeUtf8(hash: ReturnType<typeof sha256.create>, value: string): void {
  const chunk = new Uint8Array(4_096); let used = 0; const push = (byte: number): void => { chunk[used] = byte; used += 1; if (used === chunk.length) { hash.update(chunk); used = 0; } };
  for (let index = 0; index < value.length; index += 1) { let code = value.charCodeAt(index); if (code >= 0xd800) { code = 0x10000 + ((code - 0xd800) << 10) + value.charCodeAt(index + 1) - 0xdc00; index += 1; } if (code <= 0x7f) push(code); else if (code <= 0x7ff) { push(0xc0 | code >> 6); push(0x80 | code & 63); } else if (code <= 0xffff) { push(0xe0 | code >> 12); push(0x80 | code >> 6 & 63); push(0x80 | code & 63); } else { push(0xf0 | code >> 18); push(0x80 | code >> 12 & 63); push(0x80 | code >> 6 & 63); push(0x80 | code & 63); } }
  if (used) hash.update(chunk.subarray(0, used));
}
function factDigest(parts: readonly string[]): string {
  const hash = sha256.create();
  for (const part of parts) { const tagged = `N${utf8Bytes(part, 64 * 1024 * 1024)}:${part}`; const framed = `${utf8Bytes(tagged, 64 * 1024 * 1024)}:${tagged}`; writeUtf8(hash, framed); }
  return bytesToHex(hash.digest());
}
export function canonicalSafeFactSubjectIdentity(subject: SafeFactSubjectV2): string {
  if (subject.kind === 'WORKFLOW') return 'WORKFLOW';
  if (subject.kind === 'SOURCE') return `SOURCE${subject.source.astNodeId}`;
  if (subject.kind === 'NODE') return `NODE${subject.node.identityDigest}`;
  return `EDGE${createEdgeIdentityDigest(subject.edge)}`;
}
/** The one rejection vocabulary: producers may catch and re-report exactly these values. */
export function isSafeFactRejectionReasonV2(value: unknown): value is SafeFactRejectionReasonV2 {
  return value === 'UNKNOWN_FACT_KIND' || value === 'UNKNOWN_PROPERTY' || value === 'INVALID_PROPERTY' || value === 'INVALID_SUBJECT' || value === 'FORBIDDEN_CONTENT' || value === 'LIMIT_EXCEEDED' || value === 'UNSAFE_INPUT' || value === 'REGISTRY_MISMATCH';
}
export function validateSafeFact(candidate: unknown, schema: SafeFactSchemaV2, limits: ScannerLimitsV2): SafeFactValidationResultV2 {
  if (!isScannerAdmissionSnapshotV2<SafeFactV2>(candidate)) return Object.freeze({ ok: false, code: 'SAFE_FACT_REJECTED', reason: 'UNSAFE_INPUT' });
  try {
    const value = record(candidate, FACT_KEYS, 'UNKNOWN_PROPERTY');
    const kind = data(value, 'kind'); if (typeof kind !== 'string') fail('UNKNOWN_FACT_KIND');
    const expected = SAFE_FACT_REGISTRY_V2.schemas.find((item) => item.kind === kind);
    if (expected === undefined) fail('UNKNOWN_FACT_KIND');
    if (schema !== expected) fail('REGISTRY_MISMATCH');
    const effective = limitsSnapshot(limits);
    const subjectValue = subject(data(value, 'subject'), kind, effective);
    const subjects = SAFE_FACT_SUBJECT_KINDS_V2[kind]; if (subjects === undefined || !subjects.includes(subjectValue.kind)) fail('INVALID_SUBJECT');
    const propertiesValue = properties(kind, expected, data(value, 'properties'), effective);
    if (isFieldFlowFactKindV1(kind) && !validateFieldFlowSubject(kind, subjectValue, propertiesValue)) fail('INVALID_SUBJECT');
    const expectedId = factDigest(['secureflow-fact-id-v2', kind, canonicalSafeFactSubjectIdentity(subjectValue), canonicalizeJson(propertiesValue)]);
    if (data(value, 'factId') !== expectedId) fail('INVALID_PROPERTY');
    const fact: SafeFactV2 = { factId: expectedId, kind, subject: subjectValue, properties: propertiesValue };
    return Object.freeze({ ok: true, fact: createSafeFactAdmissionSnapshotV2(fact) });
  } catch (error) {
    return Object.freeze({ ok: false, code: 'SAFE_FACT_REJECTED', reason: isSafeFactRejectionReasonV2(error) ? error : 'UNSAFE_INPUT' });
  }
}
