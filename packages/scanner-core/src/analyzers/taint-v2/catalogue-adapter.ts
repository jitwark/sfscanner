import type { ResolvedNodeSemanticsV2, SemanticChannelV2, SemanticEndpointV2 } from '../../semantics/catalogue-schema';
import type { SecurityNodeV2 } from '../../workflow-v2/security-workflow';
import { bottomConfidentiality, bottomIntegrity, createConfidentialityState, createIntegrityState, joinConfidentialityStates, joinIntegrityStates, killConfidentialityLabels, killIntegrityLabels, type ConfidentialityLabel, type ConfidentialityState, type IntegrityLabel, type IntegrityState } from './labels';
import type { TaintFactV2, TaintKeyV2, TaintTraceStepV2 } from './transfer';

export type SemanticTransferEventV2 = Readonly<{ kind: 'SOURCE' | 'SINK' | 'SANITIZER' | 'ERROR' | 'RETRY'; node: number; field: string; port: number; item: number; channel?: SemanticChannelV2; direction?: 'SOURCE' | 'SINK' | 'SANITIZER'; taint?: SemanticEndpointV2['taint']; scope?: string; mode?: string }>;
export type SemanticEndpointAdapterResult = Readonly<{ status: 'COMPLETE' | 'UNKNOWN' | 'LIMIT_EXCEEDED'; events: readonly SemanticTransferEventV2[]; transfers: readonly SemanticTransferEventV2[]; facts: readonly TaintFactV2[]; omitted: number }>;
export type SemanticEndpointAdapterInput = Readonly<{ node: SecurityNodeV2; semantics?: ResolvedNodeSemanticsV2; incoming?: readonly TaintFactV2[]; maximum?: number; maxEvents?: number }>;

type Mutable = { events: SemanticTransferEventV2[]; facts: Map<string, TaintFactV2>; omitted: number; maximum: number };
type SourceStates = Readonly<{ confidentiality: ConfidentialityState; integrity: IntegrityState }>;
type Selector = Readonly<{ port?: number; item?: number }>;

export function adaptSemanticEndpoints(input: SemanticEndpointAdapterInput): SemanticEndpointAdapterResult {
  const maximum = readMaximum(input); if (maximum === undefined || !safeNode(input.node)) return result('UNKNOWN', [], [], 0);
  const supplied = input.semantics; const present = supplied !== undefined && supplied.nodeType === input.node.type; const semantics = present ? supplied : undefined; const known = present && semantics !== undefined && supported(semantics);
  const state: Mutable = { events: [], facts: new Map(), omitted: 0, maximum };
  const incoming = [...(input.incoming ?? [])].sort((left, right) => compareKey(left.key, right.key));
  for (const original of incoming) {
    const key = Object.freeze({ node: input.node.ref.ordinal, field: original.key.field, port: original.key.port, item: original.key.item });
    let confidentiality = createConfidentialityState(original.confidentiality.labels, original.confidentiality.unknown);
    let integrity = createIntegrityState(original.integrity.labels, original.integrity.unknown);
    let trace: readonly TaintTraceStepV2[] = Object.freeze([...original.trace]);
    if (semantics) {
      for (const path of semantics.overwritePaths) if (pathMatch(key.field, path)) { confidentiality = killConfidentialityLabels(confidentiality, confidentiality.labels); integrity = killIntegrityLabels(integrity, integrity.labels); }
      for (const endpoint of endpointsFor(semantics)) {
        if (!pathMatch(key.field, endpoint.path) || !scopeMatches(endpoint.scope, key)) continue;
        state.events.push(event(endpoint, key));
        if (endpoint.direction === 'SOURCE') { const source = sourceStates(endpoint, semantics); confidentiality = joinConfidentialityStates(confidentiality, source.confidentiality); integrity = joinIntegrityStates(integrity, source.integrity); }
        if (endpoint.direction === 'SANITIZER') { if (endpoint.taint !== 'INTEGRITY') confidentiality = killConfidentialityLabels(confidentiality, confidentiality.labels); if (endpoint.taint !== 'CONFIDENTIALITY') integrity = killIntegrityLabels(integrity, integrity.labels); }
        trace = appendTrace(trace, { kind: endpoint.direction, ...key });
      }
    }
    if (!known) { confidentiality = createConfidentialityState(confidentiality.labels, true); integrity = createIntegrityState(integrity.labels, true); }
    addFact(state, { key, confidentiality, integrity, trace });
  }
  if (semantics) for (const endpoint of endpointsFor(semantics)) if (endpoint.direction === 'SOURCE') {
    const selected = scopeSelector(endpoint.scope); if (selected === null) continue;
    const key = Object.freeze({ node: input.node.ref.ordinal, field: endpoint.path, port: selected?.port ?? 0, item: selected?.item ?? 0 });
    state.events.push(event(endpoint, key)); const source = sourceStates(endpoint, semantics);
    addFact(state, { key, confidentiality: known ? source.confidentiality : createConfidentialityState(source.confidentiality.labels, true), integrity: known ? source.integrity : createIntegrityState(source.integrity.labels, true), trace: Object.freeze([{ kind: 'SOURCE', ...key }]) });
  }
  if (semantics?.errorMode === 'UNKNOWN') state.events.push(modeEvent('ERROR', semantics.errorMode, input.node.ref.ordinal));
  if (semantics?.retryMode === 'UNKNOWN') state.events.push(modeEvent('RETRY', semantics.retryMode, input.node.ref.ordinal));
  if (semantics && semantics.errorMode !== 'UNKNOWN' && semantics.retryMode !== 'UNKNOWN') { if (semantics.errorMode !== 'STOP') addModeEvents(state, 'ERROR', semantics.errorMode, input.node.ref.ordinal); if (semantics.retryMode !== 'NONE') addModeEvents(state, 'RETRY', semantics.retryMode, input.node.ref.ordinal); }
  const malformedScope = semantics?.endpoints.some((endpoint) => scopeSelector(endpoint.scope) === null) ?? false;
  const stateUnknown = !known || malformedScope || [...state.facts.values()].some((fact) => fact.confidentiality.unknown || fact.integrity.unknown);
  const status = state.omitted > 0 ? 'LIMIT_EXCEEDED' : stateUnknown ? 'UNKNOWN' : 'COMPLETE';
  if (state.omitted > 0) return result('LIMIT_EXCEEDED', [], [], state.omitted);
  return result(status, sortEvents(state.events), [...state.facts.values()].sort((left, right) => compareKey(left.key, right.key)), state.omitted);
}
export const adaptCatalogueEndpoints = adaptSemanticEndpoints;

