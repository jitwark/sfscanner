/**
 * The immutable view the scheduler hands each capability: the per-field copy budgets derived from
 * the documented limits, and the bounded copy walk that enforces them. Extracted from
 * `scheduler.ts` (2026-10-17 file-size remediation) with no behaviour change: every function,
 * bound, comment and refusal path below is the reviewed D-1 implementation, moved verbatim.
 */
import { DEFAULT_SCANNER_LIMITS_V2, type ScannerLimitsV2 } from '@hub/contracts';
import { isParsedSourceDocument } from '../source/source-document-provenance';
import { MAX_SOURCE_PARSER_DEPTH } from '../source/source-preflight';
import type { AnalyzerContextV2 } from './scheduler';
/**
 * The bounds on the immutable view the scheduler hands each capability. They are a guard against a
 * runaway walk, never an admission limit: everything they bound is already bounded by the
 * documented limits the parser and normalizer enforce, so exporting a constant here would refuse a
 * workflow the documentation says is admissible. D-1 (2026-10-17): the constant was
 * `{ depth: 64, objects: 8192, items: 4096 }`, and it refused every workflow of roughly 2,500
 * source members as `REQUIRED_CAPABILITY_FAILED` while every limit row reported `exhausted: false`
 * — a ceiling two orders of magnitude below the documented `maxMembersAndElements = 250000`, and
 * one no operator could see or raise.
 *
 * The floor keeps the original tightness for the context fields whose admissible size is a constant
 * (`limits`, `rules`, `priorOutcomes`, the parser-owned `source`), where an oversized graph is
 * always hostile rather than admissible. `target` is not one of those: the target admission admits
 * far more than the floor, so it carries its own budget below (D-1 review, finding 3).
 */
const CONTEXT_SNAPSHOT_FLOOR_V2: SnapshotBudgetV2 = Object.freeze({ objects: 8_192, items: 4_096, depth: 64 });
/**
 * What the target admission admits, which the floor must not undercut: `semantics/target-context.ts`
 * bounds `communityPackages` and `configuration` at `MAX_COLLECTION_ITEMS = 100_000` items each, so
 * a target that passes `validateTargetContextV3` can sit far above the floor and is not a hostile
 * graph. Both constants must stay in step with that file.
 */
const CONTEXT_TARGET_COLLECTION_ITEMS_V2 = 100_000;
const CONTEXT_TARGET_UNITS_V2 = 2 * CONTEXT_TARGET_COLLECTION_ITEMS_V2;
/**
 * The copy cost of one admissible unit, measured on the D-1 fixtures. The normalized workflow
 * mirrors every source member at least twice — once in `workflowFields`, once under the owning
 * node's `parameters`/`credentials`/`settings` — and each mirror costs two copied objects (the
 * semantic field and its occurrence list), so one member costs about four objects before refs and
 * spans. The factor of two over that measurement is headroom for the retained spans (the span
 * object, its two positions and its occurrence path), the node and edge refs, identity and label
 * objects that share those members; the seven measured shapes ran 1.73–2.65 objects per unit
 * against this factor of 8 (D1-FIX-REVIEW.md).
 */
const CONTEXT_OBJECTS_PER_UNIT_V2 = 8;
const CONTEXT_DEPTH_PER_DOCUMENT_LEVEL_V2 = 2;
const CONTEXT_DEPTH_OVERHEAD_V2 = 16;
const CONTEXT_SEMANTIC_OBJECTS_PER_NODE_V2 = 64;
const LIMIT_KEYS = Object.getOwnPropertyNames(DEFAULT_SCANNER_LIMITS_V2);
/** `Map.prototype.size` through its intrinsic getter: an instance cannot lie about its own size. */
const MAP_SIZE_V2 = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get as (this: ReadonlyMap<unknown, unknown>) => number;
type SnapshotBudgetV2 = Readonly<{ objects: number; items: number; depth: number }>;
export type SnapshotBoundV2 = Readonly<{ observed: number; maximum: number; omitted: number }>;
type SnapshotState = { nodes: number; budget: SnapshotBudgetV2 };
/**
 * The numbers one limit refusal publishes. `observed` is the real size of the collection that
 * crossed a per-container bound (`omitted` is the part that bound saw and refused); for the two
 * cumulative budgets — which stop the walk at the first crossing and cannot say how far past it the
 * document goes — it is the bound that fired, because `maximum + 1` would dress a design stop as a
 * size measurement and tell an operator nothing about the document.
 */
export const snapshotBound = (observed: number, maximum: number): SnapshotBoundV2 => ({ observed, maximum, omitted: Math.max(0, observed - maximum) });
/**
 * The wrapped failure of a context-view walk. It carries the numbers the diagnostic publishes, so a
 * refused view reports the size that fired and the bound it fired against instead of an opaque
 * capability failure (D-1).
 */
