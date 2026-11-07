import { describe, expect, it } from 'vitest';
import { SAFE_FACT_REGISTRY_V2 } from '../facts/safe-fact-registry';
import {
  ADMITTED_PACK_RULE, FOREIGN_EVIDENCE_PACK_RULE, FOREIGN_OWNER_PACK_RULE, FOREIGN_REMEDIATION_PACK_RULE, UNKNOWN_PACK_RULE,
} from './__fixtures__/rule-pack-fixtures';
import { validateRulePackV2, type RuleExpressionV2 } from './pack-schema';

const validWhen: RuleExpressionV2 = { op: 'FACT_EXISTS', kind: 'destination.v2' };
const packWith = (when: unknown): unknown => packWithRule({ ...ADMITTED_PACK_RULE, when });
const packWithRule = (rule: Record<string, unknown>): unknown => ({
  schemaVersion: 'scanner-rule-pack-v2',
  id: 'fixture-pack', version: '2.0.0', compatibleEngine: { clauses: [] },
  requiredSafeFactRegistryDigest: SAFE_FACT_REGISTRY_V2.digest,
  rules: [{ when: validWhen, ...rule }],
  signatures: [],
});

const accepted = (input: unknown) => {
  const result = validateRulePackV2(input);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error('fixture pack was rejected');
  return result.pack;
};

function nestedNot(depth: number): unknown {
  let expression: unknown = { op: 'FACT_EXISTS', kind: 'destination.v2' };
  for (let index = 0; index < depth; index += 1) expression = { op: 'NOT', expression };
  return expression;
}

function expressionNodes(count: number): unknown {
  if (count === 1) return { op: 'FACT_EXISTS', kind: 'destination.v2' };
  return { op: 'ALL', expressions: [expressionNodes(count - 1), { op: 'FACT_EXISTS', kind: 'destination.v2' }] };
}

