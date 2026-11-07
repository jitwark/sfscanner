import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SourceMemberRefV2 } from '../source/source-types';
import { encodeIdentityTuple } from './node-edge-identity';
import type {
  NormalizationAmbiguityKind,
  NormalizationAmbiguityV2,
  NormalizationResolution,
  NormalizationSecurityImpact,
} from './security-workflow';

const encoder = new TextEncoder();
const KIND_ORDER: Record<NormalizationAmbiguityKind, number> = {
  DUPLICATE_MEMBER: 0,
  AMBIGUOUS_NODE: 1,
  AMBIGUOUS_EDGE: 2,
  UNRESOLVED_EDGE: 3,
  MALFORMED_SECURITY_VALUE: 4,
};

export function createAmbiguity(input: {
  kind: NormalizationAmbiguityKind;
  subject: SourceMemberRefV2;
  related?: readonly SourceMemberRefV2[];
  securityImpact: NormalizationSecurityImpact;
  resolution: NormalizationResolution;
}): NormalizationAmbiguityV2 {
  const related = [...(input.related ?? [])].sort(compareRefs);
  const ambiguityId = bytesToHex(sha256(encoder.encode(encodeIdentityTuple([
    'secureflow-normalization-ambiguity-v2',
    input.kind,
    input.subject.astNodeId,
    ...related.map((ref) => ref.astNodeId),
    input.securityImpact,
    input.resolution,
  ]))));
  return Object.freeze({
    ambiguityId,
    kind: input.kind,
    subject: input.subject,
    related: Object.freeze(related),
    securityImpact: input.securityImpact,
    resolution: input.resolution,
  });
}

export function sortAmbiguities(items: readonly NormalizationAmbiguityV2[]): NormalizationAmbiguityV2[] {
  return [...items].sort((left, right) => {
    const occurrence = comparePath(left.subject.occurrencePath, right.subject.occurrencePath);
    if (occurrence !== 0) return occurrence;
    const kind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    if (kind !== 0) return kind;
    const related = compareStrings(left.related.map((ref) => ref.astNodeId).join('\u0000'), right.related.map((ref) => ref.astNodeId).join('\u0000'));
    if (related !== 0) return related;
    return compareStrings(left.ambiguityId, right.ambiguityId);
  });
}

function compareRefs(left: SourceMemberRefV2, right: SourceMemberRefV2): number {
  const ids = compareStrings(left.astNodeId, right.astNodeId);
  return ids === 0 ? comparePath(left.occurrencePath, right.occurrencePath) : ids;
}

function comparePath(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.length - right.length;
}

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
