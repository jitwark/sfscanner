import type { ResolvedNodeSemanticsV2 } from '../../semantics/catalogue-schema';
import type { SecurityNodeV2, SecurityWorkflowV2 } from '../../workflow-v2/security-workflow';
import { createConfidentialityState, createIntegrityState } from './labels';
import { adaptSemanticEndpoints, type SemanticTransferEventV2 } from './catalogue-adapter';
import type { TaintFactV2 } from './transfer';

export type SubworkflowSemanticSourceV2 = ReadonlyMap<string, ResolvedNodeSemanticsV2> | Readonly<{ resolvedNodeSemantics: ReadonlyMap<string, ResolvedNodeSemanticsV2> }>;
export type SubworkflowDefinitionV2 = Readonly<{ identity: string; workflow: SecurityWorkflowV2; semantics: SubworkflowSemanticSourceV2 }>;
export type SubworkflowEventV2 = Readonly<{ kind: SemanticTransferEventV2['kind'] | 'ENTER' | 'RETURN' | 'MISSING' | 'UNKNOWN' | 'CYCLE' | 'LIMIT_EXCEEDED'; identity?: string; node?: number; field?: string; port?: number; item?: number; mode?: string }>;
export type SubworkflowInput = Readonly<{ workflow: SecurityWorkflowV2; semantics: SubworkflowSemanticSourceV2; subworkflows?: ReadonlyMap<string, SubworkflowDefinitionV2 | SecurityWorkflowV2>; semanticsByWorkflow?: ReadonlyMap<string, SubworkflowSemanticSourceV2>; incoming?: readonly TaintFactV2[]; identity?: string; maximumDepth?: number; maximum?: number }>;
export type SubworkflowResult = Readonly<{ status: 'COMPLETE' | 'UNKNOWN' | 'LIMIT_EXCEEDED'; events: readonly SubworkflowEventV2[]; transfers: readonly SubworkflowEventV2[]; facts: readonly TaintFactV2[]; visited: readonly string[]; omitted: number }>;

type State = { events: SubworkflowEventV2[]; facts: TaintFactV2[]; visited: Set<string>; active: Set<string>; used: number; omitted: number; maximum: number; maximumDepth: number; status: SubworkflowResult['status'] };
type Source = SubworkflowInput['subworkflows'];

export function resolveSubworkflowSemantics(input: SubworkflowInput): SubworkflowResult {
  const depth = input.maximumDepth ?? 16; const maximum = input.maximum ?? 10_000;
  if (!validLimit(depth) || !validLimit(maximum) || !safeWorkflow(input.workflow)) return finish({ events: [], facts: [], visited: new Set(), omitted: 0, status: 'UNKNOWN' });
  const state: State = { events: [], facts: [], visited: new Set(), active: new Set(), used: 0, omitted: 0, maximum, maximumDepth: depth, status: 'COMPLETE' };
  visit(input.workflow, input.semantics, input.subworkflows, input.semanticsByWorkflow, input.incoming ?? [], input.identity ?? 'root', 0, state);
  return finish(state);
}
export const resolveSubworkflowsV2 = resolveSubworkflowSemantics;

