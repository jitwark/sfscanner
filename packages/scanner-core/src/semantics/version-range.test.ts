import { describe, expect, it } from 'vitest';
import { parseStrictSemver } from './semver';
import { matchesVersionRange, validateVersionRange, type VersionRangeV2 } from './version-range';

const range = (clauses: unknown): unknown => ({ clauses });
const comparator = (op: string, version: string): unknown => ({ op, version });

describe('canonical comparator ranges', () => {
  it('accepts and freezes a sorted conjunction/disjunction range', () => {
    const input = range([
      [comparator('GTE', '1.0.0'), comparator('LT', '2.0.0')],
      [comparator('EQ', '3.0.0')],
    ]);
    const result = validateVersionRange(input);
    expect(result).toEqual(input);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.clauses)).toBe(true);
    expect(Object.isFrozen(result.clauses[0])).toBe(true);
    expect(Object.isFrozen(result.clauses[0][0])).toBe(true);
  });

  it('accepts only the explicit empty range for all stable versions', () => {
    const result = validateVersionRange({ clauses: [] });
    expect(matchesVersionRange(parseStrictSemver('99.0.0'), result)).toBe(true);
    expect(matchesVersionRange(parseStrictSemver('99.0.0-rc.1'), result)).toBe(false);
  });

  it('requires canonical comparator and clause order and rejects duplicates', () => {
    expect(() => validateVersionRange(range([
      [comparator('LT', '2.0.0'), comparator('GTE', '1.0.0')],
    ]))).toThrow(TypeError);
    expect(() => validateVersionRange(range([
      [comparator('EQ', '3.0.0')], [comparator('EQ', '1.0.0')],
    ]))).toThrow(TypeError);
    expect(() => validateVersionRange(range([
      [comparator('EQ', '1.0.0')], [comparator('EQ', '1.0.0')],
    ]))).toThrow(TypeError);
    expect(() => validateVersionRange(range([[]]))).toThrow(TypeError);
  });

  it('rejects unknown keys, invalid operators, sparse arrays, and accessors', () => {
    expect(() => validateVersionRange({ clauses: [], extra: true })).toThrow(TypeError);
    expect(() => validateVersionRange(range([[comparator('NEQ', '1.0.0')]]))).toThrow(TypeError);
    const sparse = [] as unknown[];
    sparse.length = 1;
    expect(() => validateVersionRange({ clauses: sparse })).toThrow(TypeError);
    const proxy = new Proxy({ clauses: [] }, { ownKeys: () => { throw new Error('trap'); } });
    expect(() => validateVersionRange(proxy)).toThrow(TypeError);
    const accessor = {} as { clauses?: unknown };
    Object.defineProperty(accessor, 'clauses', { get: () => [] });
    expect(() => validateVersionRange(accessor)).toThrow(TypeError);
  });

  it('allows prereleases only for a same-base explicit prerelease clause', () => {
    const stable = validateVersionRange(range([[comparator('GTE', '1.0.0')]]));
    const explicit = validateVersionRange(range([[comparator('GTE', '1.0.0-rc.1')]]));
    expect(matchesVersionRange(parseStrictSemver('1.0.0-rc.2'), stable)).toBe(false);
    expect(matchesVersionRange(parseStrictSemver('1.0.0-rc.2'), explicit)).toBe(true);
    expect(matchesVersionRange(parseStrictSemver('1.0.1-rc.2'), explicit)).toBe(false);
  });

  it('evaluates all comparators in a clause and any matching clause', () => {
    const input: VersionRangeV2 = validateVersionRange(range([
      [comparator('GTE', '1.0.0'), comparator('LT', '2.0.0')],
      [comparator('EQ', '4.0.0')],
    ]));
    expect(matchesVersionRange(parseStrictSemver('1.5.0'), input)).toBe(true);
    expect(matchesVersionRange(parseStrictSemver('2.0.0'), input)).toBe(false);
    expect(matchesVersionRange(parseStrictSemver('4.0.0+ci'), input)).toBe(true);
  });

  it('rejects duplicate comparators within one conjunction', () => {
    expect(() => validateVersionRange(range([
      [comparator('EQ', '1.0.0'), comparator('EQ', '1.0.0')],
    ]))).toThrow(TypeError);
  });

  it('compares build-insensitive equality while preserving canonical input', () => {
    const input = validateVersionRange(range([[comparator('EQ', '1.2.3')]]));
    expect(matchesVersionRange(parseStrictSemver('1.2.3+ci.7'), input)).toBe(true);
    expect(matchesVersionRange(parseStrictSemver('1.2.4+ci.7'), input)).toBe(false);
  });

  it('copies comparator and clause records before deeply freezing the result', () => {
    const input = { clauses: [[{ op: 'EQ', version: '1.0.0' }]] };
    const result = validateVersionRange(input);
    input.clauses[0][0].op = 'GT';
    input.clauses[0].push({ op: 'LT', version: '2.0.0' });
    input.clauses.push([{ op: 'EQ', version: '3.0.0' }]);
    expect(result).toEqual({ clauses: [[{ op: 'EQ', version: '1.0.0' }]] });
    expect(Object.isFrozen(result.clauses[0][0])).toBe(true);
  });
});
