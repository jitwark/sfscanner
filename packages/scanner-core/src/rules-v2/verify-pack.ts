import { ed25519 } from '@noble/curves/ed25519.js';
import { canonicalPackBytes } from './pack-identity';
import type { RulePackV2 } from './pack-schema';
import { decodeUnpaddedBase64UrlV2, lookupTrustKeyV2, validateTrustStoreV2, type TrustStoreV2 } from './trust-store';

/**
 * Reserved post-v2 external-pack verification (WC-0702 preparation; no v2 caller reaches this
 * module; the CLI, the versioned config and the browser worker still refuse every external pack).
 *
 * Normative source: rule-pack-contract.md:63-67 — each Ed25519 signature verifies the canonical
 * pack bytes with `signatures=[]`, the same bytes `createPackDigest` hashes; at least one valid
 * signature under an ACTIVE key of the explicit trust store admits scoring, and revoked-only,
 * invalid, malformed or unknown-key signatures reject. The pack contributes no key: its declared
 * `keyId` is only a lookup into the store. No wall clock and no network participate.
 *
 * The store argument is re-validated before any decision (a duplicate-keyId store can never reach a
 * verification outcome), so store failures surface as `TRUST_STORE_INVALID`/`TRUST_STORE_ROLLBACK`
 * and the store's own recorded floor is enforced by default. Unvalidated signature material is
 * refused as `RULE_PACK_SIGNATURE_MALFORMED` instead of escaping as a `TypeError`; well-formed
 * unvalidated input remains the caller's type obligation only for the pack body fields that
 * `canonicalPackBytes` reads.
 *
 * Synchronous by contract compatibility: canonical bytes and `@noble/curves` Ed25519 verification
 * are synchronous, so no Promise is introduced at the reserved admission boundary.
 */
export type RulePackRejectionCodeV2 =
  | 'RULE_PACK_UNSIGNED'
  | 'RULE_PACK_KEY_UNKNOWN'
  | 'RULE_PACK_KEY_REVOKED'
  | 'RULE_PACK_SIGNATURE_MALFORMED'
  | 'RULE_PACK_SIGNATURE_INVALID'
  | 'TRUST_STORE_INVALID'
  | 'TRUST_STORE_ROLLBACK';
export type RulePackVerificationV2 = Readonly<
  | { ok: true; keyId: string }
  | { ok: false; code: RulePackRejectionCodeV2 }
>;

const rejectWith = (code: RulePackRejectionCodeV2): RulePackVerificationV2 => Object.freeze({ ok: false as const, code });
function verifies(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    // `zip215: false` selects the strict RFC 8032 equation and canonical encodings (noble-curves
    // ed25519 `verify`); the fail-closed choice where the contract only says "Ed25519".
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

export function verifyRulePack(pack: RulePackV2, store: TrustStoreV2): RulePackVerificationV2 {
  const admitted = validateTrustStoreV2(store);
  if (!admitted.ok) return rejectWith(admitted.code);
  const trusted = admitted.store;
  if (!Array.isArray(pack.signatures)) return rejectWith('RULE_PACK_SIGNATURE_MALFORMED');
  if (pack.signatures.length === 0) return rejectWith('RULE_PACK_UNSIGNED');
  const message = canonicalPackBytes(pack);
  let unknown = false;
  let revoked = false;
  let malformed = false;
  let invalid = false;
  for (const entry of pack.signatures as readonly unknown[]) {
    if (entry === null || typeof entry !== 'object') { malformed = true; continue; }
    const item = entry as { keyId?: unknown; signature?: unknown };
    if (typeof item.keyId !== 'string') { unknown = true; continue; }
    const lookup = lookupTrustKeyV2(trusted, item.keyId);
    if (lookup.status === 'UNKNOWN') { unknown = true; continue; }
    if (lookup.status === 'REVOKED') { revoked = true; continue; }
    const signatureBytes = typeof item.signature === 'string' ? decodeUnpaddedBase64UrlV2(item.signature, 64) : undefined;
    if (signatureBytes === undefined) { malformed = true; continue; }
    const publicKey = decodeUnpaddedBase64UrlV2(lookup.key.publicKey, 32);
    if (publicKey !== undefined && verifies(signatureBytes, message, publicKey)) return Object.freeze({ ok: true as const, keyId: item.keyId });
    invalid = true;
  }
  if (revoked) return rejectWith('RULE_PACK_KEY_REVOKED');
  if (malformed) return rejectWith('RULE_PACK_SIGNATURE_MALFORMED');
  if (invalid) return rejectWith('RULE_PACK_SIGNATURE_INVALID');
  return rejectWith('RULE_PACK_KEY_UNKNOWN');
}
