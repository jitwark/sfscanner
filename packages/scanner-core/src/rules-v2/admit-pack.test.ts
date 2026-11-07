import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { SAFE_FACT_REGISTRY_V2 } from '../facts/safe-fact-registry';
import { ADMITTED_PACK_RULE } from './__fixtures__/rule-pack-fixtures';
import {
  TEST_PUBLIC_KEY_A,
  TEST_PUBLIC_KEY_B,
  TEST_SEED_A,
  encodeUnpaddedBase64Url,
  keyIdFor,
  trustKey,
  trustStoreDocument,
} from './__fixtures__/trust-fixtures';
import { admitPack } from './admit-pack';
import { canonicalPackBytes } from './pack-identity';
import { validateRulePackV2, type RulePackV2 } from './pack-schema';
import { validateTrustStoreV2, type TrustKeyV2, type TrustStoreV2 } from './trust-store';

const KEY_ID_A = keyIdFor(TEST_PUBLIC_KEY_A);

/**
 * Reserved post-v2 admission vectors (WC-0703 preparation; no v2 caller reaches the helper).
 *
 * Every case below names the mutation it kills in its comment; the report
 * (`docs/audit/2026-10-17-remediation/E1b-report.md`) carries the executed probe runs. The fixtures
 * are the E1a ones: RFC 8032 §7.1 key pairs and a digest-consistent store document.
 */

function store(keys: readonly TrustKeyV2[], version = '2.0.0', floor = version): TrustStoreV2 {
  const result = validateTrustStoreV2(trustStoreDocument(version, keys, floor));
  if (!result.ok) throw new Error('fixture trust store was rejected');
  return result.store;
}

/** A digest-consistent store document handed over without validation (the loader case). */
const asStore = (document: Record<string, unknown>): TrustStoreV2 => document as unknown as TrustStoreV2;

