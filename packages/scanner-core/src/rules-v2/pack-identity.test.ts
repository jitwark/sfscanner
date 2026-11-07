import { describe, expect, it } from 'vitest';
import { SAFE_FACT_REGISTRY_V2 } from '../facts/safe-fact-registry';
import { ADMITTED_PACK_RULE } from './__fixtures__/rule-pack-fixtures';
import { validateRulePackV2, type RuleExpressionV2, type RulePackV2 } from './pack-schema';
import { canonicalPackBytes, createPackDigest } from './pack-identity';

const admittedPack = (when: RuleExpressionV2): RulePackV2 => {
  const result = validateRulePackV2({
    schemaVersion: 'scanner-rule-pack-v2', id: 'fixture-pack', version: '2.0.0',
    compatibleEngine: { clauses: [] },
    requiredSafeFactRegistryDigest: SAFE_FACT_REGISTRY_V2.digest,
    rules: [{ ...ADMITTED_PACK_RULE, when }],
    signatures: [],
  });
  if (!result.ok) throw new Error('fixture pack was rejected');
  return result.pack;
};
type MutableRulePackV2 = Omit<RulePackV2, 'signatures'> & { signatures: RulePackV2['signatures'] };

describe('scanner-core canonical rule pack identity', () => {
  it('excludes signatures from canonical pack identity', () => {
    const unsigned = admittedPack({ op: 'FACT_EXISTS', kind: 'destination.v2' });
    const signed = { ...unsigned, signatures: [{ keyId: 'KEY-1', algorithm: 'Ed25519' as const, signature: 'sig' }] } as RulePackV2;
    expect(createPackDigest(unsigned)).toBe(createPackDigest(signed));
    expect(canonicalPackBytes(unsigned)).toEqual(canonicalPackBytes(signed));
  });

  it('is stable under canonical object reconstruction', () => {
    const pack = admittedPack({ op: 'FACT_EXISTS', kind: 'destination.v2' });
    const reconstructed = JSON.parse(JSON.stringify(pack)) as RulePackV2;
    expect(createPackDigest(reconstructed)).toBe(createPackDigest(pack));
    expect(createPackDigest(pack)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('does not let signature mutation alter previously constructed bytes', () => {
    const pack = { ...admittedPack({ op: 'FACT_EXISTS', kind: 'destination.v2' }) } as MutableRulePackV2;
    const bytes = canonicalPackBytes(pack);
    const digest = createPackDigest(pack);
    pack.signatures = [{ keyId: 'KEY-1', algorithm: 'Ed25519', signature: 'sig' }];

    expect(bytes).toEqual(canonicalPackBytes(pack));
    expect(digest).toBe(createPackDigest(pack));
    expect(bytes).not.toBe(canonicalPackBytes(pack));
  });

  it('ignores source key insertion order when constructing canonical bytes', () => {
    const pack = admittedPack({ op: 'FACT_EXISTS', kind: 'destination.v2' });
    const reordered = {
      signatures: pack.signatures,
      rules: pack.rules,
      requiredSafeFactRegistryDigest: pack.requiredSafeFactRegistryDigest,
      compatibleEngine: pack.compatibleEngine,
      version: pack.version,
      id: pack.id,
      schemaVersion: pack.schemaVersion,
    } as RulePackV2;

    expect(canonicalPackBytes(reordered)).toEqual(canonicalPackBytes(pack));
  });
});
