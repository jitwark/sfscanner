import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SourceMemberRefV2 } from './source-types';

const encoder = new TextEncoder();

export type SourceSlot =
  | { readonly kind: 'ROOT' }
  | { readonly kind: 'ARRAY'; readonly index: number }
  | { readonly kind: 'MEMBER'; readonly nameLexeme: string; readonly occurrence: number };

export function encodeSourceTuple(parts: readonly string[]): string {
  return parts.map(encodeIdentityPart).join('');
}

function encodeIdentityPart(part: string): string {
  if (!containsLoneSurrogate(part)) {
    const tagged = `N${encoder.encode(part).byteLength}:${part}`;
    return `${encoder.encode(tagged).byteLength}:${tagged}`;
  }
  let codeUnits = '';
  for (let index = 0; index < part.length; index += 1) codeUnits += part.charCodeAt(index).toString(16).padStart(4, '0');
  const tagged = `C${part.length}:${codeUnits}`;
  return `${encoder.encode(tagged).byteLength}:${tagged}`;
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

export function encodeSourceSlot(slot: SourceSlot): string {
  if (slot.kind === 'ROOT') return 'ROOT';
  if (slot.kind === 'ARRAY') return encodeSourceTuple(['ARRAY', String(slot.index)]);
  return encodeSourceTuple(['MEMBER', slot.nameLexeme, String(slot.occurrence)]);
}

export function createSourceAstNodeId(input: {
  readonly occurrencePath: readonly number[];
  readonly slot: string;
  readonly kind: string;
  readonly payload: string;
}): string {
  const path = encodeSourceTuple(input.occurrencePath.map(String));
  return bytesToHex(sha256(encoder.encode(encodeSourceTuple([
    'secureflow-source-member-v2', path, input.slot, input.kind, input.payload,
  ]))));
}

export function createSourceMemberRef(input: {
  readonly pointer: string;
  readonly occurrencePath: readonly number[];
  readonly slot: SourceSlot;
  readonly kind: string;
  readonly payload: string;
  readonly span: SourceMemberRefV2['span'];
  readonly astNodeId?: string;
  readonly reuseOccurrencePath?: boolean;
}): SourceMemberRefV2 {
  const occurrencePath = input.reuseOccurrencePath
    ? Object.freeze(input.occurrencePath)
    : Object.freeze([...input.occurrencePath]);
  return Object.freeze({
    pointer: input.pointer,
    occurrencePath,
    astNodeId: input.astNodeId ?? createSourceAstNodeId({
      occurrencePath, slot: encodeSourceSlot(input.slot), kind: input.kind, payload: input.payload,
    }),
    span: input.span,
  });
}