function visit(workflow: SecurityWorkflowV2, source: SubworkflowSemanticSourceV2, definitions: Source, semanticsByWorkflow: SubworkflowInput['semanticsByWorkflow'], incoming: readonly TaintFactV2[], identity: string, depth: number, state: State): readonly TaintFactV2[] {
  if (state.status === 'LIMIT_EXCEEDED') return [];
  if (depth > state.maximumDepth) { state.status = 'LIMIT_EXCEEDED'; state.omitted += 1; state.events.push(Object.freeze({ kind: 'LIMIT_EXCEEDED', identity })); return []; }
  if (identity !== 'root' && state.active.has(identity)) { state.status = 'UNKNOWN'; state.events.push(Object.freeze({ kind: 'CYCLE', identity })); return unknownFacts(incoming); }
  if (identity !== 'root' && state.visited.has(identity)) { state.status = 'UNKNOWN'; state.events.push(Object.freeze({ kind: 'CYCLE', identity })); return unknownFacts(incoming); }
  if (identity !== 'root') { state.active.add(identity); state.visited.add(identity); }
  let current = [...incoming];
  for (const node of [...workflow.nodes].sort((left, right) => left.ref.ordinal - right.ref.ordinal)) {
    if (!charge(state)) { state.status = 'LIMIT_EXCEEDED'; state.omitted += 1; state.events.push(Object.freeze({ kind: 'LIMIT_EXCEEDED', identity, node: node.ref.ordinal })); break; }
    const semantic = lookup(source, node.ref.identityDigest); const transfer = adaptSemanticEndpoints({ node, semantics: semantic, incoming: current, maximum: state.maximum });
    appendTransfer(state, transfer.events); appendFacts(state, transfer.facts); if (transfer.status === 'LIMIT_EXCEEDED') { state.status = 'LIMIT_EXCEEDED'; break; } if (transfer.status === 'UNKNOWN') state.status = 'UNKNOWN';
    current = [...transfer.facts];
    if (!semantic?.effects.includes('START_SUBWORKFLOW')) continue;
    const reference = workflowReference(node); const child = reference === undefined ? undefined : definitionFor(definitions, reference, semanticsByWorkflow);
    if (reference === undefined) { state.status = 'UNKNOWN'; state.events.push(Object.freeze({ kind: 'UNKNOWN', identity })); current = unknownFacts(current); markUnknown(state, current); continue; }
    if (!child) { state.status = 'UNKNOWN'; state.events.push(Object.freeze({ kind: 'MISSING', identity: reference, node: node.ref.ordinal })); current = unknownFacts(current); markUnknown(state, current); continue; }
    state.events.push(Object.freeze({ kind: 'ENTER', identity: reference, node: node.ref.ordinal })); current = [...visit(child.workflow, semanticsByWorkflow?.get(reference) ?? child.semantics, definitions, semanticsByWorkflow, current, reference, depth + 1, state)]; state.events.push(Object.freeze({ kind: 'RETURN', identity: reference, node: node.ref.ordinal }));
  }
  if (identity !== 'root') state.active.delete(identity);
  return current;
}
function appendTransfer(state: State, events: readonly SemanticTransferEventV2[]): void { for (const event of events) state.events.push(Object.freeze({ ...event })); }
function appendFacts(state: State, facts: readonly TaintFactV2[]): void { for (const fact of facts) state.facts.push(fact); }
function unknownFacts(facts: readonly TaintFactV2[]): TaintFactV2[] { return facts.map((fact) => Object.freeze({ ...fact, confidentiality: createConfidentialityState(fact.confidentiality.labels, true), integrity: createIntegrityState(fact.integrity.labels, true) })); }
function markUnknown(state: State, facts: readonly TaintFactV2[]): void { for (const fact of facts) { const key = `${fact.key.node}|${fact.key.field}|${fact.key.port}|${fact.key.item}`; const index = state.facts.findIndex((item) => `${item.key.node}|${item.key.field}|${item.key.port}|${item.key.item}` === key); if (index >= 0) state.facts[index] = fact; else state.facts.push(fact); } }
function workflowReference(node: SecurityNodeV2): string | undefined { const prefix = pointer(node.ref.source.pointer); if (!prefix) return undefined; for (const field of node.parameters) { const relative = pointer(field.pointer); if (!relative || relative.length !== prefix.length + 2 || relative.slice(0, prefix.length).some((part, index) => part !== prefix[index]) || relative[prefix.length] !== 'parameters' || relative[prefix.length + 1] !== 'workflowId' || field.classification !== 'PLAIN' || typeof field.value !== 'string' || field.value.length === 0 || field.value.length > 512) continue; return field.value; } return undefined; }
function definitionFor(source: Source, identity: string, semanticsByWorkflow: SubworkflowInput['semanticsByWorkflow']): SubworkflowDefinitionV2 | undefined { if (!(source instanceof Map)) return undefined; const value = Map.prototype.get.call(source, identity) as SubworkflowDefinitionV2 | SecurityWorkflowV2 | undefined; if (!value) return undefined; if ('workflow' in value && 'semantics' in value && typeof value.identity === 'string') return value; if ('nodes' in value) return { identity, workflow: value, semantics: semanticsByWorkflow?.get(identity) ?? new Map() }; return undefined; }
function lookup(source: SubworkflowSemanticSourceV2, key: string): ResolvedNodeSemanticsV2 | undefined { const map = 'resolvedNodeSemantics' in source ? source.resolvedNodeSemantics : source; return Map.prototype.get.call(map, key) as ResolvedNodeSemanticsV2 | undefined; }
function pointer(value: string | undefined): readonly string[] | undefined { if (typeof value !== 'string' || !value.startsWith('/')) return value === '' ? [] : undefined; return Object.freeze(value.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))); }
function charge(state: State): boolean { if (state.used >= state.maximum) return false; state.used += 1; return true; }
function validLimit(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function safeWorkflow(value: unknown): value is SecurityWorkflowV2 { if (value === null || typeof value !== 'object') return false; const candidate = value as SecurityWorkflowV2; return Array.isArray(candidate.nodes) && Array.isArray(candidate.edges) && candidate.nodes.every((node) => node !== null && typeof node === 'object' && Number.isSafeInteger(node.ref?.ordinal) && typeof node.ref?.source?.pointer === 'string' && typeof node.type === 'string' && Array.isArray(node.parameters)); }
function compareText(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1; }
function finish(state: Pick<State, 'events' | 'facts' | 'visited' | 'omitted' | 'status'>): SubworkflowResult { if (state.status === 'LIMIT_EXCEEDED') { const empty = Object.freeze([]); return Object.freeze({ status: state.status, events: empty, transfers: empty, facts: empty, visited: empty, omitted: state.omitted }); } const events = Object.freeze([...state.events].sort((left, right) => compareText(`${left.identity ?? ''}|${left.node ?? -1}|${left.kind}`, `${right.identity ?? ''}|${right.node ?? -1}|${right.kind}`)).map((event) => Object.freeze(event))); const facts = Object.freeze([...state.facts].sort((left, right) => compareText(`${left.key.node}|${left.key.field}|${left.key.port}|${left.key.item}`, `${right.key.node}|${right.key.field}|${right.key.port}|${right.key.item}`))); const visited = Object.freeze([...state.visited].sort(compareText)); return Object.freeze({ status: state.status, events, transfers: events, facts, visited, omitted: state.omitted }); }
