import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJsonBytes } from '../canonical-json';
import { compareSemver, parseStrictSemver, type StrictSemver } from '../semantics/semver';

/**
 * Reserved post-v2 Ed25519 trust store (WC-0702 preparation; no v2 caller reaches this module).
 *
 * Normative source: openspec/changes/world-class-scanner-cli/rule-pack-contract.md:20-23,63-74.
 * The store is the only key authority: verification is offline, contains no wall clock, and a pack
 * can never contribute a key. The store digest covers `{schemaVersion, version, minimumVersion,
 * keys}` with keys in canonical keyId order, the convention the shipped built-in digest uses
 * (`packages/scanner-cli/src/v2/commands.ts`, the empty `scanner-trust-store-v2@2.0.0` store) plus
 * the floor; the contract text fixes only that all canonically ordered keys are covered.
 *
 * Downgrade protection is closed by default: the document carries its own `minimumVersion` floor,
 * which `validateTrustStoreV2` always enforces against the document's `version`. The optional
 * `minimumVersion` argument exists only to raise that floor; it can never disable or lower it.
 */
export type TrustKeyV2 = Readonly<{
  keyId: string;
  algorithm: 'Ed25519';
  publicKey: string;
  status: 'ACTIVE' | 'REVOKED';
}>;
export type TrustStoreV2 = Readonly<{
  schemaVersion: 'scanner-trust-store-v2';
  id: string;
  version: string;
  minimumVersion: string;
  keys: readonly TrustKeyV2[];
  digest: string;
}>;
/** A caller-supplied floor can only raise the document's own `minimumVersion`; it can never disable or lower it. */
export type TrustStoreValidationOptions = Readonly<{ minimumVersion?: string }>;
export type TrustStoreAdmission = Readonly<
  | { ok: true; store: TrustStoreV2 }
  | { ok: false; code: 'TRUST_STORE_INVALID' | 'TRUST_STORE_ROLLBACK'; errors: readonly string[] }
>;
export type TrustKeyLookupV2 = Readonly<
  | { status: 'ACTIVE'; key: TrustKeyV2 }
  | { status: 'REVOKED'; key: TrustKeyV2 }
  | { status: 'UNKNOWN' }
>;

const MAX_KEYS = 1_000;
const MAX_TEXT_BYTES = 4_096;
const REMOTE = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;
const KEY_ID = /^[0-9a-f]{32}$/;
const encoder = new TextEncoder();
const reject = (): never => { throw new TypeError('Invalid trust store'); };

type Dict = Record<string, unknown>;
function record(input: unknown, keys: readonly string[]): Dict {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return reject();
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return reject();
  if (Object.getOwnPropertySymbols(input).length !== 0) return reject();
  const names = Object.getOwnPropertyNames(input);
  if (names.length !== keys.length || keys.some((key) => !names.includes(key))) return reject();
  const output: Dict = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !('value' in descriptor)) return reject();
    output[key] = descriptor.value;
  }
  return output;
}
function dense(input: unknown): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return reject();
  const length = Object.getOwnPropertyDescriptor(input, 'length');
  if (length === undefined || !('value' in length) || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_KEYS) return reject();
  const names = Object.getOwnPropertyNames(input);
  if (names.length !== length.value + 1 || Object.getOwnPropertySymbols(input).length !== 0) return reject();
  const output: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined || !('value' in descriptor)) return reject();
    output.push(descriptor.value);
  }
  return output;
}
function text(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_TEXT_BYTES || input !== input.normalize('NFC') || REMOTE.test(input)) return reject();
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return reject();
    if (code >= 0xd800 && code <= 0xdbff) { const next = input.charCodeAt(index + 1); if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return reject(); index += 1; }
    else if (code >= 0xdc00 && code <= 0xdfff) return reject();
  }
  if (encoder.encode(input).length > MAX_TEXT_BYTES) return reject();
  return input;
}

function base64urlValue(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (code === 45) return 62;
  if (code === 95) return 63;
  return -1;
}
/**
 * Strict canonical unpadded base64url: exact character count for `byteLength`, only the unpadded
 * alphabet, and zero leftover bits, so no second encoding can name the same bytes
 * (rule-pack-contract.md:64-65). Returns undefined instead of throwing so callers fail closed.
 */