function endpointsFor(semantics: ResolvedNodeSemanticsV2): readonly SemanticEndpointV2[] {
  if (semantics.endpoints.length > 0) return semantics.endpoints;
  const path = semantics.effects.includes('EXECUTE_COMMAND') ? '/command' : semantics.effects.includes('EXECUTE_CODE') ? '/jsCode' : undefined;
  return path ? [{ path, channel: 'DATA', direction: 'SINK', taint: 'BOTH' }] : [];
}
function sourceStates(endpoint: SemanticEndpointV2, semantics: ResolvedNodeSemanticsV2): SourceStates {
  const externalHttp = semantics.effects.includes('READ_EXTERNAL') && semantics.semanticId.startsWith('http-ai.');
  const externalFile = semantics.effects.includes('READ_FILE');
  const path = endpoint.path.toLowerCase();
  const confidentiality: ConfidentialityLabel[] = endpoint.channel === 'MODEL' ? ['AI_MODEL_OUTPUT'] : endpoint.channel === 'CONTEXT' || externalFile ? ['EXTERNAL_FILE'] : externalHttp ? ['EXTERNAL_HTTP_RESPONSE'] : path.includes('header') ? ['WEBHOOK_HEADER'] : path.includes('query') ? ['WEBHOOK_QUERY'] : endpoint.channel === 'DATA' ? ['WEBHOOK_BODY'] : [];
  const integrity: IntegrityLabel[] = endpoint.channel === 'MODEL' ? ['MODEL_OUTPUT'] : endpoint.channel === 'CONTEXT' ? ['RETRIEVED_CONTEXT'] : endpoint.channel === 'TOOL' ? ['TOOL_RESULT'] : externalHttp ? ['EXTERNAL_HTTP_RESPONSE'] : externalFile ? ['EXTERNAL_FILE'] : endpoint.channel === 'DATA' ? ['INBOUND_MESSAGE'] : [];
  const unknown = endpoint.channel === 'ERROR' || endpoint.channel === 'CONTROL';
  return { confidentiality: endpoint.taint === 'INTEGRITY' ? bottomConfidentiality : createConfidentialityState(confidentiality, unknown), integrity: endpoint.taint === 'CONFIDENTIALITY' ? bottomIntegrity : createIntegrityState(integrity, unknown) };
}
function addFact(state: Mutable, fact: TaintFactV2): void { const key = keyOf(fact.key); const existing = state.facts.get(key); if (!existing) { if (state.facts.size + state.events.length >= state.maximum) { state.omitted += 1; return; } state.facts.set(key, Object.freeze({ ...fact, key: Object.freeze({ ...fact.key }), trace: cloneTrace(fact.trace) })); return; } state.facts.set(key, Object.freeze({ key: existing.key, confidentiality: joinConfidentialityStates(existing.confidentiality, fact.confidentiality), integrity: joinIntegrityStates(existing.integrity, fact.integrity), trace: existing.trace.length <= fact.trace.length ? existing.trace : cloneTrace(fact.trace) })); }
function event(endpoint: SemanticEndpointV2, key: TaintKeyV2): SemanticTransferEventV2 { return Object.freeze({ kind: endpoint.direction, direction: endpoint.direction, node: key.node, field: key.field, port: key.port, item: key.item, channel: endpoint.channel, taint: endpoint.taint, ...(endpoint.scope === undefined ? {} : { scope: endpoint.scope }) }); }
function modeEvent(kind: 'ERROR' | 'RETRY', mode: string, node: number): SemanticTransferEventV2 { return Object.freeze({ kind, node, field: '', port: 0, item: 0, mode }); }
function addModeEvents(state: Mutable, kind: 'ERROR' | 'RETRY', mode: string, node: number): void { state.events.push(modeEvent(kind, mode, node)); }
function appendTrace(trace: readonly TaintTraceStepV2[], step: TaintTraceStepV2): readonly TaintTraceStepV2[] { return Object.freeze([...trace, step]); }
function cloneTrace(trace: readonly TaintTraceStepV2[]): readonly TaintTraceStepV2[] { return Object.freeze(trace.map((step) => Object.freeze({ ...step }))); }
function scopeSelector(scope: string | undefined): Selector | null | undefined { if (scope === undefined || scope === '') return undefined; const portText = /(?:^|[\s,;/])port\s*[:=]\s*(\d+)/i.exec(scope)?.[1]; const itemText = /(?:^|[\s,;/])item\s*[:=]\s*(\d+)/i.exec(scope)?.[1]; if (portText === undefined && itemText === undefined) return null; const port = portText === undefined ? undefined : Number(portText); const item = itemText === undefined ? undefined : Number(itemText); if ((port !== undefined && (!Number.isSafeInteger(port) || port < 0)) || (item !== undefined && (!Number.isSafeInteger(item) || item < 0))) return null; return Object.freeze({ ...(port === undefined ? {} : { port }), ...(item === undefined ? {} : { item }) }); }
function scopeMatches(scope: string | undefined, key: TaintKeyV2): boolean { const selected = scopeSelector(scope); return selected === undefined || (selected !== null && (selected.port === undefined || selected.port === key.port) && (selected.item === undefined || selected.item === key.item)); }
function pathMatch(field: string, path: string): boolean { return typeof field === 'string' && typeof path === 'string' && (field === path || field.startsWith(`${path}/`)); }
function keyOf(key: TaintKeyV2): string { return `${key.node}|${key.field}|${key.port}|${key.item}`; }
function compareKey(left: TaintKeyV2, right: TaintKeyV2): number { return compareText(keyOf(left), keyOf(right)); }
function compareText(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1; }
function sortEvents(events: readonly SemanticTransferEventV2[]): readonly SemanticTransferEventV2[] { const seen = new Set<string>(); const rank: Record<SemanticTransferEventV2['kind'], number> = { SOURCE: 0, SINK: 1, SANITIZER: 2, ERROR: 3, RETRY: 4 }; return Object.freeze([...events].filter((event) => { const key = `${event.kind}|${event.node}|${event.field}|${event.port}|${event.item}|${event.mode ?? ''}|${event.scope ?? ''}`; if (seen.has(key)) return false; seen.add(key); return true; }).sort((left, right) => compareText(`${left.node}|${left.field}|${left.port}|${left.item}`, `${right.node}|${right.field}|${right.port}|${right.item}`) || rank[left.kind] - rank[right.kind]).map((event) => Object.freeze(event))); }
function supported(value: ResolvedNodeSemanticsV2): boolean { return ['STOP', 'CONTINUE', 'OUTPUT'].includes(value.errorMode) && ['NONE', 'BOUNDED', 'PLATFORM'].includes(value.retryMode); }
function safeNode(value: unknown): value is SecurityNodeV2 { return value !== null && typeof value === 'object' && Number.isSafeInteger((value as SecurityNodeV2).ref?.ordinal) && typeof (value as SecurityNodeV2).type === 'string'; }
function result(status: SemanticEndpointAdapterResult['status'], events: readonly SemanticTransferEventV2[], facts: readonly TaintFactV2[], omitted: number): SemanticEndpointAdapterResult { const frozenEvents = Object.freeze([...events]); return Object.freeze({ status, events: frozenEvents, transfers: frozenEvents, facts: Object.freeze([...facts]), omitted }); }
function readMaximum(input: SemanticEndpointAdapterInput): number | undefined { const value = input.maximum ?? input.maxEvents ?? 10_000; return Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
