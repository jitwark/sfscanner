import { describe, expect, it } from 'vitest';
import { SAFE_FACT_REGISTRY_V2 } from '../facts/safe-fact-registry';
import { ADMITTED_PACK_RULE } from './__fixtures__/rule-pack-fixtures';
import { compileRulePack, type InstructionV2 } from './compiler';
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

const compile = (when: RuleExpressionV2) => compileRulePack(admittedPack(when));

function nestedNot(depth: number): RuleExpressionV2 {
  let expression: RuleExpressionV2 = { op: 'FACT_EXISTS', kind: 'destination.v2' };
  for (let index = 0; index < depth; index += 1) expression = { op: 'NOT', expression };
  return expression;
}

function expressionNodes(count: number): RuleExpressionV2 {
  if (count === 1) return { op: 'FACT_EXISTS', kind: 'destination.v2' };
  return { op: 'ALL', expressions: [expressionNodes(count - 1), { op: 'FACT_EXISTS', kind: 'destination.v2' }] };
}

describe('compileRulePack', () => {
  it('compiles exact selectors into immutable instruction nodes', () => {
    const compiled = compile({ op: 'PROPERTY_EQ', factKind: 'destination.v2', property: 'hostname', value: 'example.com' });
    expect(compiled.rules).toEqual([{
      ruleId: ADMITTED_PACK_RULE.ruleId,
      instructions: [{ op: 'PROPERTY_EQ', factKind: 'destination.v2', property: 'hostname', value: 'example.com' }],
    }]);
    expect(compiled.packDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.rules)).toBe(true);
    expect(Object.isFrozen(compiled.rules[0])).toBe(true);
    expect(Object.isFrozen(compiled.rules[0]!.instructions)).toBe(true);
    expect(Object.isFrozen(compiled.rules[0]!.instructions[0])).toBe(true);
  });

  it('preserves canonical rule and child order', () => {
    const first = compile({ op: 'ALL', expressions: [
      { op: 'FACT_EXISTS', kind: 'destination.v2' },
      { op: 'NOT', expression: { op: 'FACT_EXISTS', kind: 'ingress.v2' } },
    ] });
    expect(first.rules[0]!.instructions[0]).toEqual({
      op: 'ALL', children: [
        { op: 'FACT_EXISTS', kind: 'destination.v2' },
        { op: 'NOT', child: { op: 'FACT_EXISTS', kind: 'ingress.v2' } },
      ],
    });
  });

  const rejectionCases: ReadonlyArray<readonly [string, RuleExpressionV2]> = [
    ['empty group', { op: 'ALL', expressions: [] }],
    ['over-depth group', nestedNot(32)],
    ['over-item group', expressionNodes(1_001)],
  ];
  it.each(rejectionCases)('rejects %s rather than compiling an unbounded graph', (_label, when) => {
    expect(() => compileRulePack(packWith(when) as RulePackV2)).toThrowError(TypeError);
  });

  it('rejects cyclic and duplicate rule input without exposing raw values', () => {
    const cyclic: Record<string, unknown> = { op: 'NOT' };
    cyclic.expression = cyclic;
    const pack = packWith(cyclic as unknown as RuleExpressionV2) as Record<string, unknown>;
    expect(() => compileRulePack(pack as RulePackV2)).toThrow('Invalid admitted rule pack');

    const base = packWith({ op: 'FACT_EXISTS', kind: 'destination.v2' }) as Record<string, unknown>;
    const rules = base.rules as Array<Record<string, unknown>>;
    const duplicate = { ...base, rules: [rules[0], { ...rules[0] }] } as unknown as RulePackV2;
    expect(() => compileRulePack(duplicate)).toThrow('Invalid admitted rule pack');
  });

  it('does not compile the reserved regex expression', () => {
    const regex = { op: 'STRING_MATCHES', factKind: 'destination.v2', property: 'hostname', pattern: '.*' } as unknown as RulePackV2;
    const pack = packWith(regex as unknown as RuleExpressionV2) as Record<string, unknown>;
    expect(() => compileRulePack(pack as RulePackV2)).toThrow(TypeError);
  });

  it('does not retain mutable caller instruction arrays', () => {
    const expression = { op: 'ALL', expressions: [
      { op: 'FACT_EXISTS', kind: 'destination.v2' },
      { op: 'FACT_EXISTS', kind: 'ingress.v2' },
    ] } as const;
    const pack = admittedPack(expression);
    const compiled = compileRulePack(pack);
    expect(compiled.rules[0]!.instructions).not.toBe((pack.rules[0]!.when as Extract<RuleExpressionV2, { op: 'ALL' | 'ANY' }>).expressions);
  });

  it('exports the instruction shape for interpreter callers', () => {
    const instruction: InstructionV2 = { op: 'FACT_EXISTS', kind: 'destination.v2' };
    expect(instruction.op).toBe('FACT_EXISTS');
  });
});
