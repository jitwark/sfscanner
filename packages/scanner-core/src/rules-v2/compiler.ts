import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJsonBytes } from '../canonical-json';
import { SAFE_FACT_REGISTRY_V2, type SafePropertyTypeV2 } from '../facts/safe-fact-registry';
import { createAdmittedRuleView } from '../v2/admitted-registry';
import { admittedRuleV2 } from './rule-authority';
import type { RuleExpressionV2, RulePackV2 } from './pack-schema';

export type InstructionV2 = Readonly<
  | { op: 'FACT_EXISTS'; kind: string }
  | { op: 'PROPERTY_EQ'; factKind: string; property: string; value: string | number | boolean | null }
  | { op: 'PROPERTY_IN'; factKind: string; property: string; values: readonly (string | number | boolean | null)[] }
  | { op: 'ALL' | 'ANY'; children: readonly InstructionV2[] }
  | { op: 'NOT'; child: InstructionV2 }
>;
export type CompiledRulePackV2 = Readonly<{
  packDigest: string;
  rules: readonly Readonly<{ ruleId: string; instructions: readonly InstructionV2[] }>[];
}>;

const MAX_NODES = 1_000;
const MAX_DEPTH = 32;
const ADMITTED_RULES_V2 = createAdmittedRuleView().rules;
const invalid = (): TypeError => new TypeError('Invalid admitted rule pack');
const plain = (value: unknown): value is object => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const data = (value: object, key: string): unknown => { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !('value' in descriptor)) throw invalid(); return descriptor.value; };
const exact = (value: object, keys: readonly string[]): boolean => Object.getOwnPropertySymbols(value).length === 0 && Object.getOwnPropertyNames(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
function dense(value: unknown, maximum = MAX_NODES): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw invalid();
  const length = data(value, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximum) throw invalid();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== length + 1 || Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) result.push(data(value, String(index)));
  return result;
}
const schemaFor = (kind: unknown) => {
  if (typeof kind !== 'string') throw invalid();
  const schema = SAFE_FACT_REGISTRY_V2.schemas.find((candidate) => candidate.kind === kind);
  if (!schema) throw invalid();
  return schema;
};
function scalar(value: unknown, type: SafePropertyTypeV2, allowList = false): value is string | number | boolean | null {
  if (type === 'STRING' || type === 'STRING_LIST') return typeof value === 'string';
  if (type === 'INTEGER' || type === 'INTEGER_LIST') return typeof value === 'number' && Number.isSafeInteger(value);
  if (type === 'BOOLEAN') return typeof value === 'boolean';
  if (type === 'NULLABLE_STRING') return value === null || typeof value === 'string';
  return allowList && value === null;
}
function selector(kind: unknown, property: unknown, value: unknown, op: 'PROPERTY_EQ' | 'PROPERTY_IN'): void {
  const schema = schemaFor(kind); const key = typeof property === 'string' ? property : '';
  const descriptor = Object.getOwnPropertyDescriptor(schema.properties, key);
  if (!descriptor || !('value' in descriptor)) throw invalid();
  const type = descriptor.value as SafePropertyTypeV2;
  if (op === 'PROPERTY_EQ' && (type.endsWith('_LIST') || !scalar(value, type))) throw invalid();
  if (op === 'PROPERTY_IN') {
    const values = dense(value);
    if (values.length === 0 || !values.every((item) => scalar(item, type))) throw invalid();
  }
}

