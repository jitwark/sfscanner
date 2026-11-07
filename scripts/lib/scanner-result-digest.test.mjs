import { describe, expect, test } from 'vitest';
import { canonicalJson, resultsDigest, scopeCounts } from './scanner-result-digest.mjs';

/**
 * The digest is what binds 11,464 published security verdicts to the freshness
 * record, so these tests pin the two properties that make it work: the encoding
 * is canonical — insertion order cannot change it — and it covers the
 * redistributable verdicts and nothing else.
 */
const entry = (id, status, overrides = {}, entryOverrides = {}) => ({
  id,
  rights: { status },
  source: { kind: 'github' },
  // The published marker for how the readiness report was produced. `b` is the
  // link-only entry with no body, so it is the one the record must count as
  // unscanned and unverified.
  readiness: { analysis: 'derived' },
  download: status === 'redistributable' ? { pack: 0, line: 0, offset: 0, length: 10, sha256: 'a'.repeat(64) } : undefined,
  security: {
    grade: 'LOW',
    score: 10,
    counts: { critical: 0, high: 0, medium: 0, low: 1, info: 0 },
    findings: [],
    hardenedExtra: 0,
    scannerVersion: 'c998701',
    profile: 'beta-default',
    schemaVersion: 'scanner-result-v1',
    ...overrides,
  },
  ...entryOverrides,
});

const entries = [
  entry('a', 'redistributable'),
  entry('b', 'link_only', {}, { readiness: { analysis: 'unscanned' } }),
  entry('c', 'redistributable'),
];

describe('canonical serialization', () => {
  test('orders object keys independently of insertion order and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [{ z: 1, y: 2 }, 'k'] })).toBe('{"a":[{"y":2,"z":1},"k"],"b":1}');
  });

  test('rejects values that cannot serialize deterministically', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/u);
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/u);
  });
});

describe('resultsDigest', () => {
  test('binds the redistributable verdicts and nothing else', () => {
    const other = [entry('a', 'redistributable'), entry('b', 'link_only', { grade: 'CRITICAL', score: 99 }), entry('c', 'redistributable')];
    expect(resultsDigest(other)).toBe(resultsDigest(entries));
    expect(resultsDigest([entry('a', 'redistributable', { grade: 'HIGH' })])).not.toBe(resultsDigest([entry('a', 'redistributable')]));
  });

  test('counts each rights scope without collapsing the two totals', () => {
    expect(scopeCounts(entries)).toEqual({ total: 3, redistributable: 2, linkOnly: 1 });
  });
});
