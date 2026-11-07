import { DEFAULT_SCANNER_LIMITS_V2, type ScannerLimitsV2 } from '@hub/contracts';
import { segmentExpressionIslands } from '../expression/expression-islands';
import type { ResolvedNodeSemanticsV2 } from '../../semantics/catalogue-schema';
import type { SemanticFieldV2, SecurityNodeV2, SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';
const MAX_DESTINATION_TEXT = 16_384;

export type DestinationScheme = 'HTTP' | 'HTTPS' | 'UNKNOWN';
export type DestinationAuthorityState = 'KNOWN' | 'UNKNOWN';
export type DestinationValueMode = 'LITERAL' | 'DYNAMIC' | 'UNKNOWN';
export type DestinationEvidence = 'OBSERVED' | 'MISSING_PATH' | 'MALFORMED_PATH';
export type DestinationReason = 'NONE' | 'DYNAMIC' | 'UNSUPPORTED' | 'OVERSIZED' | 'MISSING_PATH' | 'MALFORMED_PATH';
export type DestinationInventoryStatus = 'COMPLETE' | 'UNKNOWN' | 'LIMIT_EXCEEDED' | 'UNSAFE_INPUT';
export type DestinationInventoryRecord = Readonly<{
  nodeIdentity: string; parameterPath: string; scheme: DestinationScheme; hostname: string | null;
  authorityState: DestinationAuthorityState; valueMode: DestinationValueMode; evidence: DestinationEvidence;
  reason: DestinationReason; omitted: number; inventoryStatus: DestinationInventoryStatus;
}>;
export type DestinationInventoryError = Readonly<{
  code: 'MISSING_SEMANTICS' | 'MISSING_PATH' | 'MALFORMED_PATH' | 'LIMIT_EXCEEDED' | 'UNSAFE_INPUT';
  nodeIdentity: string | null; parameterPath: string | null;
}>;
export type DestinationInventoryCounters = Readonly<{
  nodesExamined: number; pathsConfigured: number; semanticMembersExamined: number;
  occurrencesExamined: number; recordsEmitted: number; membersAndElementsExamined: number;
}>;
export type DestinationInventoryResult = Readonly<{
  status: DestinationInventoryStatus;
  records: readonly DestinationInventoryRecord[]; counters: DestinationInventoryCounters;
  errors: readonly DestinationInventoryError[]; omitted: number;
}>;
export type DestinationSemanticSource = ReadonlyMap<string, ResolvedNodeSemanticsV2> | Readonly<{
  resolvedNodeSemantics: ReadonlyMap<string, ResolvedNodeSemanticsV2>;
}>;
export type DestinationInventoryOptions = Readonly<{ maxMembersAndElements?: number }> | ScannerLimitsV2 | number;

type MutableCounters = { nodesExamined: number; pathsConfigured: number; semanticMembersExamined: number; occurrencesExamined: number; recordsEmitted: number; membersAndElementsExamined: number };
type DestinationRecordDraft = Omit<DestinationInventoryRecord, 'inventoryStatus'>;
type MutableState = { records: DestinationRecordDraft[]; errors: DestinationInventoryError[]; counters: MutableCounters; used: number; maximum: number };
type Pointer = readonly string[];

export function inventoryDestinations(workflow: SecurityWorkflowV2, semantics: DestinationSemanticSource, options: DestinationInventoryOptions = DEFAULT_SCANNER_LIMITS_V2): DestinationInventoryResult {
  const maximum = readMaximum(options);
  if (maximum === undefined || !safeWorkflow(workflow) || !safeSemantics(semantics)) return result('UNSAFE_INPUT', [], [error('UNSAFE_INPUT', null, null)], emptyCounters());
  const state: MutableState = { records: [], errors: [], counters: emptyCounters(), used: 0, maximum };
  for (const node of workflow.nodes) {
    state.counters.nodesExamined += 1;
    const record = lookup(semantics, node.ref.identityDigest);
    if (record === undefined || record.nodeType !== node.type) { state.errors.push(error('MISSING_SEMANTICS', node.ref.identityDigest, null)); continue; }
    const paths = record.destinationPaths;
    if (!charge(state, paths.length)) return result('LIMIT_EXCEEDED', [], [...state.errors, error('LIMIT_EXCEEDED', node.ref.identityDigest, null)], state.counters, state.records);
    state.counters.pathsConfigured += paths.length;
    const parsedPaths = paths.map((path) => ({ path, segments: pointer(path) }));
    if (!charge(state, node.parameters.length)) return result('LIMIT_EXCEEDED', [], [...state.errors, error('LIMIT_EXCEEDED', node.ref.identityDigest, null)], state.counters, state.records);
    state.counters.semanticMembersExamined += node.parameters.length;
    const fields: SemanticFieldV2[] = [];
    if (!collectFields(node.parameters, state, fields)) return result('LIMIT_EXCEEDED', [], [...state.errors, error('LIMIT_EXCEEDED', node.ref.identityDigest, null)], state.counters, state.records);
    for (const configured of parsedPaths) {
      if (configured.segments === undefined) {
        emit(state, omittedRecord(node.ref.identityDigest, configured.path, 'MALFORMED_PATH'));
        state.errors.push(error('MALFORMED_PATH', node.ref.identityDigest, configured.path));
        continue;
      }
      let found = false;
      for (const field of fields) {
        if (!matches(node, field, configured.segments)) continue;
        found = true;
        const occurrences = field.occurrences.length;
        state.counters.occurrencesExamined += occurrences;
        for (let index = 0; index < occurrences; index += 1) emit(state, observedRecord(node.ref.identityDigest, configured.path, field));
      }
      if (!found) {
        emit(state, omittedRecord(node.ref.identityDigest, configured.path, 'MISSING_PATH'));
        state.errors.push(error('MISSING_PATH', node.ref.identityDigest, configured.path));
      }
    }
  }
  return result(state.errors.length === 0 ? 'COMPLETE' : 'UNKNOWN', state.records, state.errors, state.counters);
}

function collectFields(fields: readonly SemanticFieldV2[], state: MutableState, output: SemanticFieldV2[]): boolean {
  for (const field of fields) {
    if (!charge(state, field.occurrences.length)) return false;
    output.push(field);
    if (Array.isArray(field.value)) {
      if (!charge(state, field.value.length)) return false;
      state.counters.semanticMembersExamined += field.value.length;
      if (!collectFields(field.value, state, output)) return false;
    }
  }
  return true;
}
function matches(node: SecurityNodeV2, field: SemanticFieldV2, segments: Pointer): boolean {
  const prefix = pointer(node.ref.source.pointer);
  const fieldPath = pointer(field.pointer);
  if (prefix === undefined || fieldPath === undefined || fieldPath.length < prefix.length + 2) return false;
  for (let i = 0; i < prefix.length; i += 1) if (fieldPath[i] !== prefix[i]) return false;
  if (fieldPath[prefix.length] !== 'parameters') return false;
  const relative = fieldPath.slice(prefix.length + 1);
  return relative.length === segments.length && relative.every((item, index) => item === segments[index]);
}
function observedRecord(nodeIdentity: string, parameterPath: string, field: SemanticFieldV2): DestinationRecordDraft {
  if (typeof field.value !== 'string') return omittedRecord(nodeIdentity, parameterPath, 'UNSUPPORTED');
  const dynamic = field.classification === 'EXPRESSION' || segmentExpressionIslands(field.value).some((part) => part.kind === 'EXPRESSION');
  const observed = authority(field.value);
  const reason: DestinationReason = dynamic ? 'DYNAMIC' : observed.scheme !== 'UNKNOWN' && observed.authorityState === 'KNOWN' ? 'NONE' : 'UNSUPPORTED';
  return { nodeIdentity, parameterPath, ...observed, valueMode: dynamic ? 'DYNAMIC' : 'LITERAL', evidence: 'OBSERVED', reason, omitted: reason === 'NONE' ? 0 : 1 };
}
function authority(value: string): Pick<DestinationInventoryRecord, 'scheme' | 'hostname' | 'authorityState'> {
  const islands = segmentExpressionIslands(value); const masked = mask(value, islands); const dynamicValue = islands.some((part) => part.kind === 'EXPRESSION'); const authorityBoundary = authorityEnd(masked); const dynamicAuthority = dynamicValue && (authorityBoundary === 0 || islands.some((part) => part.kind === 'EXPRESSION' && part.start < authorityBoundary));
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(masked); const protocolRelative = masked.startsWith('//');
  const candidate = match ? masked : protocolRelative ? `http:${masked}` : !dynamicValue && hostLike(masked) ? `http://${masked}` : undefined;
  if (candidate === undefined) return { scheme: 'UNKNOWN', hostname: null, authorityState: 'UNKNOWN' };
  try { const url = new URL(candidate); const hostname = url.hostname || null;
    return { scheme: match?.[1].toLowerCase() === 'http' ? 'HTTP' : match?.[1].toLowerCase() === 'https' ? 'HTTPS' : 'UNKNOWN', hostname: dynamicAuthority ? null : hostname, authorityState: dynamicAuthority || hostname === null ? 'UNKNOWN' : 'KNOWN' };
  } catch { return { scheme: match?.[1].toLowerCase() === 'http' ? 'HTTP' : match?.[1].toLowerCase() === 'https' ? 'HTTPS' : 'UNKNOWN', hostname: null, authorityState: 'UNKNOWN' }; }
}
function authorityEnd(value: string): number { const match = /^([A-Za-z][A-Za-z0-9+.-]*:)?\/\//.exec(value); if (!match) return 0; const start = match[0].length; const rest = value.slice(start); const offset = rest.search(/[/?#]/); return offset < 0 ? value.length : start + offset; }
function hostLike(value: string): boolean { return !value.startsWith('=') && /^[^/\\?#\s:@]+(?::\d{1,5})?(?:[/?#].*)?$/.test(value) && !value.startsWith('.'); }
function mask(value: string, islands: readonly { kind: string; start: number; end: number }[]): string { let output = ''; let cursor = 0; for (const island of islands) { if (island.kind !== 'EXPRESSION') continue; output += value.slice(cursor, island.start) + 'x'; cursor = island.end; } return output + value.slice(cursor); }
function pointer(value: string): Pointer | undefined { if (typeof value !== 'string' || value.length > 4_096) return undefined; if (value.length === 0) return Object.freeze([]); if (!value.startsWith('/')) return undefined; const parts = value.slice(1).split('/'); const decoded: string[] = []; for (const part of parts) { let item = ''; for (let i = 0; i < part.length; i += 1) { if (part[i] !== '~') { item += part[i]; continue; } const next = part[i + 1]; if (next !== '0' && next !== '1') return undefined; item += next === '0' ? '~' : '/'; i += 1; } decoded.push(item); } return Object.freeze(decoded); }
function omittedRecord(nodeIdentity: string, parameterPath: string, reason: 'UNSUPPORTED' | 'MISSING_PATH' | 'MALFORMED_PATH'): DestinationRecordDraft {
  const evidence: DestinationEvidence = reason === 'UNSUPPORTED' ? 'OBSERVED' : reason;
  return { nodeIdentity, parameterPath, scheme: 'UNKNOWN', hostname: null, authorityState: 'UNKNOWN', valueMode: 'UNKNOWN', evidence, reason, omitted: 1 };
}
function emptyCounters(): MutableCounters { return { nodesExamined: 0, pathsConfigured: 0, semanticMembersExamined: 0, occurrencesExamined: 0, recordsEmitted: 0, membersAndElementsExamined: 0 }; }
function emit(state: MutableState, record: DestinationRecordDraft): void { state.records.push(record); state.counters.recordsEmitted += 1; }
function charge(state: MutableState, count: number): boolean { if (!Number.isSafeInteger(count) || count < 0 || state.used > state.maximum - count) return false; state.used += count; state.counters.membersAndElementsExamined = state.used; return true; }
function error(code: DestinationInventoryError['code'], nodeIdentity: string | null, parameterPath: string | null): DestinationInventoryError { return Object.freeze({ code, nodeIdentity, parameterPath }); }
function result(status: DestinationInventoryStatus, records: readonly DestinationRecordDraft[], errors: readonly DestinationInventoryError[], counters: MutableCounters, emitted: readonly DestinationRecordDraft[] = records): DestinationInventoryResult {
  const finalRecords = records.map((record) => Object.freeze({ ...record, inventoryStatus: status }));
  const omitted = emitted.reduce((total, record) => total + record.omitted, 0)
    + errors.filter((item) => item.code === 'MISSING_SEMANTICS' || item.code === 'LIMIT_EXCEEDED' || item.code === 'UNSAFE_INPUT').length;
  return Object.freeze({ status, records: Object.freeze(finalRecords), counters: Object.freeze({ ...counters }), errors: Object.freeze([...errors]), omitted });
}
function readMaximum(options: DestinationInventoryOptions): number | undefined { if (typeof options === 'number') return Number.isSafeInteger(options) && options >= 0 ? options : undefined; if (options === null || typeof options !== 'object') return undefined; const descriptor = Object.getOwnPropertyDescriptor(options, 'maxMembersAndElements'); const value = descriptor && 'value' in descriptor ? descriptor.value : undefined; return value === undefined ? DEFAULT_SCANNER_LIMITS_V2.maxMembersAndElements : Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function lookup(source: DestinationSemanticSource, identity: string): ResolvedNodeSemanticsV2 | undefined { const map = 'resolvedNodeSemantics' in source ? source.resolvedNodeSemantics : source; return Map.prototype.get.call(map, identity) as ResolvedNodeSemanticsV2 | undefined; }
function plainFrozen(value: unknown): value is Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) return false; return Object.getOwnPropertyNames(value).every((name) => { const descriptor = Object.getOwnPropertyDescriptor(value, name); return descriptor !== undefined && 'value' in descriptor; }); }
function safeRef(value: unknown): boolean { if (!plainFrozen(value) || !closed(value, ['pointer', 'occurrencePath', 'astNodeId', 'span'], ['pointer', 'occurrencePath', 'astNodeId', 'span'])) return false; const pointerValue = value.pointer; const astNodeId = value.astNodeId; return typeof pointerValue === 'string' && pointer(pointerValue) !== undefined && denseFrozen(value.occurrencePath) && typeof astNodeId === 'string' && /^[0-9a-f]{64}$/.test(astNodeId); }
function safeWorkflow(value: unknown): value is SecurityWorkflowV2 { if (!plainFrozen(value) || !closed(value, ['workflowFields', 'nodes', 'edges', 'ambiguities'], ['workflowFields', 'nodes', 'edges', 'ambiguities']) || !denseFrozen(value.nodes) || !denseFrozen(value.workflowFields) || !denseFrozen(value.edges) || !denseFrozen(value.ambiguities)) return false; return value.nodes.every((node) => { if (!plainFrozen(node) || !closed(node, ['ref', 'type', 'typeVersion', 'disabled', 'scoringEligibility', 'parameters', 'credentials', 'settings'], ['ref', 'type', 'disabled', 'scoringEligibility', 'parameters', 'credentials', 'settings']) || !plainFrozen(node.ref) || !closed(node.ref, ['ordinal', 'source', 'explicitId', 'name', 'identityDigest'], ['ordinal', 'source', 'identityDigest']) || typeof node.ref.identityDigest !== 'string' || !/^[0-9a-f]{64}$/.test(node.ref.identityDigest) || !safeRef(node.ref.source) || !denseFrozen(node.parameters) || !denseFrozen(node.credentials) || !denseFrozen(node.settings)) return false; return node.parameters.every((field) => safeField(field)); }); }
function safeField(value: unknown, depth = 0): value is SemanticFieldV2 { if (depth > 256 || !plainFrozen(value) || !closed(value, ['pointer', 'occurrences', 'value', 'classification'], ['pointer', 'occurrences', 'value', 'classification'])) return false; if (pointer(value.pointer as string) === undefined || !denseFrozen(value.occurrences) || !['PLAIN', 'EXPRESSION', 'CODE', 'CREDENTIAL_REF', 'SECRET_CANDIDATE'].includes(value.classification as string)) return false; if (!value.occurrences.every(safeRef)) return false; if (Array.isArray(value.value)) return denseFrozen(value.value) && value.value.every((item) => safeField(item, depth + 1)); return value.value === null || typeof value.value === 'boolean' || typeof value.value === 'number' && Number.isFinite(value.value) || typeof value.value === 'string' && value.value.length <= MAX_DESTINATION_TEXT; }
function denseFrozen(value: unknown): value is readonly unknown[] { if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !Object.isFrozen(value) || Object.getOwnPropertySymbols(value).length > 0) return false; const names = Object.getOwnPropertyNames(value); return names.length === value.length + 1 && names.includes('length') && names.every((name) => { if (name === 'length') return true; const descriptor = Object.getOwnPropertyDescriptor(value, name); return /^(0|[1-9]\d*)$/.test(name) && descriptor !== undefined && 'value' in descriptor; }); }
function safeSemantics(value: unknown): value is DestinationSemanticSource { const map = value instanceof Map ? value : plainFrozen(value) && closed(value, ['resolvedNodeSemantics'], ['resolvedNodeSemantics']) ? value.resolvedNodeSemantics : undefined; if (!(map instanceof Map) || Object.getPrototypeOf(map) !== Map.prototype || Object.getOwnPropertyNames(map).length !== 0 || Object.getOwnPropertySymbols(map).length !== 0) return false; const keys = ['semanticId', 'nodeType', 'versionRange', 'operation', 'entry', 'parameterPaths', 'authentication', 'credentialPaths', 'destinationPaths', 'effects', 'endpoints', 'ports', 'overwritePaths', 'errorMode', 'retryMode', 'disabledMode', 'provenance']; for (const [key, record] of map.entries()) if (typeof key !== 'string' || !deeplyFrozen(record) || !plainFrozen(record) || !closed(record, keys, keys) || !denseFrozen(record.destinationPaths) || !record.destinationPaths.every((path) => typeof path === 'string')) return false; return true; }
function closed(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean { const names = Object.getOwnPropertyNames(value); return names.length === new Set(names).size && names.every((name) => allowed.includes(name)) && required.every((name) => Object.prototype.hasOwnProperty.call(value, name)); }
function deeplyFrozen(value: unknown, seen = new WeakSet<object>()): boolean { if (value === null || typeof value !== 'object') return true; if (seen.has(value)) return true; if (!Object.isFrozen(value)) return false; seen.add(value); return Object.getOwnPropertyNames(value).every((name) => { const descriptor = Object.getOwnPropertyDescriptor(value, name); return descriptor !== undefined && 'value' in descriptor && deeplyFrozen(descriptor.value, seen); }); }