type CompileFrame = Readonly<{ input: object; depth: number; exit: boolean; op?: 'ALL' | 'ANY' | 'NOT'; children?: readonly unknown[] }>;
function compileExpression(root: unknown): InstructionV2 {
  const frames: CompileFrame[] = [{ input: root as object, depth: 1, exit: false }];
  const active = new WeakSet<object>(); const outputs = new WeakMap<object, InstructionV2>(); let nodes = 0;
  while (frames.length > 0) {
    const frame = frames.pop()!;
    if (frame.exit) {
      const children: InstructionV2[] = [];
      for (const child of frame.children!) { if (!plain(child)) throw invalid(); const output = outputs.get(child); if (!output) throw invalid(); children.push(output); }
      const output: InstructionV2 = frame.op === 'NOT' ? Object.freeze({ op: 'NOT', child: children[0]! }) : Object.freeze({ op: frame.op!, children: Object.freeze(children) });
      outputs.set(frame.input, output); active.delete(frame.input); continue;
    }
    if (!plain(frame.input) || active.has(frame.input) || frame.depth > MAX_DEPTH) throw invalid();
    active.add(frame.input); nodes += 1; if (nodes > MAX_NODES) throw invalid();
    const op = data(frame.input, 'op'); if (typeof op !== 'string') throw invalid();
    if (op === 'FACT_EXISTS') {
      if (!exact(frame.input, ['op', 'kind'])) throw invalid(); const kind = data(frame.input, 'kind'); schemaFor(kind);
      outputs.set(frame.input, Object.freeze({ op, kind: kind as string })); active.delete(frame.input); continue;
    }
    if (op === 'PROPERTY_EQ' || op === 'PROPERTY_IN') {
      const keys = op === 'PROPERTY_EQ' ? ['op', 'factKind', 'property', 'value'] : ['op', 'factKind', 'property', 'values'];
      if (!exact(frame.input, keys)) throw invalid(); const kind = data(frame.input, 'factKind'); const property = data(frame.input, 'property'); const value = data(frame.input, op === 'PROPERTY_EQ' ? 'value' : 'values');
      selector(kind, property, value, op);
      outputs.set(frame.input, op === 'PROPERTY_EQ' ? Object.freeze({ op, factKind: kind as string, property: property as string, value: value as string | number | boolean | null }) : Object.freeze({ op, factKind: kind as string, property: property as string, values: Object.freeze(dense(value).slice() as (string | number | boolean | null)[]) }));
      active.delete(frame.input); continue;
    }
    if (op === 'STRING_MATCHES' || (op !== 'ALL' && op !== 'ANY' && op !== 'NOT')) throw invalid();
    const keys = op === 'NOT' ? ['op', 'expression'] : ['op', 'expressions']; if (!exact(frame.input, keys)) throw invalid();
    const children = op === 'NOT' ? [data(frame.input, 'expression')] : dense(data(frame.input, 'expressions'));
    if (children.length === 0 || children.length > MAX_NODES || children.some((child) => !plain(child))) throw invalid();
    frames.push({ input: frame.input, depth: frame.depth, exit: true, op, children });
    for (let index = children.length - 1; index >= 0; index -= 1) frames.push({ input: children[index] as object, depth: frame.depth + 1, exit: false });
  }
  const result = outputs.get(root as object); if (!result) throw invalid(); return result;
}

export function compileRulePack(pack: RulePackV2): CompiledRulePackV2 {
  try {
    if (!plain(pack) || !exact(pack, ['schemaVersion', 'id', 'version', 'compatibleEngine', 'requiredSafeFactRegistryDigest', 'rules', 'signatures'])) throw invalid();
    if (data(pack, 'schemaVersion') !== 'scanner-rule-pack-v2' || typeof data(pack, 'id') !== 'string' || typeof data(pack, 'version') !== 'string') throw invalid();
    const rawRules = dense(data(pack, 'rules')); const rules: Readonly<{ ruleId: string; instructions: readonly InstructionV2[] }>[] = []; const ids = new Set<string>(); let previous = '';
    for (const rawRule of rawRules) {
      if (!plain(rawRule) || !exact(rawRule, ['ruleId', 'revision', 'capabilityId', 'evidenceSchemaId', 'remediationId', 'when'])) throw invalid();
      const ruleId = data(rawRule, 'ruleId'); const revision = data(rawRule, 'revision'); if (typeof ruleId !== 'string' || typeof revision !== 'string' || ids.has(ruleId) || previous > ruleId) throw invalid();
      // Admission already refused an unknown rule id; a forged pack must not lower one either.
      if (admittedRuleV2(ADMITTED_RULES_V2, ruleId) === undefined) throw invalid();
      ids.add(ruleId); previous = ruleId; rules.push(Object.freeze({ ruleId, instructions: Object.freeze([compileExpression(data(rawRule, 'when'))]) }));
    }
    const packDigest = bytesToHex(sha256(canonicalJsonBytes(pack)));
    return Object.freeze({ packDigest, rules: Object.freeze(rules) });
  } catch { throw invalid(); }
}
