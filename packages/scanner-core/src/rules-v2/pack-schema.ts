import { SAFE_FACT_REGISTRY_V2, type SafePropertyTypeV2 } from '../facts/safe-fact-registry';
import { createAdmittedRuleView } from '../v2/admitted-registry';
import { admittedRuleV2 } from './rule-authority';
import { parseStrictSemver } from '../semantics/semver';
import { matchesVersionRange, validateVersionRange, type VersionRangeV2 } from '../semantics/version-range';
export type { VersionRangeV2 };

export type RuleExpressionV2 = Readonly<
  | { op: 'FACT_EXISTS'; kind: string }
  | { op: 'PROPERTY_EQ'; factKind: string; property: string; value: string | number | boolean | null }
  | { op: 'PROPERTY_IN'; factKind: string; property: string; values: readonly (string | number | boolean | null)[] }
  | { op: 'STRING_MATCHES'; factKind: string; property: string; pattern: string }
  | { op: 'ALL' | 'ANY'; expressions: readonly RuleExpressionV2[] }
  | { op: 'NOT'; expression: RuleExpressionV2 }
>;
export type RulePackV2 = Readonly<{
  schemaVersion: 'scanner-rule-pack-v2'; id: string; version: string; compatibleEngine: VersionRangeV2;
  requiredSafeFactRegistryDigest: string;
  rules: readonly Readonly<{ ruleId: string; revision: string; capabilityId: string; evidenceSchemaId: string; remediationId: string; when: RuleExpressionV2 }>[];
  signatures: readonly Readonly<{ keyId: string; algorithm: 'Ed25519'; signature: string }>[];
}>;
export type RulePackAdmission = Readonly<
  | { ok: true; pack: RulePackV2 }
  | { ok: false; code: 'RULE_PACK_INVALID'; errors: readonly string[] }
>;

const MAX_ITEMS = 1_000;
const MAX_DEPTH = 32;
const MAX_TEXT_BYTES = 4_096;
const ENGINE_VERSION = parseStrictSemver('2.0.0');
const REMOTE = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;
const encoder = new TextEncoder();
const ADMITTED_RULES_V2 = createAdmittedRuleView().rules;
const invalidAdmission = (): RulePackAdmission => Object.freeze({ ok: false as const, code: 'RULE_PACK_INVALID' as const, errors: Object.freeze(['RULE_PACK_INVALID']) });
const reject = (): never => { throw new TypeError('Invalid rule pack'); };

