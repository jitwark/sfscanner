import type { TaintFactV2 } from '../taint-v2/transfer';

export type InfluenceSourceKind = 'MODEL' | 'CONTEXT' | 'RETRIEVAL' | 'TOOL_RESULT' | 'EXTERNAL' | 'UNKNOWN';
export type InfluenceSourceV2 = Readonly<{ id: string; kind: InfluenceSourceKind | string; node: number; port: number; field: string; item?: number }>;
export type InfluenceTargetV2 = Readonly<{ id: string; node: number; port: number; tool: string; effect: string; argumentPaths?: readonly string[] | undefined }>;
export type InfluenceFlowV2 = Readonly<{ ordinal?: number; fromNode: number; fromPort: number; toNode: number; toPort: number; resolution?: 'RESOLVED' | 'UNKNOWN' | 'UNRESOLVED' | 'AMBIGUOUS' }>;
export type InfluenceOverwriteV2 = Readonly<{ node: number; port?: number; field?: string }>;
export type InfluenceInputV2 = Readonly<{ sources?: readonly InfluenceSourceV2[]; facts?: readonly TaintFactV2[]; targets?: readonly InfluenceTargetV2[]; flows?: readonly InfluenceFlowV2[]; overwrites?: readonly InfluenceOverwriteV2[]; maxOperations?: number }>;
export type InfluenceStepV2 = Readonly<{ kind: 'SOURCE' | 'PROPAGATION' | 'SINK'; node: number; port: number; field: string; edgeOrdinal?: number }>;
export type InfluenceEvidenceV2 = Readonly<{ sourceId: string; sourceKind: InfluenceSourceKind; sourceNode: number; sourcePort: number; targetId: string; targetNode: number; targetPort: number; tool: string; effect: string; argumentPaths: readonly string[]; trace: readonly InfluenceStepV2[] }>;
export type InfluenceResultV2 = Readonly<{ status: 'COMPLETE' | 'UNKNOWN' | 'LIMIT_EXCEEDED'; influences: readonly InfluenceEvidenceV2[]; independentSources: readonly InfluenceSourceKind[]; omitted: number; operations: number; clean: boolean }>;

