import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SourceMemberRefV2 } from '../source/source-types';
import type { EdgeRefV2, NodeRefV2 } from './security-workflow';

const encoder = new TextEncoder();

/** The tuple format is deliberately byte-length-prefixed and locale independent. */
export function encodeIdentityTuple(parts: readonly string[]): string {
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

export function createNodeIdentityDigest(ordinal: number, source: SourceMemberRefV2): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new TypeError('Invalid node ordinal');
  return digest(['secureflow-node-ref-v2', String(ordinal), source.astNodeId]);
}

export function createNodeRef(input: {
  ordinal: number;
  source: SourceMemberRefV2;
  explicitId?: unknown;
  name?: unknown;
}): NodeRefV2 {
  const ref: NodeRefV2 = {
    ordinal: input.ordinal,
    source: input.source,
    ...(typeof input.explicitId === 'string' ? { explicitId: input.explicitId } : {}),
    ...(typeof input.name === 'string' ? { name: input.name } : {}),
    identityDigest: createNodeIdentityDigest(input.ordinal, input.source),
  };
  return Object.freeze(ref);
}

export function createEdgeIdentityDigest(edge: Pick<
  EdgeRefV2,
  'ordinal' | 'sourceNode' | 'sourceLabel' | 'targetNode' | 'targetLabel' | 'connectionType' | 'sourcePort' | 'targetPort' | 'source' | 'resolution'
>): string {
  return digest([
    'secureflow-edge-ref-v2',
    unsigned(edge.ordinal),
    edge.sourceNode?.identityDigest ?? 'NONE',
    edge.sourceLabel,
    edge.targetNode?.identityDigest ?? 'NONE',
    edge.targetLabel ?? 'NONE',
    edge.connectionType,
    unsigned(edge.sourcePort),
    unsigned(edge.targetPort),
    edge.source.astNodeId,
    edge.resolution,
  ]);
}

function unsigned(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid identity ordinal');
  return String(value);
}

function digest(parts: readonly string[]): string {
  return bytesToHex(sha256(encoder.encode(encodeIdentityTuple(parts))));
}