/** A hand-made store object that never passed `validateTrustStoreV2`. */
function forgedStore(): TrustStoreV2 {
  return {
    schemaVersion: 'scanner-trust-store-v2',
    id: 'forged-store',
    version: '2.0.0',
    minimumVersion: '2.0.0',
    keys: [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')],
    digest: '0'.repeat(64),
  };
}

function packWith(signatures: RulePackV2['signatures']): RulePackV2 {
  const result = validateRulePackV2({
    schemaVersion: 'scanner-rule-pack-v2',
    id: 'fixture-pack',
    version: '2.0.0',
    compatibleEngine: { clauses: [] },
    requiredSafeFactRegistryDigest: SAFE_FACT_REGISTRY_V2.digest,
    rules: [{ ...ADMITTED_PACK_RULE, when: { op: 'FACT_EXISTS', kind: 'destination.v2' } }],
    signatures,
  });
  if (!result.ok) throw new Error('fixture pack was rejected');
  return result.pack;
}

const unsignedPack = packWith([]);

/** A pack carrying one signature over its canonical bytes (signatures are excluded from them). */
function signedPack(): RulePackV2 {
  const message = canonicalPackBytes(unsignedPack);
  return packWith([{ keyId: KEY_ID_A, algorithm: 'Ed25519', signature: encodeUnpaddedBase64Url(ed25519.sign(message, TEST_SEED_A)) }]);
}

/** Unvalidated runtime shapes, cast the way a deserialized config would be. */
const asPack = (value: Record<string, unknown>): RulePackV2 => value as unknown as RulePackV2;

describe('scanner-core reserved external pack admission', () => {
  it('refuses an unsigned pack when the development flag is absent', () => {
    // Kills: an unsigned branch taken without opt-in, or the flag test inverted.
    expect(admitPack(unsignedPack, store([]), { allowUnsignedDevelopment: false })).toEqual({
      ok: false,
      code: 'RULE_PACK_UNTRUSTED',
      reason: 'RULE_PACK_UNSIGNED',
    });
  });

  it('admits an unsigned pack as report-only under the development flag and returns the pack unchanged', () => {
    // Kills: `scoring: true` on the unsigned path, and any pack rewriting/derivation that would
    // turn an unsigned development pack into a scoring authority.
    const decision = admitPack(unsignedPack, store([]), { allowUnsignedDevelopment: true });
    expect(decision).toEqual({ ok: true, scoring: false, pack: unsignedPack });
    expect(decision.ok && decision.pack).toBe(unsignedPack);
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it('requires the literal boolean true, not a truthy value, to open the unsigned path', () => {
    // Kills: a truthiness check (`if (options.allowUnsignedDevelopment)`) in place of `=== true`.
    const truthy = { allowUnsignedDevelopment: 1 as unknown as boolean };
    const stringly = { allowUnsignedDevelopment: 'true' as unknown as boolean };
    expect(admitPack(unsignedPack, store([]), truthy).ok).toBe(false);
    expect(admitPack(unsignedPack, store([]), stringly).ok).toBe(false);
  });

  it('refuses a signed pack whose signature does not verify even with the development flag set', () => {
    // Kills: the flag becoming a fallback for failed verification — the most dangerous swap.
    const wellFormedButInvalid = packWith([
      { keyId: KEY_ID_A, algorithm: 'Ed25519', signature: encodeUnpaddedBase64Url(new Uint8Array(64)) },
    ]);
    expect(admitPack(wellFormedButInvalid, store([trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]), { allowUnsignedDevelopment: true })).toEqual({
      ok: false,
      code: 'RULE_PACK_UNTRUSTED',
      reason: 'RULE_PACK_SIGNATURE_INVALID',
    });
  });

  it('admits a signed pack that verifies under an ACTIVE key with scoring enabled', () => {
    // Kills: a signed path that never scores (unsigned-only logic) or an inversion of `scoring`.
    expect(admitPack(signedPack(), store([trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]), { allowUnsignedDevelopment: false })).toEqual({
      ok: true,
      scoring: true,
      pack: signedPack(),
    });
  });

  it('refuses a pack with a present but malformed signature instead of reading it as unsigned', () => {
    // Kills: redefining "unsigned" as "no valid signature found", which would send this pack down
    // the report-only development path.
    const malformed = packWith([{ keyId: KEY_ID_A, algorithm: 'Ed25519', signature: 'not-base64url!' }]);
    expect(admitPack(malformed, store([trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]), { allowUnsignedDevelopment: true })).toEqual({
      ok: false,
      code: 'RULE_PACK_UNTRUSTED',
      reason: 'RULE_PACK_SIGNATURE_MALFORMED',
    });
  });

  it('refuses a pack whose declared key is absent from the store rather than trusting the pack', () => {
    // Kills: pack-supplied key authority (self-authorization) and any unknown-key -> unsigned fallback.
    expect(admitPack(signedPack(), store([trustKey(TEST_PUBLIC_KEY_B, 'ACTIVE')]), { allowUnsignedDevelopment: true })).toEqual({
      ok: false,
      code: 'RULE_PACK_UNTRUSTED',
      reason: 'RULE_PACK_KEY_UNKNOWN',
    });
  });

  it('refuses malformed or missing signature containers instead of routing them into the unsigned path', () => {
    // Kills: dropping the `Array.isArray` guard (an absent list would look like zero signatures and
    // be admitted as development) and an unguarded `.length` read (a TypeError instead of a verdict).
    const empty = store([]);
    for (const signatures of [undefined, null, [null], { length: 0 }]) {
      expect(admitPack(asPack({ ...unsignedPack, signatures }), empty, { allowUnsignedDevelopment: true })).toEqual({
        ok: false,
        code: 'RULE_PACK_UNTRUSTED',
        reason: 'RULE_PACK_SIGNATURE_MALFORMED',
      });
    }
  });

  it('applies the trust-store floor unchanged, refusing even the unsigned path against a rolled-back store', () => {
    // Kills: an unsigned-development path that skips store validation (the hand-made-store bypass).
    const rolledBack = asStore(trustStoreDocument('1.9.0', [], '2.0.0'));
    expect(admitPack(unsignedPack, rolledBack, { allowUnsignedDevelopment: true })).toEqual({
      ok: false,
      code: 'RULE_PACK_INVALID',
      reason: 'TRUST_STORE_ROLLBACK',
    });
    expect(admitPack(signedPack(), rolledBack, { allowUnsignedDevelopment: false })).toEqual({
      ok: false,
      code: 'RULE_PACK_INVALID',
      reason: 'TRUST_STORE_ROLLBACK',
    });
  });

  it('refuses every admission against a store the document validator rejects', () => {
    // Kills: trusting a deserialized store object without composition of `validateTrustStoreV2`
    // (a hand-made store with a recomputed-but-wrong digest), and a store failure mapped as though
    // it were a signature failure.
    expect(admitPack(unsignedPack, forgedStore(), { allowUnsignedDevelopment: true })).toEqual({
      ok: false,
      code: 'RULE_PACK_INVALID',
      reason: 'TRUST_STORE_INVALID',
    });
  });
});
