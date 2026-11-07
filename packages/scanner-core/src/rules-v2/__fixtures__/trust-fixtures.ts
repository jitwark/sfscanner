import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { canonicalJsonBytes } from '../../canonical-json';
import type { TrustKeyV2 } from '../trust-store';

/**
 * Reserved post-v2 trust fixtures (WC-0702 preparation; no v2 caller reaches them yet).
 *
 * The key pairs are the published RFC 8032 §7.1 TEST 1 / TEST 2 vectors, so every vector below is
 * deterministic without randomness, a clock or a network, and the derived key ids are recomputable
 * from the RFC text alone. `verify-pack.test.ts` re-derives the public keys from the seeds as a
 * fixture self-check.
 */
export const TEST_SEED_A = hexToBytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
export const TEST_PUBLIC_KEY_A = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
export const TEST_SEED_B = hexToBytes('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb');
export const TEST_PUBLIC_KEY_B = '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url of arbitrary bytes (test-side encoder for fixture documents). */
export function encodeUnpaddedBase64Url(input: Uint8Array): string {
  let output = '';
  for (let index = 0; index < input.length; index += 3) {
    const first = input[index]!;
    const second = input[index + 1];
    const third = input[index + 2];
    const bits = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += ALPHABET[(bits >> 18) & 63]! + ALPHABET[(bits >> 12) & 63]!;
    if (second !== undefined) output += ALPHABET[(bits >> 6) & 63]!;
    if (third !== undefined) output += ALPHABET[bits & 63]!;
  }
  return output;
}

/** Lowercase hex of the first 16 bytes of the public-key SHA-256 (rule-pack-contract.md:65-66). */
export function keyIdFor(publicKeyHex: string): string {
  return bytesToHex(sha256(hexToBytes(publicKeyHex)).subarray(0, 16));
}

export function trustKey(publicKeyHex: string, status: TrustKeyV2['status'], keyId = keyIdFor(publicKeyHex)): TrustKeyV2 {
  return Object.freeze({
    keyId,
    algorithm: 'Ed25519' as const,
    publicKey: encodeUnpaddedBase64Url(hexToBytes(publicKeyHex)),
    status,
  });
}

/**
 * Trust-store document whose digest covers `{schemaVersion, version, minimumVersion, keys}` with the
 * keys in canonical keyId order — the shipped built-in body convention
 * (`packages/scanner-cli/src/v2/commands.ts`, `hash({schemaVersion:'scanner-trust-store-v2', version,
 * keys})`) with the store's own recorded floor included. `minimumVersion` defaults to the store's own
 * version so a fixture is never a downgrade of itself. Built here from the contract text rather than
 * from the module under test.
 */
export function trustStoreDocument(version: string, keys: readonly TrustKeyV2[], minimumVersion = version): Record<string, unknown> {
  const ordered = [...keys].sort((left, right) => (left.keyId < right.keyId ? -1 : 1));
  const digest = bytesToHex(sha256(canonicalJsonBytes({ schemaVersion: 'scanner-trust-store-v2', version, minimumVersion, keys: ordered })));
  return { schemaVersion: 'scanner-trust-store-v2', id: 'fixture-trust-store', version, minimumVersion, keys, digest };
}
