import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { SAFE_FACT_REGISTRY_V2 } from '../facts/safe-fact-registry';
import { ADMITTED_PACK_RULE } from './__fixtures__/rule-pack-fixtures';
import {
  TEST_PUBLIC_KEY_A,
  TEST_PUBLIC_KEY_B,
  TEST_SEED_A,
  TEST_SEED_B,
  encodeUnpaddedBase64Url,
  keyIdFor,
  trustKey,
  trustStoreDocument,
} from './__fixtures__/trust-fixtures';
import { canonicalPackBytes, createPackDigest } from './pack-identity';
import { validateRulePackV2, type RulePackV2 } from './pack-schema';
import { validateTrustStoreV2, type TrustKeyV2, type TrustStoreV2 } from './trust-store';
import { verifyRulePack } from './verify-pack';

const KEY_ID_A = keyIdFor(TEST_PUBLIC_KEY_A);
const KEY_ID_B = keyIdFor(TEST_PUBLIC_KEY_B);

function admittedStore(keys: readonly TrustKeyV2[]): TrustStoreV2 {
  const result = validateTrustStoreV2(trustStoreDocument('2.0.0', keys));
  if (!result.ok) throw new Error('fixture trust store was rejected');
  return result.store;
}

/** A hand-made store object that never passed `validateTrustStoreV2` (the caller-supplied-trust case). */
function forgedStore(keys: readonly TrustKeyV2[]): TrustStoreV2 {
  return { schemaVersion: 'scanner-trust-store-v2', id: 'forged-store', version: '2.0.0', minimumVersion: '2.0.0', keys, digest: '0'.repeat(64) };
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

/** A pack carrying one signature over its canonical bytes (signatures are excluded from them). */
function signedPack(seed: Uint8Array, keyId: string): RulePackV2 {
  const message = canonicalPackBytes(packWith([]));
  return packWith([{ keyId, algorithm: 'Ed25519', signature: encodeUnpaddedBase64Url(ed25519.sign(message, seed)) }]);
}

describe('scanner-core reserved external pack verification', () => {
  it('uses the published RFC 8032 §7.1 key pairs as fixtures', () => {
    expect(bytesToHex(ed25519.getPublicKey(TEST_SEED_A))).toBe(TEST_PUBLIC_KEY_A);
    expect(bytesToHex(ed25519.getPublicKey(TEST_SEED_B))).toBe(TEST_PUBLIC_KEY_B);
  });

  it('admits a pack whose signature verifies over the canonical pack bytes', () => {
    const store = admittedStore([trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    expect(verifyRulePack(signedPack(TEST_SEED_A, KEY_ID_A), store)).toEqual({ ok: true, keyId: KEY_ID_A });
  });

  it('admits when at least one presented signature verifies under an ACTIVE key', () => {
    const store = admittedStore([trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    const signatures = [...signedPack(TEST_SEED_B, KEY_ID_B).signatures, ...signedPack(TEST_SEED_A, KEY_ID_A).signatures];
    expect(verifyRulePack(packWith(signatures), store)).toEqual({ ok: true, keyId: KEY_ID_A });
  });

  it('rejects a one-byte tamper of the signature value', () => {
    const store = admittedStore([trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    const signature = signedPack(TEST_SEED_A, KEY_ID_A).signatures[0]!.signature;
    const flipped = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    expect(verifyRulePack(packWith([{ keyId: KEY_ID_A, algorithm: 'Ed25519', signature: flipped }]), store)).toEqual({
      ok: false,
      code: 'RULE_PACK_SIGNATURE_INVALID',
    });
  });

  it('rejects a one-byte tamper of the pack body the signature covers', () => {
    const store = admittedStore([trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    const tampered: RulePackV2 = { ...signedPack(TEST_SEED_A, KEY_ID_A), id: 'fixture-pack-tampered' };
    expect(verifyRulePack(tampered, store)).toEqual({ ok: false, code: 'RULE_PACK_SIGNATURE_INVALID' });
  });

  it('rejects a signature computed over the pack digest instead of the canonical bytes', () => {
    const store = admittedStore([trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    const digest = hexToBytes(createPackDigest(packWith([])));
    const signature = encodeUnpaddedBase64Url(ed25519.sign(digest, TEST_SEED_A));
    expect(verifyRulePack(packWith([{ keyId: KEY_ID_A, algorithm: 'Ed25519', signature }]), store)).toEqual({
      ok: false,
      code: 'RULE_PACK_SIGNATURE_INVALID',
    });
  });

  it('rejects an unsigned pack before any trust-store authority is consulted', () => {
    const store = admittedStore([trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    expect(verifyRulePack(packWith([]), store)).toEqual({ ok: false, code: 'RULE_PACK_UNSIGNED' });
  });

  it('rejects a pack whose declared key is absent from the store, because a pack cannot declare its own authority', () => {
    const store = admittedStore([trustKey(TEST_PUBLIC_KEY_B, 'ACTIVE')]);
    expect(verifyRulePack(signedPack(TEST_SEED_A, KEY_ID_A), store)).toEqual({ ok: false, code: 'RULE_PACK_KEY_UNKNOWN' });
  });

  it('rejects revoked-only signatures', () => {
    const store = admittedStore([trustKey(TEST_PUBLIC_KEY_A, 'REVOKED')]);
    expect(verifyRulePack(signedPack(TEST_SEED_A, KEY_ID_A), store)).toEqual({ ok: false, code: 'RULE_PACK_KEY_REVOKED' });
  });

  it('rejects malformed or wrong-length signature encodings', () => {
    const store = admittedStore([trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    const valid = signedPack(TEST_SEED_A, KEY_ID_A).signatures[0]!.signature;
    const malformed = [`${valid}=`, valid.slice(0, 85), `${valid.slice(0, 85)}+`];
    for (const signature of malformed) {
      expect(verifyRulePack(packWith([{ keyId: KEY_ID_A, algorithm: 'Ed25519', signature }]), store)).toEqual({
        ok: false,
        code: 'RULE_PACK_SIGNATURE_MALFORMED',
      });
    }
  });

  it('rejects a well-formed signature that does not verify under its ACTIVE key', () => {
    const store = admittedStore([trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    const signature = encodeUnpaddedBase64Url(new Uint8Array(64));
    expect(verifyRulePack(packWith([{ keyId: KEY_ID_A, algorithm: 'Ed25519', signature }]), store)).toEqual({
      ok: false,
      code: 'RULE_PACK_SIGNATURE_INVALID',
    });
  });

  it('fails closed without throwing when the stored public key is not a curve point', () => {
    const store = admittedStore([trustKey('ff'.repeat(32), 'ACTIVE')]);
    const signature = encodeUnpaddedBase64Url(ed25519.sign(new Uint8Array([1]), TEST_SEED_A));
    expect(verifyRulePack(packWith([{ keyId: keyIdFor('ff'.repeat(32)), algorithm: 'Ed25519', signature }]), store)).toEqual({
      ok: false,
      code: 'RULE_PACK_SIGNATURE_INVALID',
    });
  });

  it('refuses a hand-made store that the document validator rejects, in either key order', () => {
    const correct = trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE');
    const mislabeled = { ...correct, publicKey: trustKey(TEST_PUBLIC_KEY_B, 'ACTIVE').publicKey };
    const pack = signedPack(TEST_SEED_A, KEY_ID_A);
    expect(verifyRulePack(pack, forgedStore([mislabeled, correct]))).toEqual({ ok: false, code: 'TRUST_STORE_INVALID' });
    expect(verifyRulePack(pack, forgedStore([correct, mislabeled]))).toEqual({ ok: false, code: 'TRUST_STORE_INVALID' });
  });

  it('propagates a store rollback instead of verifying against a rolled-back store', () => {
    const document = trustStoreDocument('1.0.0', [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')], '2.0.0');
    expect(verifyRulePack(signedPack(TEST_SEED_A, KEY_ID_A), document as unknown as TrustStoreV2)).toEqual({
      ok: false,
      code: 'TRUST_STORE_ROLLBACK',
    });
  });

  it('returns a typed rejection when the signatures array is absent or null', () => {
    const store = admittedStore([trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    const absent = { ...packWith([]), signatures: undefined } as unknown as RulePackV2;
    const nulled = { ...packWith([]), signatures: null } as unknown as RulePackV2;
    expect(verifyRulePack(absent, store)).toEqual({ ok: false, code: 'RULE_PACK_SIGNATURE_MALFORMED' });
    expect(verifyRulePack(nulled, store)).toEqual({ ok: false, code: 'RULE_PACK_SIGNATURE_MALFORMED' });
  });

  it('returns a typed rejection when a signature entry is null', () => {
    const store = admittedStore([trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    const pack = { ...packWith([]), signatures: [null] } as unknown as RulePackV2;
    expect(verifyRulePack(pack, store)).toEqual({ ok: false, code: 'RULE_PACK_SIGNATURE_MALFORMED' });
  });

  it('returns a typed rejection when a signature value is absent', () => {
    const store = admittedStore([trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    const pack = { ...packWith([]), signatures: [{ keyId: KEY_ID_A, algorithm: 'Ed25519' }] } as unknown as RulePackV2;
    expect(verifyRulePack(pack, store)).toEqual({ ok: false, code: 'RULE_PACK_SIGNATURE_MALFORMED' });
  });
});