type Dict = Record<string, unknown>;
function record(input: unknown, keys: readonly string[]): Dict {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return reject();
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return reject();
  if (Object.getOwnPropertySymbols(input).length !== 0) return reject();
  const names = Object.getOwnPropertyNames(input); if (names.length > keys.length) return reject();
  if (names.length !== keys.length || keys.some((key) => !names.includes(key))) return reject();
  const output: Dict = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !('value' in descriptor)) return reject();
    output[key] = descriptor.value;
  }
  return output;
}
function dense(input: unknown): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return reject();
  const length = Object.getOwnPropertyDescriptor(input, 'length');
  if (length === undefined || !('value' in length) || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_ITEMS) return reject();
  const names = Object.getOwnPropertyNames(input);
  if (names.length > MAX_ITEMS + 1 || names.length !== length.value + 1 || Object.getOwnPropertySymbols(input).length !== 0) return reject();
  const output: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined || !('value' in descriptor)) return reject();
    output.push(descriptor.value);
  }
  return output;
}
function text(input: unknown, allowEmpty = false): string {
  if (typeof input !== 'string' || (!allowEmpty && input.length === 0) || input.length > MAX_TEXT_BYTES || input !== input.normalize('NFC') || REMOTE.test(input)) return reject();
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return reject();
    if (code >= 0xd800 && code <= 0xdbff) { const next = input.charCodeAt(index + 1); if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return reject(); index += 1; }
    else if (code >= 0xdc00 && code <= 0xdfff) return reject();
  }
  if (encoder.encode(input).length > MAX_TEXT_BYTES) return reject();
  return input;
}
function schemaFor(kind: unknown): Readonly<{ kind: string; properties: Readonly<Record<string, SafePropertyTypeV2>> }> {
  if (typeof kind !== 'string') return reject();
  const schema = SAFE_FACT_REGISTRY_V2.schemas.find((item) => item.kind === kind);
  if (schema === undefined) return reject();
  return schema;
}
function numberValue(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value); }
function scalarText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { text(value); return true; } catch { return false; }
}
function scalar(value: unknown, type: SafePropertyTypeV2): value is string | number | boolean | null {
  if (type === 'STRING' || type === 'STRING_LIST') return scalarText(value);
  if (type === 'INTEGER' || type === 'INTEGER_LIST') return numberValue(value);
  if (type === 'BOOLEAN') return typeof value === 'boolean';
  return value === null || scalarText(value);
}
function expression(root: unknown): RuleExpressionV2 {
  type Frame = { value: unknown; depth: number; exit: boolean; op?: 'ALL' | 'ANY' | 'NOT'; children?: readonly unknown[] };
  const stack: Frame[] = [{ value: root, depth: 1, exit: false }];
  const active = new WeakSet<object>();
  const outputs = new WeakMap<object, RuleExpressionV2>();
  let nodes = 0;
  while (stack.length > 0) {
    const frame = stack.pop(); if (frame === undefined) return reject();
    if (frame.exit) {
      if (frame.value === null || typeof frame.value !== 'object' || frame.op === undefined || frame.children === undefined) return reject();
      const children: RuleExpressionV2[] = [];
      for (const child of frame.children) { if (child === null || typeof child !== 'object') return reject(); const output = outputs.get(child); if (output === undefined) return reject(); children.push(output); }
      const output: RuleExpressionV2 = frame.op === 'NOT' ? Object.freeze({ op: 'NOT', expression: children[0]! }) : Object.freeze({ op: frame.op, expressions: Object.freeze(children) });
      outputs.set(frame.value, output); active.delete(frame.value); continue;
    }
    if (frame.depth > MAX_DEPTH || frame.value === null || typeof frame.value !== 'object' || active.has(frame.value)) return reject();
    active.add(frame.value); nodes += 1; if (nodes > MAX_ITEMS) return reject();
    const opDescriptor = Object.getOwnPropertyDescriptor(frame.value, 'op');
    if (opDescriptor === undefined || !('value' in opDescriptor) || typeof opDescriptor.value !== 'string') return reject();
    const op = opDescriptor.value;
    if (op === 'FACT_EXISTS') {
      const value = record(frame.value, ['op', 'kind']); schemaFor(value.kind); const output: RuleExpressionV2 = Object.freeze({ op, kind: text(value.kind) }); outputs.set(frame.value, output); active.delete(frame.value); continue;
    }
    if (op === 'PROPERTY_EQ' || op === 'PROPERTY_IN') {
      const value = record(frame.value, op === 'PROPERTY_EQ' ? ['op', 'factKind', 'property', 'value'] : ['op', 'factKind', 'property', 'values']);
      const schema = schemaFor(value.factKind); const property = text(value.property); const propertyDescriptor = Object.getOwnPropertyDescriptor(schema.properties, property); if (propertyDescriptor === undefined || !('value' in propertyDescriptor)) return reject(); const propertyType = propertyDescriptor.value;
      if (op === 'PROPERTY_EQ') { if (propertyType.endsWith('_LIST') || !scalar(value.value, propertyType)) return reject(); const normalizedValue = typeof value.value === 'number' && Object.is(value.value, -0) ? 0 : value.value; const output: RuleExpressionV2 = Object.freeze({ op, factKind: schema.kind, property, value: normalizedValue }); outputs.set(frame.value, output); active.delete(frame.value); continue; }
      const values = dense(value.values); const normalizedValues: (string | number | boolean | null)[] = []; for (const item of values) { if (!scalar(item, propertyType)) return reject(); normalizedValues.push(typeof item === 'number' && Object.is(item, -0) ? 0 : item); }
      const output: RuleExpressionV2 = Object.freeze({ op, factKind: schema.kind, property, values: Object.freeze(normalizedValues) }); outputs.set(frame.value, output); active.delete(frame.value); continue;
    }
    if (op === 'STRING_MATCHES') return reject();
    if (op !== 'ALL' && op !== 'ANY' && op !== 'NOT') return reject();
    const value = record(frame.value, op === 'NOT' ? ['op', 'expression'] : ['op', 'expressions']);
    const children = op === 'NOT' ? [value.expression] : dense(value.expressions); if (children.length === 0 || children.length > MAX_ITEMS) return reject();
    stack.push({ value: frame.value, depth: frame.depth, exit: true, op, children });
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ value: children[index], depth: frame.depth + 1, exit: false });
  }
  if (root === null || typeof root !== 'object') return reject();
  const result = outputs.get(root);
  return result === undefined ? reject() : result;
}
function compare(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1; }
/**
 * A pack body names a rule; it never defines one. An unknown rule id has no admitted identity, so
 * the declaration is refused rather than admitted with the author's claim, and a claimed
 * capability, evidence schema, or remediation that disagrees with the admitted catalogue is
 * refused rather than silently shadowing it. Severity, confidence, and scoring effect are not
 * expressible in a body at all, so they can only come from the catalogue.
 */
