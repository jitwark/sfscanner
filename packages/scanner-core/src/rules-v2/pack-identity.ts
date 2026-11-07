import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJsonBytes } from '../canonical-json';
import type { RulePackV2 } from './pack-schema';

export function canonicalPackBytes(pack: RulePackV2): Uint8Array {
  const { signatures: _signatures, ...body } = pack;
  return canonicalJsonBytes({ ...body, signatures: [] });
}

export function createPackDigest(pack: RulePackV2): string {
  return bytesToHex(sha256(canonicalPackBytes(pack)));
}
