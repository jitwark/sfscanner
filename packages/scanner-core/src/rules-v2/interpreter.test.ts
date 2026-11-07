import { describe, expect, it } from 'vitest';
import type { SafeFactV2 } from '../capabilities/scheduler';
import { SAFE_FACT_REGISTRY_V2 } from '../facts/safe-fact-registry';
import { ADMITTED_PACK_RULE } from './__fixtures__/rule-pack-fixtures';
import { compileRulePack } from './compiler';
import { evaluateCompiledRule } from './interpreter';
import { validateRulePackV2, type RuleExpressionV2, type RulePackV2 } from './pack-schema';

const packWith = (when: RuleExpressionV2): unknown => ({
  schemaVersion: 'scanner-rule-pack-v2', id: 'fixture-pack', version: '2.0.0', compatibleEngine: { clauses: [] },
  requiredSafeFactRegistryDigest: SAFE_FACT_REGISTRY_V2.digest,
  rules: [{ ...ADMITTED_PACK_RULE, when }],
  signatures: [],
});

const admittedPack = (when: RuleExpressionV2): RulePackV2 => {
  const result = validateRulePackV2(packWith(when));
  if (!result.ok) throw new Error('fixture pack was rejected');
  return result.pack;
};

const compiled = (when: RuleExpressionV2) => compileRulePack(admittedPack(when)).rules[0]!;
const workflow = { kind: 'WORKFLOW' as const };
let factNumber = 0;
const fact = (kind: string, properties: Record<string, unknown>): SafeFactV2 => ({
  factId: `fixture-fact-${factNumber++}`,
  kind,
  subject: workflow,
  properties,
} as SafeFactV2);

const destination = (properties: Record<string, unknown> = {}) => fact('destination.v2', properties);
const ingress = (properties: Record<string, unknown> = {}) => fact('ingress.v2', properties);

