import { canonicalizeJson } from '../canonical-json';
import { createAdmittedRuleView } from '../v2/admitted-registry';
import { admittedRuleV2 } from '../rules-v2/rule-authority';
import type { AdmittedRuleV2 } from '../capabilities/scheduler';

/**
 * The result boundary resolves every finding's rule against the admitted catalogue.
 *
 * A caller may repeat an admitted rule entry, but it may not introduce one, drop a field, or
 * restate a value: what it supplies is checked against the catalogue instead of trusted, so a
 * downgraded severity, a flipped scoring effect, or a rewritten remediation cannot win silently.
 * A finding whose rule id is not admitted is refused outright — never published, never scored.
 */
const RULE_KEYS = ['ruleId', 'revision', 'capabilityId', 'effect', 'severity', 'confidence', 'evidenceSchemaId', 'remediationId', 'cweIds', 'owaspAgenticIds', 'packDigest'] as const;
const RULE_MAP_KEYS = ['size', 'get', 'has', 'entries', 'keys', 'values', 'forEach', 'set', 'delete', 'clear'] as const;
const unsafeMap = (): never => { throw new TypeError('Unsafe rules map'); };
const plain = (value: unknown): value is object => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const data = (value: object, key: string): unknown => { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !('value' in descriptor)) return unsafeMap(); return descriptor.value; };

/** A closed admitted-rule entry, or a refusal. Unknown properties and accessors never survive. */
function admittedEntry(raw: unknown): AdmittedRuleV2 {
  if (!plain(raw)) return unsafeMap();
  const names = Object.getOwnPropertyNames(raw);
  if (Object.getOwnPropertySymbols(raw).length !== 0 || names.length !== RULE_KEYS.length || names.some((name) => !(RULE_KEYS as readonly string[]).includes(name))) return unsafeMap();
  const value: Record<string, unknown> = {};
  for (const key of RULE_KEYS) value[key] = data(raw, key);
  return value as unknown as AdmittedRuleV2;
}

/** The entries of a supplied view: a real `Map`, or the scheduler's frozen immutable view. */
function suppliedEntries(rules: object): readonly (readonly [unknown, unknown])[] {
  if (rules instanceof Map && Object.getPrototypeOf(rules) === Map.prototype) {
    if (Object.getOwnPropertyNames(rules).length !== 0 || Object.getOwnPropertySymbols(rules).length !== 0) return unsafeMap();
    return [...(Map.prototype.entries.call(rules) as Iterable<readonly [unknown, unknown]>)];
  }
  if (Object.getPrototypeOf(rules) !== null || !Object.isFrozen(rules)) return unsafeMap();
  const names = Object.getOwnPropertyNames(rules); const symbols = Object.getOwnPropertySymbols(rules);
  if (names.length !== RULE_MAP_KEYS.length || names.some((name) => !(RULE_MAP_KEYS as readonly string[]).includes(name)) || symbols.length !== 1 || symbols[0] !== Symbol.iterator) return unsafeMap();
  for (const name of RULE_MAP_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(rules, name);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable || descriptor.writable || descriptor.configurable || name !== 'size' && typeof descriptor.value !== 'function') return unsafeMap();
  }
  const entries = data(rules, 'entries') as () => Iterable<readonly [unknown, unknown]>;
  try { return [...entries.call(rules)]; } catch { return unsafeMap(); }
}

export function admittedFindingRulesV2(supplied: unknown): ReadonlyMap<string, AdmittedRuleV2> {
  const admitted = createAdmittedRuleView().rules;
  if (supplied === undefined) return admitted;
  if (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied)) return unsafeMap();
  const candidates = suppliedEntries(supplied);
  for (const [key, raw] of candidates) {
    if (typeof key !== 'string') return unsafeMap();
    const entry = admittedEntry(raw);
    const authority = admittedRuleV2(admitted, key);
    if (authority === undefined || entry.ruleId !== key || canonicalizeJson(entry) !== canonicalizeJson(authority)) throw new TypeError('Supplied ruleset disagrees with the admitted catalogue');
  }
  return admitted;
}

export function findingRuleV2(rules: ReadonlyMap<string, AdmittedRuleV2>, ruleId: unknown): AdmittedRuleV2 {
  if (typeof ruleId !== 'string') throw new TypeError('Invalid rule ID');
  const rule = admittedRuleV2(rules, ruleId);
  if (rule === undefined) throw new TypeError('Finding rule is not admitted');
  return rule;
}