export function decodeUnpaddedBase64UrlV2(value: string, byteLength: number): Uint8Array | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length !== Math.ceil((byteLength * 4) / 3)) return undefined;
  const output = new Uint8Array(byteLength);
  let accumulator = 0;
  let bits = 0;
  let at = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = base64urlValue(value.charCodeAt(index));
    if (unit < 0) return undefined;
    accumulator = (accumulator << 6) | unit;
    bits += 6;
    if (bits >= 8) { bits -= 8; if (at >= byteLength) return undefined; output[at] = (accumulator >>> bits) & 0xff; at += 1; }
  }
  if (at !== byteLength || (accumulator & ((1 << bits) - 1)) !== 0) return undefined;
  return output;
}

/** `keyId` is lowercase hex of the first 16 bytes of the public-key SHA-256 (contract:65-66). */
const keyIdForBytes = (publicKey: Uint8Array): string => bytesToHex(sha256(publicKey).subarray(0, 16));
/** SHA-256 hex of the canonical `{schemaVersion, version, minimumVersion, keys}` body, keys already ordered by keyId (header convention). */
const digestFor = (version: string, minimumVersion: string, keys: readonly TrustKeyV2[]): string => bytesToHex(sha256(canonicalJsonBytes({ schemaVersion: 'scanner-trust-store-v2', version, minimumVersion, keys })));
function floorVersion(options: unknown): StrictSemver | undefined {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return reject();
  if (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null) return reject();
  const names = Object.getOwnPropertyNames(options);
  if (Object.getOwnPropertySymbols(options).length !== 0 || names.some((name) => name !== 'minimumVersion')) return reject();
  if (names.length === 0) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(options, 'minimumVersion');
  if (descriptor === undefined || !('value' in descriptor)) return reject();
  return parseStrictSemver(descriptor.value);
}

export function validateTrustStoreV2(input: unknown, options?: TrustStoreValidationOptions): TrustStoreAdmission {
  try {
    const requestedFloor = floorVersion(options);
    const value = record(input, ['schemaVersion', 'id', 'version', 'minimumVersion', 'keys', 'digest']);
    if (value.schemaVersion !== 'scanner-trust-store-v2') return reject();
    const id = text(value.id);
    const version = text(value.version);
    const minimumVersion = text(value.minimumVersion);
    const parsedVersion = parseStrictSemver(version);
    const parsedMinimum = parseStrictSemver(minimumVersion);
    const keys: TrustKeyV2[] = [];
    const keyIds = new Set<string>();
    for (const raw of dense(value.keys)) {
      const item = record(raw, ['keyId', 'algorithm', 'publicKey', 'status']);
      if (item.algorithm !== 'Ed25519') return reject();
      const keyId = text(item.keyId);
      if (!KEY_ID.test(keyId)) return reject();
      const publicKey = text(item.publicKey);
      const publicKeyBytes = decodeUnpaddedBase64UrlV2(publicKey, 32);
      if (publicKeyBytes === undefined || keyId !== keyIdForBytes(publicKeyBytes)) return reject();
      const status = item.status;
      if (status !== 'ACTIVE' && status !== 'REVOKED') return reject();
      if (keyIds.has(keyId)) return reject();
      keyIds.add(keyId);
      keys.push(Object.freeze({ keyId, algorithm: 'Ed25519' as const, publicKey, status }));
    }
    keys.sort((left, right) => (left.keyId < right.keyId ? -1 : 1));
    const digest = digestFor(version, minimumVersion, keys);
    if (text(value.digest) !== digest) return reject();
    // The document's own floor is always enforced; a caller-supplied floor can only raise it.
    const belowFloor = compareSemver(parsedVersion, parsedMinimum) < 0 || (requestedFloor !== undefined && compareSemver(parsedVersion, requestedFloor) < 0);
    if (belowFloor) return Object.freeze({ ok: false as const, code: 'TRUST_STORE_ROLLBACK' as const, errors: Object.freeze(['TRUST_STORE_ROLLBACK']) });
    return Object.freeze({ ok: true as const, store: Object.freeze({ schemaVersion: 'scanner-trust-store-v2' as const, id, version, minimumVersion, keys: Object.freeze(keys), digest }) });
  } catch {
    return Object.freeze({ ok: false as const, code: 'TRUST_STORE_INVALID' as const, errors: Object.freeze(['TRUST_STORE_INVALID']) });
  }
}

/** The only key authority question verification asks: is this id active, revoked, or not in the store? */
export function lookupTrustKeyV2(store: TrustStoreV2, keyId: string): TrustKeyLookupV2 {
  for (const key of store.keys) {
    if (key.keyId !== keyId) continue;
    if (key.status === 'ACTIVE') return Object.freeze({ status: 'ACTIVE' as const, key });
    return Object.freeze({ status: 'REVOKED' as const, key });
  }
  return Object.freeze({ status: 'UNKNOWN' as const });
}
