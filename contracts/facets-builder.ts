import {
  discoveryFields,
  toNormalizedTag,
  type FacetCounts,
  type FacetData,
  type NormalizedTag,
  type TagGroup,
} from './discovery';
import type { Entry } from './index';
import { rankedSearchableEntries } from './indexability';
import { compareCanonicalStrings } from './stable-order';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Index(code: number): number {
  const index = BASE64_ALPHABET.indexOf(String.fromCharCode(code));
  if (index < 0) throw new Error('Invalid base64 input');
  return index;
}

function encodeBytes(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64_ALPHABET[first >> 2];
    encoded += BASE64_ALPHABET[((first & 3) << 4) | ((second ?? 0) >> 4)];
    encoded += second === undefined ? '=' : BASE64_ALPHABET[((second & 15) << 2) | ((third ?? 0) >> 6)];
    encoded += third === undefined ? '=' : BASE64_ALPHABET[third & 63];
  }
  return encoded;
}

function decodeBytes(input: string): Uint8Array {
  const compact = input.replace(/\s/g, '');
  if (compact.length % 4 === 1) throw new Error('Invalid base64 input');
  const padded = compact.padEnd(compact.length + ((4 - compact.length % 4) % 4), '=');
  const padding = padded.endsWith('==') ? 2 : padded.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((padded.length / 4) * 3 - padding);
  let output = 0;

  for (let index = 0; index < padded.length; index += 4) {
    const first = base64Index(padded.charCodeAt(index));
    const second = base64Index(padded.charCodeAt(index + 1));
    const third = padded[index + 2] === '=' ? 0 : base64Index(padded.charCodeAt(index + 2));
    const fourth = padded[index + 3] === '=' ? 0 : base64Index(padded.charCodeAt(index + 3));
    if (output < bytes.length) bytes[output++] = (first << 2) | (second >> 4);
    if (output < bytes.length) bytes[output++] = ((second & 15) << 4) | (third >> 2);
    if (output < bytes.length) bytes[output++] = ((third & 3) << 6) | fourth;
  }
  return bytes;
}

export function encodeUint32ArrayToBase64(arr: Uint32Array): string {
  const bytes = new Uint8Array(arr.length * 4);
  for (let index = 0; index < arr.length; index++) {
    const value = arr[index]!;
    const offset = index * 4;
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = value >>> 24;
  }
  return encodeBytes(bytes);
}

export function decodeBase64ToUint32Array(input: string): Uint32Array {
  const bytes = decodeBytes(input);
  if (bytes.length % 4 !== 0) throw new Error('Base64 input is not a Uint32 array');
  const result = new Uint32Array(bytes.length / 4);
  for (let index = 0; index < result.length; index++) {
    const offset = index * 4;
    result[index] = bytes[offset]!
      | (bytes[offset + 1]! << 8)
      | (bytes[offset + 2]! << 16)
      | (bytes[offset + 3]! << 24);
  }
  return result;
}

export function countSetBits(arr: Uint32Array): number {
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    let n = arr[i]!;
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    count += (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return count;
}

export function intersectUint32Arrays(arrays: Uint32Array[]): Uint32Array {
  if (arrays.length === 0) return new Uint32Array(0);
  const result = new Uint32Array(arrays[0]!.length);
  result.set(arrays[0]!);
  for (const next of arrays.slice(1)) {
    for (let i = 0; i < result.length; i++) result[i] &= next[i]!;
  }
  return result;
}

function add(counts: Record<string, number>, value: string): void {
  counts[value] = (counts[value] ?? 0) + 1;
}

function boundedFacets(counts: FacetCounts, limit: number): NormalizedTag[] {
  const groups: Array<[TagGroup, Record<string, number>]> = [
    ['rights', counts.rights], ['security', counts.grade], ['trigger', counts.trigger],
    ['complexity', counts.complexity], ['capability', counts.capabilities],
    ['integration', counts.integrations], ['intent', counts.tags],
  ];
  return groups.flatMap(([group, values]) => Object.entries(values)
    .sort((a, b) => b[1] - a[1] || compareCanonicalStrings(a[0], b[0]))
    .slice(0, group === 'integration' || group === 'intent' ? limit : undefined)
    .map(([value, count]) => toNormalizedTag(group, value, count)));
}

function topCounts(values: Record<string, number>, limit: number): Record<string, number> {
  return Object.fromEntries(Object.entries(values)
    .sort((a, b) => b[1] - a[1] || compareCanonicalStrings(a[0], b[0]))
    .slice(0, limit));
}

/**
 * Facet counts and bitsets over **ranked searchable entries only** —
 * `rankedSearchableEntries`, never the whole corpus.
 *
 * The scope matters because the same field name is published twice, over two
 * populations. `FacetCounts.rights` here is the *search* split: it describes
 * what a facet filter can actually return, which is the ranked searchable set.
 * The corpus-wide rights figures are `stats.json`'s top-level
 * `redistributableCount` / `linkOnlyCount` and `analytics.json`'s `rights`, and
 * they are deliberately larger: a canonical corpus entry below the
 * `isSearchable` floor (fewer than three functional nodes, or no recognised
 * node type) counts there and not here.
 *
 * As measured in the current artifact (`data/stats.json`, 2026-10-17):
 * `facetCounts.rights.link_only` is 11,245 over 11,245 ranked searchable
 * entries, while corpus-wide `linkOnlyCount` is 11,464 over 11,464 entries.
 * Those are that artifact's measured values, not constants: the difference is
 * exactly the entries the `isSearchable` floor excludes, and it moves with the
 * corpus. `pipeline/package/rights-count-population.test.ts` pins both scopes
 * on a two-entry fixture so a silent widening or narrowing of either fails.
 *
 * One ordinal space indexes all seven facet groups, so `rights` cannot be given
 * a different population from the other six without a second bitset space.
 */
export function buildFacets(entries: Entry[], displayLimit = 60): FacetData {
  const visible = rankedSearchableEntries(entries);
  const total = visible.length;
  const wordCount = Math.ceil(total / 32);
  const counts: FacetCounts = {
    rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: {}, tags: {},
  };
  const rawBitsets: Record<string, Uint32Array> = {};
  const mark = (key: string, index: number) => {
    const bits = rawBitsets[key] ??= new Uint32Array(wordCount);
    bits[index >> 5] |= 1 << (index & 31);
  };
  const markValues = (prefix: string, values: string[], group: Record<string, number>, index: number) => {
    for (const value of new Set(values)) { mark(`${prefix}:${value}`, index); add(group, value); }
  };

  visible.forEach((entry, index) => {
    const fields = discoveryFields(entry);
    markValues('rights', [fields.rights], counts.rights, index);
    markValues('grade', [fields.grade], counts.grade, index);
    markValues('trigger', fields.triggers, counts.trigger, index);
    markValues('complexity', [fields.complexity], counts.complexity, index);
    markValues('capability', fields.capabilities, counts.capabilities, index);
    markValues('integration', fields.integrations, counts.integrations, index);
    markValues('tag', fields.tags, counts.tags, index);
  });
  counts.integrations = topCounts(counts.integrations, displayLimit);
  counts.tags = topCounts(counts.tags, displayLimit);

  return {
    total,
    counts,
    facets: boundedFacets(counts, displayLimit),
    bitsets: Object.fromEntries(Object.entries(rawBitsets).map(([key, value]) => [key, encodeUint32ArrayToBase64(value)])),
    ordinals: visible.map((entry) => entry.id),
  };
}