export class ContextSnapshotLimitV2 extends TypeError {
  readonly observed: number;
  readonly maximum: number;
  constructor(observed: number, maximum: number) {
    super('Context snapshot bound exceeded');
    this.observed = observed;
    this.maximum = maximum;
  }
}
/**
 * The per-field copy budgets of one context view, derived from the documented limits that bound the
 * field's content. `workflow` is the only field that carries the normalized document: its arrays are
 * bounded by `maxNodes`, `maxEdges`, `maxStoredSourceSpans` and `maxMembersAndElements`, its depth by
 * `maxDocumentDepth` (each document level costs two levels in the semantic mirror), and its object
 * count by the per-unit copy cost measured above. `semantics` carries one resolved catalogue entry
 * per node, and `target` carries what its own admission admits (at most two collections of
 * `CONTEXT_TARGET_COLLECTION_ITEMS_V2` items each); every other field is request metadata whose
 * admissible size is a constant.
 */
function contextSnapshotBudgets(limits: ScannerLimitsV2): Readonly<Record<string, SnapshotBudgetV2>> {
  const units = limits.maxMembersAndElements + limits.maxStoredSourceSpans + limits.maxNodes + limits.maxEdges;
  return Object.freeze({
    target: Object.freeze({
      objects: CONTEXT_SNAPSHOT_FLOOR_V2.objects + CONTEXT_OBJECTS_PER_UNIT_V2 * CONTEXT_TARGET_UNITS_V2,
      items: Math.max(CONTEXT_SNAPSHOT_FLOOR_V2.items, CONTEXT_TARGET_COLLECTION_ITEMS_V2),
      depth: CONTEXT_SNAPSHOT_FLOOR_V2.depth,
    }),
    workflow: Object.freeze({
      objects: CONTEXT_SNAPSHOT_FLOOR_V2.objects + CONTEXT_OBJECTS_PER_UNIT_V2 * units,
      items: Math.max(CONTEXT_SNAPSHOT_FLOOR_V2.items, limits.maxMembersAndElements, limits.maxStoredSourceSpans, limits.maxNodes, limits.maxEdges, limits.maxParameterLeaves),
      depth: CONTEXT_SNAPSHOT_FLOOR_V2.depth + CONTEXT_DEPTH_OVERHEAD_V2 + CONTEXT_DEPTH_PER_DOCUMENT_LEVEL_V2 * Math.min(limits.maxDocumentDepth, MAX_SOURCE_PARSER_DEPTH),
    }),
    semantics: Object.freeze({
      objects: CONTEXT_SNAPSHOT_FLOOR_V2.objects + CONTEXT_SEMANTIC_OBJECTS_PER_NODE_V2 * limits.maxNodes,
      items: Math.max(CONTEXT_SNAPSHOT_FLOOR_V2.items, limits.maxNodes),
      depth: CONTEXT_SNAPSHOT_FLOOR_V2.depth,
    }),
  });
}
/**
 * The top-level record guard the walk applied to its own root before this view existed: a plain
 * prototype, no symbols, no more own names than the floor admits, and every own property a data
 * property. It cannot be left to the walk — `contextSnapshotBudgets(input.limits)` reads a property
 * and the spread copies the rest, so either would touch an accessor before any check — and it is not
 * the spread's job: `...` invokes accessors and silently drops symbol keys.
 */
function assertContextRecord(input: unknown): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError();
  const prototype = Object.getPrototypeOf(input);
  const names = ownNames(input, CONTEXT_SNAPSHOT_FLOOR_V2.items, 0);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  for (const name of names) { const descriptor = Object.getOwnPropertyDescriptor(input, name); if (!descriptor || !('value' in descriptor)) throw new TypeError(); }
}
export function contextView(input: AnalyzerContextV2): AnalyzerContextV2 {
  assertContextRecord(input);
  const budgets = contextSnapshotBudgets(input.limits);
  const seen = new Map<object, unknown>();
  const view = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries({ ...input })) {
    const budget = budgets[key] ?? CONTEXT_SNAPSHOT_FLOOR_V2;
    Object.defineProperty(view, key, {
      value: key === 'limits' ? snapshotLimits(value) : snapshot(value, seen, { nodes: 0, budget }, 0),
      enumerable: true, writable: true, configurable: true,
    });
  }
  return Object.freeze(view) as AnalyzerContextV2;
}