describe('validateRulePackV2', () => {
  it('admits a closed pack and returns an immutable canonical copy', () => {
    const input = packWith(validWhen) as Record<string, unknown>;
    const pack = accepted(input);
    expect(pack).not.toBe(input);
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack.rules)).toBe(true);
    expect(Object.isFrozen(pack.rules[0])).toBe(true);
    expect(pack.rules[0]?.when).toEqual(validWhen);
    expect(() => { (pack.rules[0] as { ruleId: string }).ruleId = 'MUTATED'; }).toThrow();
  });

  it.each([
    ['trailing high surrogate', 'fixture\uD800'],
    ['isolated low surrogate', '\uDC00'],
    ['high surrogate followed by non-low surrogate', '\uD800A'],
    ['consecutive high surrogates', '\uD800\uD800'],
  ])('rejects %s in text fields', (_description, malformed) => {
    const base = packWith(validWhen) as Record<string, unknown>;
    expect(validateRulePackV2({ ...base, id: malformed })).toMatchObject({ ok: false, code: 'RULE_PACK_INVALID' });
  });

  it.each([
    { op: 'STRING_MATCHES', factKind: 'destination.v2', property: 'hostname', pattern: '.*' },
    { op: 'FACT_EXISTS', kind: 'unknown.fact' },
    { op: 'PROPERTY_EQ', factKind: 'destination.v2', property: '__proto__', value: 'x' },
  ])('rejects reserved or unregistered expression %j', (when) => {
    expect(validateRulePackV2(packWith(when))).toEqual(expect.objectContaining({ ok: false, code: 'RULE_PACK_INVALID' }));
  });

  it('admits only exact registered scalar property selectors and values', () => {
    expect(accepted(packWith({ op: 'PROPERTY_EQ', factKind: 'destination.v2', property: 'hostname', value: null })).rules[0]?.when).toEqual({
      op: 'PROPERTY_EQ', factKind: 'destination.v2', property: 'hostname', value: null,
    });
    expect(validateRulePackV2(packWith({ op: 'PROPERTY_EQ', factKind: 'destination.v2', property: 'hostname', value: 1 }))).toMatchObject({ ok: false });
    expect(validateRulePackV2(packWith({ op: 'PROPERTY_IN', factKind: 'destination.v2', property: 'parameterPath', values: ['/url', '/body'] }))).toMatchObject({ ok: true });
    expect(validateRulePackV2(packWith({ op: 'PROPERTY_EQ', factKind: 'destination.v2', property: 'parameterPath[*]', value: '/url' }))).toMatchObject({ ok: false });
  });

  it('rejects unknown keys, unsafe values, and remote references without echoing input', () => {
    const secret = 'https://secret.example/should-not-escape';
    const input = packWith({ op: 'FACT_EXISTS', kind: 'destination.v2', extra: secret });
    const result = validateRulePackV2(input);
    expect(result).toMatchObject({ ok: false, code: 'RULE_PACK_INVALID' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(validateRulePackV2(packWith({ op: 'PROPERTY_EQ', factKind: 'destination.v2', property: 'hostname', value: secret }))).toMatchObject({ ok: false });
    expect(validateRulePackV2({ ...(packWith(validWhen) as object), extra: true })).toMatchObject({ ok: false });
  });

  it('rejects duplicate rule revisions and signatures', () => {
    const base = packWith(validWhen) as Record<string, unknown>;
    const duplicateRules = { ...base, rules: [...(base.rules as unknown[]), ...(base.rules as unknown[])] };
    const signature = { keyId: 'key-1', algorithm: 'Ed25519', signature: 'sig' };
    const duplicateSignatures = { ...base, signatures: [signature, signature] };
    expect(validateRulePackV2(duplicateRules)).toMatchObject({ ok: false });
    expect(validateRulePackV2(duplicateSignatures)).toMatchObject({ ok: false });
  });

  it('rejects invalid or incompatible versions and registry digests', () => {
    const base = packWith(validWhen) as Record<string, unknown>;
    expect(validateRulePackV2({ ...base, version: '2' })).toMatchObject({ ok: false });
    expect(validateRulePackV2({ ...base, compatibleEngine: { clauses: [[{ op: 'EQ', version: '1.0.0' }]] } })).toMatchObject({ ok: false });
    expect(validateRulePackV2({ ...base, requiredSafeFactRegistryDigest: '0'.repeat(64) })).toMatchObject({ ok: false });
    expect(validateRulePackV2({ ...base, requiredSafeFactRegistryDigest: 'https://registry.invalid' })).toMatchObject({ ok: false });
  });

  it('rejects empty groups, excessive nesting, and excessive expression nodes', () => {
    expect(validateRulePackV2(packWith({ op: 'ALL', expressions: [] }))).toMatchObject({ ok: false });
    expect(validateRulePackV2(packWith(nestedNot(31)))).toMatchObject({ ok: true });
    expect(validateRulePackV2(packWith(nestedNot(32)))).toMatchObject({ ok: false });
    expect(validateRulePackV2(packWith(expressionNodes(1001)))).toMatchObject({ ok: false });
  });

  it('rejects cycles, accessors, symbols, and sparse arrays', () => {
    const cyclic = { op: 'NOT', expression: null as unknown };
    cyclic.expression = cyclic;
    expect(validateRulePackV2(packWith(cyclic))).toMatchObject({ ok: false });

    const accessor = { op: 'FACT_EXISTS', kind: 'destination.v2' } as Record<string, unknown>;
    Object.defineProperty(accessor, 'kind', { enumerable: true, get: () => 'destination.v2' });
    expect(validateRulePackV2(packWith(accessor))).toMatchObject({ ok: false });

    const symbol = { op: 'FACT_EXISTS', kind: 'destination.v2', [Symbol('secret')]: true };
    expect(validateRulePackV2(packWith(symbol))).toMatchObject({ ok: false });

    const sparse = { op: 'ALL', expressions: new Array(1) };
    expect(validateRulePackV2(packWith(sparse))).toMatchObject({ ok: false });
  });

  it('rejects a rule id the admitted catalogue does not carry', () => {
    const pack = packWithRule(UNKNOWN_PACK_RULE) as Record<string, unknown>;
    expect(validateRulePackV2(pack)).toEqual(expect.objectContaining({ ok: false, code: 'RULE_PACK_INVALID' }));
    // The admitted identity is the only one that admits, so the refusal is about the rule, not the shape.
    expect(validateRulePackV2(packWithRule(ADMITTED_PACK_RULE))).toMatchObject({ ok: true });
  });

  it.each([
    ['reassigns the owner', FOREIGN_OWNER_PACK_RULE],
    ['rewrites the evidence schema', FOREIGN_EVIDENCE_PACK_RULE],
    ['points remediation elsewhere', FOREIGN_REMEDIATION_PACK_RULE],
  ])('rejects a rule body that %s of an admitted rule', (_description, body) => {
    expect(validateRulePackV2(packWithRule(body))).toEqual(expect.objectContaining({ ok: false, code: 'RULE_PACK_INVALID' }));
  });
});