type State = { source: InfluenceSourceV2; node: number; port: number; trace: readonly InfluenceStepV2[] };
type Mutable = { used: number; omitted: number; unknown: boolean; output: InfluenceEvidenceV2[] };
const sourceKinds: readonly InfluenceSourceKind[] = ['MODEL', 'CONTEXT', 'RETRIEVAL', 'TOOL_RESULT', 'EXTERNAL', 'UNKNOWN'];
const FACT_SOURCE_KIND: Readonly<Record<string, InfluenceSourceKind>> = Object.freeze({ MODEL_OUTPUT: 'MODEL', AI_MODEL_OUTPUT: 'MODEL', RETRIEVED_CONTEXT: 'RETRIEVAL', TOOL_RESULT: 'TOOL_RESULT', INBOUND_MESSAGE: 'EXTERNAL', EXTERNAL_HTTP_RESPONSE: 'EXTERNAL', EXTERNAL_FILE: 'EXTERNAL' });
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
const safeIndex = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const normalizeKind = (value: unknown): InfluenceSourceKind => value === 'MODEL_OUTPUT' || value === 'AI_MODEL_OUTPUT' ? 'MODEL' : value === 'RETRIEVED_CONTEXT' ? 'RETRIEVAL' : sourceKinds.includes(value as InfluenceSourceKind) ? value as InfluenceSourceKind : 'UNKNOWN';
const validSource = (value: unknown): value is InfluenceSourceV2 => value !== null && typeof value === 'object' && text((value as InfluenceSourceV2).id) && safeIndex((value as InfluenceSourceV2).node) && safeIndex((value as InfluenceSourceV2).port) && text((value as InfluenceSourceV2).field);
const validTarget = (value: unknown): value is InfluenceTargetV2 => value !== null && typeof value === 'object' && text((value as InfluenceTargetV2).id) && safeIndex((value as InfluenceTargetV2).node) && safeIndex((value as InfluenceTargetV2).port) && text((value as InfluenceTargetV2).tool) && text((value as InfluenceTargetV2).effect) && ((value as InfluenceTargetV2).argumentPaths === undefined || Array.isArray((value as InfluenceTargetV2).argumentPaths) && (value as InfluenceTargetV2).argumentPaths!.every(text));
const validFlow = (value: unknown): value is InfluenceFlowV2 => value !== null && typeof value === 'object' && safeIndex((value as InfluenceFlowV2).fromNode) && safeIndex((value as InfluenceFlowV2).fromPort) && safeIndex((value as InfluenceFlowV2).toNode) && safeIndex((value as InfluenceFlowV2).toPort) && ((value as InfluenceFlowV2).resolution === undefined || ['RESOLVED', 'UNKNOWN', 'UNRESOLVED', 'AMBIGUOUS'].includes((value as InfluenceFlowV2).resolution!));
const validOverwrite = (value: unknown): value is InfluenceOverwriteV2 => value !== null && typeof value === 'object' && safeIndex((value as InfluenceOverwriteV2).node) && ((value as InfluenceOverwriteV2).port === undefined || safeIndex((value as InfluenceOverwriteV2).port)) && ((value as InfluenceOverwriteV2).field === undefined || text((value as InfluenceOverwriteV2).field));
const compareText = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;
const compare = (left: { id?: string; node?: number; port?: number } | null | undefined, right: { id?: string; node?: number; port?: number } | null | undefined): number => compareText(left?.id ?? '', right?.id ?? '') || (left?.node ?? 0) - (right?.node ?? 0) || (left?.port ?? 0) - (right?.port ?? 0);
function maxOf(input: InfluenceInputV2): number | undefined { if (input === null || typeof input !== 'object') return undefined; const value = input.maxOperations ?? 4096; return Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function factsToSources(facts: readonly TaintFactV2[] | undefined): { sources: InfluenceSourceV2[]; unknown: boolean } {
  const sources: InfluenceSourceV2[] = []; let unknown = false;
  if (facts !== undefined && !Array.isArray(facts)) return { sources, unknown: true };
  for (const fact of facts ?? []) {
    if (!fact?.key || !safeIndex(fact.key.node) || !safeIndex(fact.key.port) || !text(fact.key.field)) { unknown = true; continue; }
    const labels = Array.isArray(fact.integrity?.labels) ? fact.integrity.labels : []; if (fact.integrity && !Array.isArray(fact.integrity.labels)) unknown = true;
    if (fact.integrity?.unknown) unknown = true;
    for (const label of labels) { const kind = FACT_SOURCE_KIND[label]; if (kind) sources.push({ id: `fact:${fact.key.node}:${fact.key.port}:${fact.key.field}:${label}`, kind, node: fact.key.node, port: fact.key.port, field: fact.key.field, item: fact.key.item }); else unknown = true; }
  }
  return { sources, unknown };
}
function fromInput(input: InfluenceInputV2): { sources?: InfluenceSourceV2[]; unknown: boolean } {
  const derived = factsToSources(input?.facts);
  if (input?.sources === undefined) return input?.facts === undefined ? { sources: undefined, unknown: true } : { sources: derived.sources, unknown: derived.unknown };
  if (!Array.isArray(input.sources)) return { unknown: true };
  return { sources: [...input.sources], unknown: derived.unknown };
}
function overwritten(source: InfluenceSourceV2, node: number, port: number, overwrites: readonly InfluenceOverwriteV2[]): boolean { return overwrites.some((item) => item.node === node && (item.port === undefined || item.port === port) && (item.field === undefined || item.field === source.field || source.field.startsWith(`${item.field}/`))); }
function sinkTrace(trace: readonly InfluenceStepV2[], node: number, port: number, field: string): readonly InfluenceStepV2[] {
  const sink: InfluenceStepV2 = { kind: 'SINK', node, port, field }; const last = trace[trace.length - 1];
  return last?.kind === 'PROPAGATION' && last.node === node && last.port === port ? Object.freeze([...trace.slice(0, -1), sink]) : Object.freeze([...trace, sink]);
}
function finish(status: InfluenceResultV2['status'], state: Mutable, sources: readonly InfluenceSourceV2[]): InfluenceResultV2 {
  const kinds = [...new Set(sources.map((source) => normalizeKind(source?.kind)))].sort((left, right) => sourceKinds.indexOf(left) - sourceKinds.indexOf(right));
  const output = status === 'LIMIT_EXCEEDED' ? [] : [...state.output].sort((left, right) => sourceKinds.indexOf(left.sourceKind) - sourceKinds.indexOf(right.sourceKind) || compareText(left.sourceId, right.sourceId) || compareText(left.targetId, right.targetId));
  return Object.freeze({ status, influences: Object.freeze(output), independentSources: Object.freeze(kinds), omitted: state.omitted, operations: state.used, clean: status === 'COMPLETE' && output.length === 0 });
}
export function analyzeInfluenceV2(input: InfluenceInputV2): InfluenceResultV2 {
  const maximum = maxOf(input); const loaded = fromInput(input);
  if (maximum === undefined || loaded.sources === undefined || input.targets === undefined || input.flows === undefined || !Array.isArray(input.targets) || !Array.isArray(input.flows)) return finish('UNKNOWN', { used: 0, omitted: 1, unknown: true, output: [] }, loaded.sources ?? []);
  const sources = [...loaded.sources].sort(compare); const targets = [...input.targets]; const flows = [...input.flows]; const rawOverwrites = input.overwrites;
  const state: Mutable = { used: 0, omitted: 0, unknown: loaded.unknown || !targets.every(validTarget) || !flows.every(validFlow) || rawOverwrites !== undefined && (!Array.isArray(rawOverwrites) || !rawOverwrites.every(validOverwrite)), output: [] };
  if (state.unknown) return finish('UNKNOWN', state, sources);
  targets.sort(compare); flows.sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0) || left.fromNode - right.fromNode || left.fromPort - right.fromPort || left.toNode - right.toNode || left.toPort - right.toPort);
  const overwrites = rawOverwrites ?? []; const targetByKey = new Map<string, InfluenceTargetV2>(); const outgoing = new Map<string, InfluenceFlowV2[]>();
  for (const target of targets) { const key = `${target.node}|${target.port}`; if (targetByKey.has(key)) state.unknown = true; targetByKey.set(key, target); }
  for (const edge of flows) { if (++state.used > maximum) { state.omitted += 1; return finish('LIMIT_EXCEEDED', state, sources); } const key = `${edge.fromNode}|${edge.fromPort}`; const bucket = outgoing.get(key); if (bucket) bucket.push(edge); else outgoing.set(key, [edge]); }
  if (state.unknown) return finish('UNKNOWN', state, sources);
  for (const source of sources) {
    if (!validSource(source) || normalizeKind(source.kind) === 'UNKNOWN') { state.unknown = true; continue; }
    const queue: State[] = [{ source, node: source.node, port: source.port, trace: Object.freeze([{ kind: 'SOURCE', node: source.node, port: source.port, field: source.field }]) }]; const visited = new Set<string>();
    while (queue.length) {
      if (++state.used > maximum) { state.omitted += 1; return finish('LIMIT_EXCEEDED', state, sources); }
      const current = queue.shift()!; const key = `${source.id}|${current.node}|${current.port}`; if (visited.has(key)) continue; visited.add(key);
      if (overwritten(source, current.node, current.port, overwrites)) continue;
      const target = targetByKey.get(`${current.node}|${current.port}`);
      if (target !== undefined) { if (++state.used > maximum) { state.omitted += 1; return finish('LIMIT_EXCEEDED', state, sources); } state.output.push(Object.freeze({ sourceId: source.id, sourceKind: normalizeKind(source.kind), sourceNode: source.node, sourcePort: source.port, targetId: target.id, targetNode: target.node, targetPort: target.port, tool: target.tool, effect: target.effect, argumentPaths: Object.freeze([...(target.argumentPaths ?? [])]), trace: sinkTrace(current.trace, target.node, target.port, source.field) })); }
      for (const edge of outgoing.get(`${current.node}|${current.port}`) ?? []) {
        if (++state.used > maximum) { state.omitted += 1; return finish('LIMIT_EXCEEDED', state, sources); }
        if (edge.resolution !== undefined && edge.resolution !== 'RESOLVED') { state.unknown = true; continue; }
        queue.push({ source, node: edge.toNode, port: edge.toPort, trace: Object.freeze([...current.trace, { kind: 'PROPAGATION', node: edge.toNode, port: edge.toPort, field: source.field, ...(edge.ordinal === undefined ? {} : { edgeOrdinal: edge.ordinal }) }]) });
      }
    }
  }
  return finish(state.unknown ? 'UNKNOWN' : 'COMPLETE', state, sources);
}
export const deriveAgenticInfluenceV2 = analyzeInfluenceV2;
export const analyzeInfluence = analyzeInfluenceV2;
export const analyzeAgenticInfluenceV2 = analyzeInfluenceV2;
export const materializeInfluenceV2 = analyzeInfluenceV2;
