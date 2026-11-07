import type { FacetCounts } from '@hub/contracts';
export type { FacetCounts } from '@hub/contracts';

export function decodeBase64ToUint32Array(b64: string): Uint32Array {
  if (typeof atob !== 'function') {
    throw new Error('Base64 decoding is unavailable in this browser runtime');
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Uint32Array(bytes.buffer, 0, Math.floor(bytes.length / 4));
}

export function encodeUint32ArrayToBase64(arr: Uint32Array): string {
  if (typeof btoa !== 'function') {
    throw new Error('Base64 encoding is unavailable in this browser runtime');
  }
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function popcount(arr: Uint32Array): number {
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    let v = arr[i]!;
    v = v - ((v >> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
    count += (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
  }
  return count;
}

export function intersectUint32Arrays(arrays: Uint32Array[]): Uint32Array {
  if (arrays.length === 0) return new Uint32Array(0);
  const len = arrays[0]!.length;
  const result = new Uint32Array(len);
  result.set(arrays[0]!);

  for (let i = 1; i < arrays.length; i++) {
    const arr = arrays[i]!;
    for (let j = 0; j < len; j++) {
      result[j] &= arr[j] || 0;
    }
  }
  return result;
}

export function unionUint32Arrays(arrays: Uint32Array[], totalEntries: number): Uint32Array {
  const result = new Uint32Array(Math.ceil(totalEntries / 32));
  for (const arr of arrays) {
    for (let i = 0; i < result.length; i++) result[i] |= arr[i] ?? 0;
  }
  return result;
}

export function indicesForGroupedFilters(groups: Uint32Array[][], totalEntries: number): number[] {
  const selected = groups.filter((group) => group.length > 0).map((group) => unionUint32Arrays(group, totalEntries));
  const bits = selected.length > 0 ? intersectUint32Arrays(selected) : createFullBitset(totalEntries);
  const indices: number[] = [];
  for (let index = 0; index < totalEntries; index++) {
    if ((bits[index >> 5]! & (1 << (index & 31))) !== 0) indices.push(index);
  }
  return indices;
}

export function createBitsetFromIndices(indices: number[], totalEntries: number): Uint32Array {
  const wordCount = Math.ceil(totalEntries / 32);
  const bitset = new Uint32Array(wordCount);
  for (let idx = 0; idx < indices.length; idx++) {
    const i = indices[idx]!;
    if (i >= 0 && i < totalEntries) {
      bitset[i >> 5] |= 1 << (i & 31);
    }
  }
  return bitset;
}

export function createFullBitset(totalEntries: number): Uint32Array {
  const wordCount = Math.ceil(totalEntries / 32);
  const bitset = new Uint32Array(wordCount);
  const fullWords = Math.floor(totalEntries / 32);
  for (let i = 0; i < fullWords; i++) {
    bitset[i] = 0xffffffff;
  }
  const remainder = totalEntries % 32;
  if (remainder > 0) {
    bitset[fullWords] = (1 << remainder) - 1;
  }
  return bitset;
}

export function computeLiveCounts(
  rawBitsets: Record<string, string | Uint32Array>,
  activeResultBitset: Uint32Array,
): FacetCounts {
  const counts: FacetCounts = {
    rights: {},
    grade: {},
    trigger: {},
    complexity: {},
    capabilities: {},
    integrations: {},
    tags: {},
  };

  const decodedCache: Record<string, Uint32Array> = {};

  for (const [key, raw] of Object.entries(rawBitsets)) {
    const arr =
      typeof raw === 'string'
        ? (decodedCache[key] ??= decodeBase64ToUint32Array(raw))
        : raw;

    const intersection = intersectUint32Arrays([activeResultBitset, arr]);
    const cnt = popcount(intersection);

    if (key.startsWith('rights:')) {
      counts.rights[key.slice(7)] = cnt;
    } else if (key.startsWith('grade:')) {
      counts.grade[key.slice(6)] = cnt;
    } else if (key.startsWith('trigger:')) {
      counts.trigger[key.slice(8)] = cnt;
    } else if (key.startsWith('complexity:')) {
      counts.complexity[key.slice(11)] = cnt;
    } else if (key.startsWith('capability:')) {
      counts.capabilities[key.slice(11)] = cnt;
    } else if (key.startsWith('integration:')) {
      counts.integrations[key.slice(12)] = cnt;
    } else if (key.startsWith('tag:')) {
      counts.tags[key.slice(4)] = cnt;
    }
  }

  return counts;
}
