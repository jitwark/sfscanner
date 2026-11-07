import type { SafeFactV2 } from '../capabilities/scheduler';
import { SAFE_FACT_REGISTRY_V2, type SafePropertyTypeV2 } from '../facts/safe-fact-registry';
import { all, any, not, type TriState } from './tri-state';
import type { InstructionV2 } from './compiler';

export type RuleEvaluationV2 = Readonly<{ value: TriState; operations: number; exhausted: boolean }>;
type Scalar = string | number | boolean | null;
type FactValue = Scalar | readonly Scalar[];
type FactView = Readonly<{ kind: string; properties: Readonly<Record<string, FactValue | typeof UNSUPPORTED>> }>;
type Dict = Record<string, unknown>;
type Frame = { node: InstructionV2; index: number; aggregate: TriState; waiting: boolean };
type GroupInstruction = Extract<InstructionV2, { op: 'ALL' | 'ANY' }>;
type GraphFrame = Readonly<{ input: object; depth: number; exit: boolean; op?: 'ALL' | 'ANY' | 'NOT'; children?: readonly unknown[] }>;
const MAX_NODES = 1_000;
const MAX_DEPTH = 32;
const MAX_FACTS = 4_096;
const UNSUPPORTED = Symbol('unsupported');
const bad = (): TypeError => new TypeError('Invalid rule evaluation input');
const isGroupInstruction = (node: InstructionV2): node is GroupInstruction => node.op === 'ALL' || node.op === 'ANY';
const unknownResult = (operations = 0, exhausted = false): RuleEvaluationV2 => Object.freeze({ value: 'UNKNOWN' as const, operations, exhausted });
const plain = (value: unknown): value is object => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const data = (value: object, key: string): unknown => { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !('value' in descriptor)) throw bad(); return descriptor.value; };
const exact = (value: object, keys: readonly string[]): boolean => Object.getOwnPropertySymbols(value).length === 0 && Object.getOwnPropertyNames(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
function dense(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw bad();
  const length = data(value, 'length'); if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximum) throw bad();
  const names = Object.getOwnPropertyNames(value); if (names.length !== length + 1 || Object.getOwnPropertySymbols(value).length !== 0) throw bad();
  const output: unknown[] = []; for (let index = 0; index < length; index += 1) output.push(data(value, String(index))); return output;
}
const schemaFor = (kind: unknown) => {
  if (typeof kind !== 'string') throw bad(); const schema = SAFE_FACT_REGISTRY_V2.schemas.find((candidate) => candidate.kind === kind); if (!schema) throw bad(); return schema;
};
function scalar(value: unknown, type: SafePropertyTypeV2): value is Scalar {
  if (type === 'STRING' || type === 'STRING_LIST') return typeof value === 'string';
  if (type === 'INTEGER' || type === 'INTEGER_LIST') return typeof value === 'number' && Number.isSafeInteger(value);
  if (type === 'BOOLEAN') return typeof value === 'boolean';
  return value === null || typeof value === 'string';
}
function selectorValid(kind: unknown, property: unknown, value: unknown, op: 'PROPERTY_EQ' | 'PROPERTY_IN'): boolean {
  try {
    const schema = schemaFor(kind); if (typeof property !== 'string') return false; const descriptor = Object.getOwnPropertyDescriptor(schema.properties, property); if (!descriptor || !('value' in descriptor)) return false;
    const type = descriptor.value as SafePropertyTypeV2;
    if (op === 'PROPERTY_EQ') return !type.endsWith('_LIST') && scalar(value, type);
    const values = dense(value, MAX_NODES); return values.length > 0 && values.every((item) => scalar(item, type));
  } catch { return false; }
}
function cloneInstruction(root: unknown): InstructionV2 | undefined {
  try {
    const frames: GraphFrame[] = [{ input: root as object, depth: 1, exit: false }]; const active = new WeakSet<object>(); const outputs = new WeakMap<object, InstructionV2>(); let nodes = 0;
    while (frames.length > 0) {
      const frame = frames.pop()!;
      if (frame.exit) {
        const children: InstructionV2[] = []; for (const child of frame.children!) { if (!plain(child)) return undefined; const output = outputs.get(child); if (!output) return undefined; children.push(output); }
        const output: InstructionV2 = frame.op === 'NOT' ? Object.freeze({ op: 'NOT', child: children[0]! }) : Object.freeze({ op: frame.op!, children: Object.freeze(children) });
        outputs.set(frame.input, output); active.delete(frame.input); continue;
      }
      if (!plain(frame.input) || active.has(frame.input) || frame.depth > MAX_DEPTH) return undefined;
      active.add(frame.input); nodes += 1; if (nodes > MAX_NODES) return undefined;
      const op = data(frame.input, 'op'); if (typeof op !== 'string') return undefined;
      if (op === 'FACT_EXISTS') {
        if (!exact(frame.input, ['op', 'kind']) || typeof data(frame.input, 'kind') !== 'string') return undefined; schemaFor(data(frame.input, 'kind')); outputs.set(frame.input, Object.freeze({ op, kind: data(frame.input, 'kind') as string })); active.delete(frame.input); continue;
      }
      if (op === 'PROPERTY_EQ' || op === 'PROPERTY_IN') {
        const keys = op === 'PROPERTY_EQ' ? ['op', 'factKind', 'property', 'value'] : ['op', 'factKind', 'property', 'values']; if (!exact(frame.input, keys)) return undefined;
        const factKind = data(frame.input, 'factKind'); const property = data(frame.input, 'property'); const value = data(frame.input, op === 'PROPERTY_EQ' ? 'value' : 'values'); if (!selectorValid(factKind, property, value, op)) return undefined;
        const instruction = op === 'PROPERTY_EQ' ? Object.freeze({ op, factKind: factKind as string, property: property as string, value: value as Scalar }) : Object.freeze({ op, factKind: factKind as string, property: property as string, values: Object.freeze(dense(value, MAX_NODES) as Scalar[]) });
        outputs.set(frame.input, instruction); active.delete(frame.input); continue;
      }
      if (op === 'STRING_MATCHES' || (op !== 'ALL' && op !== 'ANY' && op !== 'NOT')) return undefined;
      const keys = op === 'NOT' ? ['op', 'child'] : ['op', 'children']; if (!exact(frame.input, keys)) return undefined;
      const children = op === 'NOT' ? [data(frame.input, 'child')] : dense(data(frame.input, 'children'), MAX_NODES); if (children.length === 0 || children.some((child) => !plain(child))) return undefined;
      frames.push({ input: frame.input, depth: frame.depth, exit: true, op, children }); for (let index = children.length - 1; index >= 0; index -= 1) frames.push({ input: children[index] as object, depth: frame.depth + 1, exit: false });
    }
    return outputs.get(root as object);
  } catch { return undefined; }
}
function subjectValid(value: unknown): boolean {
  if (!plain(value)) return false; try { const kind = data(value, 'kind'); if (kind === 'WORKFLOW') return exact(value, ['kind']); if (kind === 'NODE') return exact(value, ['kind', 'node']) && plain(data(value, 'node')); if (kind === 'EDGE') return exact(value, ['kind', 'edge']) && plain(data(value, 'edge')); if (kind === 'SOURCE') return exact(value, ['kind', 'source']) && plain(data(value, 'source')); return false; } catch { return false; }
}
function snapshotValue(value: unknown): FactValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  try { return Object.freeze(dense(value, MAX_FACTS).map((item) => { if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number') return item; throw bad(); })); } catch { return undefined; }
}
function snapshotFacts(input: readonly SafeFactV2[]): readonly FactView[] | undefined {
  try {
    const values = dense(input, MAX_FACTS); const ids = new Set<string>(); const result: FactView[] = [];
    for (const raw of values) {
      if (!plain(raw) || !exact(raw, ['factId', 'kind', 'subject', 'properties'])) return undefined;
      const factId = data(raw, 'factId'); const kind = data(raw, 'kind'); if (typeof factId !== 'string' || typeof kind !== 'string' || ids.has(factId) || !subjectValid(data(raw, 'subject'))) return undefined;
      ids.add(factId); const schema = schemaFor(kind); const properties = data(raw, 'properties'); if (!plain(properties)) return undefined;
      const propertyNames = Object.getOwnPropertyNames(properties); if (Object.getOwnPropertySymbols(properties).length !== 0 || propertyNames.some((name) => Object.getOwnPropertyDescriptor(schema.properties, name) === undefined)) return undefined;
      const copy: Record<string, FactValue | typeof UNSUPPORTED> = Object.create(null);
      for (const name of propertyNames) { const value = snapshotValue(data(properties, name)); if (value === undefined) return undefined; copy[name] = value; }
      result.push(Object.freeze({ kind, properties: Object.freeze(copy) }));
    }
    return Object.freeze(result);
  } catch { return undefined; }
}
function supported(value: FactValue | typeof UNSUPPORTED, type: SafePropertyTypeV2): boolean {
  if (Array.isArray(value)) return (type === 'STRING_LIST' && value.every((item) => typeof item === 'string')) || (type === 'INTEGER_LIST' && value.every((item) => typeof item === 'number' && Number.isSafeInteger(item)));
  return scalar(value, type) && !type.endsWith('_LIST');
}
function propertyResult(facts: readonly FactView[], node: Extract<InstructionV2, { op: 'PROPERTY_EQ' | 'PROPERTY_IN' }>): TriState {
  const schema = SAFE_FACT_REGISTRY_V2.schemas.find((candidate) => candidate.kind === node.factKind)!; const type = schema.properties[node.property]!; let unknown = false; let matched = false;
  for (const fact of facts) {
    if (fact.kind !== node.factKind) continue; matched = true; if (!Object.prototype.hasOwnProperty.call(fact.properties, node.property)) { unknown = true; continue; }
    const value = fact.properties[node.property]!; if (!supported(value, type)) { unknown = true; continue; }
    if (node.op === 'PROPERTY_EQ' && Object.is(value, node.value)) return 'TRUE';
    if (node.op === 'PROPERTY_IN') { const expected = node.values; if (Array.isArray(value) ? value.some((item) => expected.some((candidate) => Object.is(item, candidate))) : expected.some((candidate) => Object.is(value, candidate))) return 'TRUE'; }
  }
  if (unknown || !matched) return 'UNKNOWN'; return 'FALSE';
}
function readLeaf(node: Exclude<InstructionV2, { op: 'ALL' | 'ANY' | 'NOT' }>, facts: readonly FactView[]): TriState {
  if (node.op === 'FACT_EXISTS') return facts.some((fact) => fact.kind === node.kind) ? 'TRUE' : 'UNKNOWN';
  return propertyResult(facts, node);
}
function evaluate(root: InstructionV2, facts: readonly FactView[], maxOperations: number): RuleEvaluationV2 {
  const frames: Frame[] = [{ node: root, index: 0, aggregate: 'UNKNOWN', waiting: false }]; const values: TriState[] = []; let operations = 0;
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    if (!frame.waiting) {
      if (operations >= maxOperations) return unknownResult(operations, true); operations += 1;
      if (isGroupInstruction(frame.node)) { const group = frame.node; frame.aggregate = group.op === 'ALL' ? 'TRUE' : 'FALSE'; frame.waiting = true; frame.index = 0; frames.push({ node: group.children[0]!, index: 0, aggregate: 'UNKNOWN', waiting: false }); continue; }
      if (frame.node.op === 'NOT') { frame.waiting = true; frames.push({ node: frame.node.child, index: 0, aggregate: 'UNKNOWN', waiting: false }); continue; }
      values.push(readLeaf(frame.node, facts)); frames.pop(); continue;
    }
    const child = values.pop(); if (child === undefined) return unknownResult(operations, false);
    if (frame.node.op === 'NOT') { values.push(not(child)); frames.pop(); continue; }
    if (!isGroupInstruction(frame.node)) return unknownResult(operations, false);
    const group = frame.node;
    frame.aggregate = group.op === 'ALL' ? all([frame.aggregate, child]) : any([frame.aggregate, child]);
    if ((group.op === 'ALL' && frame.aggregate === 'FALSE') || (group.op === 'ANY' && frame.aggregate === 'TRUE')) { values.push(frame.aggregate); frames.pop(); continue; }
    frame.index += 1;
    if (frame.index < group.children.length) { frames.push({ node: group.children[frame.index]!, index: 0, aggregate: 'UNKNOWN', waiting: false }); continue; }
    values.push(frame.aggregate); frames.pop();
  }
  return Object.freeze({ value: values[0] ?? 'UNKNOWN', operations, exhausted: false });
}

export function evaluateCompiledRule(rule: Readonly<{ instructions: readonly InstructionV2[] }>, facts: readonly SafeFactV2[], maxRuleOperations: number): RuleEvaluationV2 {
  if (typeof maxRuleOperations !== 'number' || !Number.isSafeInteger(maxRuleOperations) || maxRuleOperations < 0) return unknownResult();
  try {
    if (!plain(rule)) return unknownResult(); const names = Object.getOwnPropertyNames(rule); if (!(names.length === 1 && names[0] === 'instructions' || names.length === 2 && names.includes('instructions') && names.includes('ruleId'))) return unknownResult();
    const rootValues = dense(data(rule, 'instructions'), MAX_NODES); if (rootValues.length !== 1) return unknownResult(); const root = cloneInstruction(rootValues[0]); if (!root) return unknownResult();
    const safeFacts = snapshotFacts(facts); if (!safeFacts) return unknownResult(); return evaluate(root, safeFacts, maxRuleOperations);
  } catch { return unknownResult(); }
}
