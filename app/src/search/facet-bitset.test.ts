import { describe, expect, it } from 'vitest';
import {
  computeLiveCounts,
  createBitsetFromIndices,
  createFullBitset,
  decodeBase64ToUint32Array,
  encodeUint32ArrayToBase64,
  intersectUint32Arrays,
  indicesForGroupedFilters,
  popcount,
} from './facet-bitset';

describe('facet-bitset', () => {
  it('round-trips base64 encoding and decoding', () => {
    const orig = new Uint32Array([123456, 789012, 0xffffffff, 0]);
    const b64 = encodeUint32ArrayToBase64(orig);
    const decoded = decodeBase64ToUint32Array(b64);
    expect(Array.from(decoded)).toEqual(Array.from(orig));
  });

  it('correctly calculates popcount', () => {
    const arr = new Uint32Array([0b1011, 0, 0b11111111]);
    expect(popcount(arr)).toBe(3 + 0 + 8);
  });

  it('matches brute-force oracle over 2,000-entry fixture', () => {
    const TOTAL = 2000;
    // Generate fixture data: 2,000 entries with random properties
    const entries: Array<{ id: number; grade: string; tag: string; rights: string }> = [];
    const grades = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    const tags = ['openai', 'slack', 'email', 'webhook'];
    const rightsList = ['redistributable', 'link_only'];

    for (let i = 0; i < TOTAL; i++) {
      entries.push({
        id: i,
        grade: grades[i % grades.length]!,
        tag: tags[(i * 3) % tags.length]!,
        rights: rightsList[(i * 7) % rightsList.length]!,
      });
    }

    // Define query condition 1: grade == 'MEDIUM'
    // Define query condition 2: tag == 'openai'
    // Oracle logic (brute-force filter)
    const oracleMatched = entries.filter((e) => e.grade === 'MEDIUM' && e.tag === 'openai');
    const oracleIndices = oracleMatched.map((e) => e.id);

    // Bitset logic
    const mediumIndices = entries.filter((e) => e.grade === 'MEDIUM').map((e) => e.id);
    const openaiIndices = entries.filter((e) => e.tag === 'openai').map((e) => e.id);

    const bitsetMedium = createBitsetFromIndices(mediumIndices, TOTAL);
    const bitsetOpenai = createBitsetFromIndices(openaiIndices, TOTAL);

    const intersected = intersectUint32Arrays([bitsetMedium, bitsetOpenai]);

    // Recover matching indices from intersected bitset
    const recoveredIndices: number[] = [];
    for (let i = 0; i < TOTAL; i++) {
      if ((intersected[i >> 5]! & (1 << (i & 31))) !== 0) {
        recoveredIndices.push(i);
      }
    }

    expect(recoveredIndices).toEqual(oracleIndices);
    expect(popcount(intersected)).toBe(oracleIndices.length);
  });

  it('computes live counts accurately', () => {
    const TOTAL = 100;
    const full = createFullBitset(TOTAL);

    const bitsetLow = createBitsetFromIndices([0, 1, 2, 3, 4], TOTAL);
    const bitsetWeb = createBitsetFromIndices([4, 5, 6], TOTAL);

    const rawBitsets = {
      'grade:LOW': encodeUint32ArrayToBase64(bitsetLow),
      'trigger:webhook': encodeUint32ArrayToBase64(bitsetWeb),
    };

    // Full result set live counts
    const fullCounts = computeLiveCounts(rawBitsets, full);
    expect(fullCounts.grade.LOW).toBe(5);
    expect(fullCounts.trigger.webhook).toBe(3);

    // Filtered result set live counts (only indices [4, 5, 6])
    const filteredResultBitset = createBitsetFromIndices([4, 5, 6], TOTAL);
    const filteredCounts = computeLiveCounts(rawBitsets, filteredResultBitset);
    expect(filteredCounts.grade.LOW).toBe(1); // Only index 4 matches both
    expect(filteredCounts.trigger.webhook).toBe(3);
  });

  it('unions repeated values within a group before intersecting groups', () => {
    const total = 5;
    const groups = [
      [createBitsetFromIndices([0, 1], total), createBitsetFromIndices([2], total)],
      [createBitsetFromIndices([1, 2, 4], total)],
    ];
    expect(Array.from(indicesForGroupedFilters(groups, total))).toEqual([1, 2]);
  });
});