function ruleBody(item: Dict): RulePackV2['rules'][number] {
  const ruleId = text(item.ruleId);
  const authority = admittedRuleV2(ADMITTED_RULES_V2, ruleId);
  const capabilityId = text(item.capabilityId);
  const evidenceSchemaId = text(item.evidenceSchemaId);
  const remediationId = text(item.remediationId);
  if (authority === undefined || capabilityId !== authority.capabilityId || evidenceSchemaId !== authority.evidenceSchemaId || remediationId !== authority.remediationId) return reject();
  return Object.freeze({ ruleId, revision: text(item.revision), capabilityId, evidenceSchemaId, remediationId, when: expression(item.when) });
}
function admit(input: unknown): RulePackV2 {
  const value = record(input, ['schemaVersion', 'id', 'version', 'compatibleEngine', 'requiredSafeFactRegistryDigest', 'rules', 'signatures']);
  if (value.schemaVersion !== 'scanner-rule-pack-v2') return reject();
  const id = text(value.id); const version = text(value.version); parseStrictSemver(version);
  const compatibleEngine = validateVersionRange(value.compatibleEngine); if (!matchesVersionRange(ENGINE_VERSION, compatibleEngine)) return reject();
  if (text(value.requiredSafeFactRegistryDigest) !== SAFE_FACT_REGISTRY_V2.digest) return reject();
  const rules: RulePackV2['rules'][number][] = []; const ruleKeys = new Set<string>();
  for (const raw of dense(value.rules)) { const item = record(raw, ['ruleId', 'revision', 'capabilityId', 'evidenceSchemaId', 'remediationId', 'when']); const rule = ruleBody(item); const key = `${rule.ruleId}\u0000${rule.revision}`; if (ruleKeys.has(key)) return reject(); ruleKeys.add(key); rules.push(rule); }
  const signatures: RulePackV2['signatures'][number][] = []; const signatureKeys = new Set<string>();
  for (const raw of dense(value.signatures)) { const item = record(raw, ['keyId', 'algorithm', 'signature']); const keyId = text(item.keyId); if (item.algorithm !== 'Ed25519') return reject(); const signature = text(item.signature); if (signatureKeys.has(keyId)) return reject(); signatureKeys.add(keyId); signatures.push(Object.freeze({ keyId, algorithm: 'Ed25519', signature })); }
  rules.sort((left, right) => compare(left.ruleId, right.ruleId) || compare(left.revision, right.revision)); signatures.sort((left, right) => compare(left.keyId, right.keyId) || compare(left.signature, right.signature));
  return { schemaVersion: 'scanner-rule-pack-v2', id, version, compatibleEngine, requiredSafeFactRegistryDigest: SAFE_FACT_REGISTRY_V2.digest, rules: Object.freeze(rules), signatures: Object.freeze(signatures) };
}
function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === 'object') { if (seen.has(value)) return value; seen.add(value); for (const key of Object.getOwnPropertyNames(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (descriptor !== undefined && 'value' in descriptor) freeze(descriptor.value, seen); } Object.freeze(value); }
  return value;
}
export function validateRulePackV2(input: unknown): RulePackAdmission { try { return Object.freeze({ ok: true as const, pack: freeze(admit(input)) }); } catch { return invalidAdmission(); } }