describe('evaluateCompiledRule', () => {
  it('evaluates a missing fact as UNKNOWN and charges the leaf', () => {
    const result = evaluateCompiledRule(compiled({ op: 'FACT_EXISTS', kind: 'destination.v2' }), [], 1_000);
    expect(result).toEqual({ value: 'UNKNOWN', operations: 1, exhausted: false });
  });

  it('evaluates FACT_EXISTS for present and absent registered kinds', () => {
    expect(evaluateCompiledRule(compiled({ op: 'FACT_EXISTS', kind: 'destination.v2' }), [destination()], 1_000).value).toBe('TRUE');
    expect(evaluateCompiledRule(compiled({ op: 'FACT_EXISTS', kind: 'ingress.v2' }), [destination()], 1_000).value).toBe('UNKNOWN');
  });

  it('evaluates PROPERTY_EQ with exact values and UNKNOWN for missing properties', () => {
    const rule = compiled({ op: 'PROPERTY_EQ', factKind: 'destination.v2', property: 'hostname', value: 'example.com' });
    expect(evaluateCompiledRule(rule, [destination({ hostname: 'example.com' })], 1_000).value).toBe('TRUE');
    expect(evaluateCompiledRule(rule, [destination({ hostname: 'other.example' })], 1_000).value).toBe('FALSE');
    expect(evaluateCompiledRule(rule, [destination()], 1_000).value).toBe('UNKNOWN');
    expect(evaluateCompiledRule(rule, [ingress()], 1_000).value).toBe('UNKNOWN');
  });

  it('evaluates PROPERTY_IN without coercion', () => {
    const rule = compiled({ op: 'PROPERTY_IN', factKind: 'destination.v2', property: 'parameterPath', values: ['/url', '/body'] });
    expect(evaluateCompiledRule(rule, [destination({ parameterPath: '/url' })], 1_000).value).toBe('TRUE');
    expect(evaluateCompiledRule(rule, [destination({ parameterPath: '/query' })], 1_000).value).toBe('FALSE');
    expect(evaluateCompiledRule(rule, [destination()], 1_000).value).toBe('UNKNOWN');
    expect(evaluateCompiledRule(rule, [destination({ parameterPath: 1 })], 1_000).value).toBe('UNKNOWN');
  });

  it('uses exact registered property types rather than coercing values', () => {
    const stringRule = compiled({ op: 'PROPERTY_EQ', factKind: 'destination.v2', property: 'hostname', value: '1' });
    const booleanRule = compiled({ op: 'PROPERTY_EQ', factKind: 'node.configuration.v2', property: 'literalValue', value: true });
    expect(evaluateCompiledRule(stringRule, [destination({ hostname: 1 })], 1_000).value).toBe('UNKNOWN');
    expect(evaluateCompiledRule(booleanRule, [fact('node.configuration.v2', { literalValue: 'true' })], 1_000).value).toBe('UNKNOWN');
  });

  it('applies strong-Kleene semantics to nested groups and NOT', () => {
    const missing = { op: 'FACT_EXISTS', kind: 'destination.v2' } as const;
    const present = { op: 'FACT_EXISTS', kind: 'ingress.v2' } as const;
    const different = { op: 'PROPERTY_EQ', factKind: 'destination.v2', property: 'hostname', value: 'example.com' } as const;
    expect(evaluateCompiledRule(compiled({ op: 'ALL', expressions: [missing, present] }), [ingress()], 1_000)).toEqual({ value: 'UNKNOWN', operations: 3, exhausted: false });
    expect(evaluateCompiledRule(compiled({ op: 'ALL', expressions: [different, missing] }), [destination({ hostname: 'other.example' })], 1_000)).toEqual({ value: 'FALSE', operations: 2, exhausted: false });
    expect(evaluateCompiledRule(compiled({ op: 'ANY', expressions: [present, missing] }), [ingress()], 1_000)).toEqual({ value: 'TRUE', operations: 2, exhausted: false });
    expect(evaluateCompiledRule(compiled({ op: 'NOT', expression: missing }), [], 1_000)).toEqual({ value: 'UNKNOWN', operations: 2, exhausted: false });
  });

  it('charges group nodes and returns UNKNOWN on every exhaustion boundary', () => {
    const rule = compiled({ op: 'ALL', expressions: [
      { op: 'FACT_EXISTS', kind: 'destination.v2' },
      { op: 'FACT_EXISTS', kind: 'ingress.v2' },
    ] });
    expect(evaluateCompiledRule(rule, [destination(), ingress()], 0)).toEqual({ value: 'UNKNOWN', operations: 0, exhausted: true });
    expect(evaluateCompiledRule(rule, [destination(), ingress()], 1)).toEqual({ value: 'UNKNOWN', operations: 1, exhausted: true });
    expect(evaluateCompiledRule(rule, [destination(), ingress()], 2)).toEqual({ value: 'UNKNOWN', operations: 2, exhausted: true });
    expect(evaluateCompiledRule(rule, [destination(), ingress()], 3)).toEqual({ value: 'TRUE', operations: 3, exhausted: false });
  });

  it('does not depend on fact order', () => {
    const rule = compiled({ op: 'PROPERTY_EQ', factKind: 'destination.v2', property: 'hostname', value: 'example.com' });
    const facts = [destination({ hostname: 'other.example' }), destination({ hostname: 'example.com' })];
    expect(evaluateCompiledRule(rule, facts, 1_000).value).toBe('TRUE');
    expect(evaluateCompiledRule(rule, [...facts].reverse(), 1_000).value).toBe('TRUE');
  });

  it('rejects a rule with a foreign prototype', () => {
    const rule = Object.create({ inherited: true });
    rule.instructions = compiled({ op: 'FACT_EXISTS', kind: 'destination.v2' }).instructions;

    expect(evaluateCompiledRule(rule, [destination()], 1_000)).toEqual({ value: 'UNKNOWN', operations: 0, exhausted: false });
  });

  it('rejects a rule with extra own properties', () => {
    const rule = { ...compiled({ op: 'FACT_EXISTS', kind: 'destination.v2' }), extra: true };

    expect(evaluateCompiledRule(rule, [destination()], 1_000)).toEqual({ value: 'UNKNOWN', operations: 0, exhausted: false });
  });

  it('returns static UNKNOWN for cyclic instructions and malformed fact arrays', () => {
    const cyclic: Record<string, unknown> = { op: 'NOT' };
    cyclic.child = cyclic;
    const rule = { instructions: [cyclic] } as never;
    expect(evaluateCompiledRule(rule, [], 1_000)).toEqual({ value: 'UNKNOWN', operations: 0, exhausted: false });

    const sparse = [] as SafeFactV2[];
    sparse.length = 1;
    expect(evaluateCompiledRule(compiled({ op: 'FACT_EXISTS', kind: 'destination.v2' }), sparse, 1_000)).toEqual({ value: 'UNKNOWN', operations: 0, exhausted: false });

    const accessor = destination({ hostname: 'example.com' }) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, 'kind', { get: () => { throw new Error('secret'); } });
    expect(evaluateCompiledRule(compiled({ op: 'FACT_EXISTS', kind: 'destination.v2' }), [accessor as SafeFactV2], 1_000)).toEqual({ value: 'UNKNOWN', operations: 0, exhausted: false });

    const proxied = new Proxy([destination()], { getOwnPropertyDescriptor: () => { throw new Error('secret'); } });
    expect(evaluateCompiledRule(compiled({ op: 'FACT_EXISTS', kind: 'destination.v2' }), proxied, 1_000)).toEqual({ value: 'UNKNOWN', operations: 0, exhausted: false });
  });

  it('returns UNKNOWN for malformed instruction accessors without evaluating them', () => {
    const instruction = {} as Record<string, unknown>;
    Object.defineProperty(instruction, 'op', { get: () => { throw new Error('secret'); } });
    expect(evaluateCompiledRule({ instructions: [instruction] } as never, [], 1_000)).toEqual({ value: 'UNKNOWN', operations: 0, exhausted: false });
  });

  it('freezes every evaluation result', () => {
    const result = evaluateCompiledRule(compiled({ op: 'FACT_EXISTS', kind: 'destination.v2' }), [destination()], 1_000);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
