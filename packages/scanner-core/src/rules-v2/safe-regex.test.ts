import { describe, expect, it } from 'vitest';
import { SAFE_FACT_REGISTRY_V2 } from '../facts/safe-fact-registry';
import { ADMITTED_PACK_RULE } from './__fixtures__/rule-pack-fixtures';
import { validateRulePackV2 } from './pack-schema';
import { evaluateRegexExperiment, validateReservedRegexPattern } from './safe-regex';

const reservedPattern = {
  op: 'STRING_MATCHES', factKind: 'destination.v2', property: 'hostname', pattern: 'example',
};

const packWith = (when: unknown): unknown => ({
  schemaVersion: 'scanner-rule-pack-v2',
  id: 'fixture-pack', version: '2.0.0', compatibleEngine: { clauses: [] },
  requiredSafeFactRegistryDigest: SAFE_FACT_REGISTRY_V2.digest,
  rules: [{ ...ADMITTED_PACK_RULE, when }],
  signatures: [],
});

describe('safe regex reservation', () => {
  it('rejects every STRING_MATCHES pattern through the v2 pack admission boundary', () => {
    expect(validateRulePackV2(packWith(reservedPattern))).toEqual(expect.objectContaining({
      ok: false, code: 'RULE_PACK_INVALID',
    }));
  });

  it('does not enable a native regex fallback', () => {
    expect(validateReservedRegexPattern('^example$')).toBe(false);
    expect(evaluateRegexExperiment()).toBe('NO_GO');
  });
});