function snapshot(input: unknown, seen: Map<object, unknown>, state: SnapshotState, depth: number): unknown {
  if (typeof input === 'function') throw new TypeError(); if (input === null || typeof input !== 'object') return input;
  if (isParsedSourceDocument(input)) return input;
  const existing = seen.get(input);
  if (existing !== undefined) return existing;
  // The two cumulative budgets stop the walk at the first crossing and cannot know how far past it
  // the document goes, so they publish the bound that fired rather than `maximum + 1`.
  if (depth > state.budget.depth) throw new ContextSnapshotLimitV2(state.budget.depth, state.budget.depth);
  if (state.nodes >= state.budget.objects) throw new ContextSnapshotLimitV2(state.budget.objects, state.budget.objects);
  state.nodes += 1;
  if (input instanceof Map) return snapshotMap(input, seen, state, depth);
  if (Array.isArray(input)) return snapshotArray(input, seen, state, depth);
  return snapshotRecord(input, seen, state, depth);
}
function snapshotMap(input: ReadonlyMap<unknown, unknown>, seen: Map<object, unknown>, state: SnapshotState, depth: number): ReadonlyMap<unknown, unknown> {
  ownNames(input as object, 0, 1, [Symbol.iterator]);
  // The map's entry count is known before the walk, so the refusal publishes the real collection
  // size and the entries the bound refuses, not the first crossing.
  const size = MAP_SIZE_V2.call(input);
  if (size > state.budget.items) throw new ContextSnapshotLimitV2(size, state.budget.items);
  const target = new Map<unknown, unknown>(); const view = immutableMap(target);
  seen.set(input as object, view);
  Map.prototype.forEach.call(input, (value: unknown, key: unknown) => { target.set(snapshot(key, seen, state, depth + 1), snapshot(value, seen, state, depth + 1)); });
  return view;
}
function snapshotArray(input: readonly unknown[], seen: Map<object, unknown>, state: SnapshotState, depth: number): readonly unknown[] {
  const length = Object.getOwnPropertyDescriptor(input, 'length');
  if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0) throw new TypeError();
  if (length.value > state.budget.items) throw new ContextSnapshotLimitV2(length.value, state.budget.items);
  const names = ownNames(input, length.value + 1, 0); if (names.length !== length.value + 1 || names.some((name) => name !== 'length' && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= length.value))) throw new TypeError();
  const output = new Array<unknown>(length.value); Object.setPrototypeOf(output, null); seen.set(input as object, output);
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !('value' in descriptor)) throw new TypeError();
    Object.defineProperty(output, String(index), { value: snapshot(descriptor.value, seen, state, depth + 1), enumerable: descriptor.enumerable, writable: true, configurable: true });
  }
  return Object.freeze(output);
}
function snapshotLimits(input: unknown): object {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError();
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of LIMIT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor)) throw new TypeError();
    Object.defineProperty(output, key, { value: descriptor.value, enumerable: true, writable: false, configurable: false });
  }
  return Object.freeze(output);
}
function snapshotRecord(input: object, seen: Map<object, unknown>, state: SnapshotState, depth: number): object {
  const prototype = Object.getPrototypeOf(input);
  const names = ownNames(input, state.budget.items, 0);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const output = Object.create(null) as Record<string, unknown>; seen.set(input, output);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor || !('value' in descriptor)) throw new TypeError();
    Object.defineProperty(output, name, { value: name === 'limits' ? snapshotLimits(descriptor.value) : snapshot(descriptor.value, seen, state, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return Object.freeze(output);
}
function immutableMap<K, V>(input: Map<K, V>): ReadonlyMap<K, V> {
  const view = Object.create(null) as ReadonlyMap<K, V> & { set(key: K, value: V): unknown; delete(key: K): boolean; clear(): void };
  Object.defineProperties(view, {
    size: { value: input.size }, get: { value: (key: K) => input.get(key) }, has: { value: (key: K) => input.has(key) },
    entries: { value: () => input.entries() }, keys: { value: () => input.keys() }, values: { value: () => input.values() },
    forEach: { value: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) => input.forEach((value, key) => callback.call(thisArg, value, key, view)) },
    set: { value: () => view }, delete: { value: () => false }, clear: { value: () => undefined },
    [Symbol.iterator]: { value: () => input.entries() },
  });
  return Object.freeze(view);
}
export function ownNames(input: object, maximum: number, maximumSymbols: number, allowedSymbols: readonly symbol[] | null = []): readonly string[] {
  const names = Object.getOwnPropertyNames(input); if (names.length > maximum) throw new TypeError();
  const symbols = Object.getOwnPropertySymbols(input); if (symbols.length > maximumSymbols) throw new TypeError();
  for (const symbol of symbols) if (allowedSymbols !== null && !allowedSymbols.includes(symbol)) throw new TypeError(); return names;
}
