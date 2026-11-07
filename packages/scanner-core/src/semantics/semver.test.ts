import { describe, expect, it } from 'vitest';
import { compareSemver, parseStrictSemver, sameSemverBase, type StrictSemver } from './semver';
import { matchesVersionRange, validateVersionRange } from './version-range';

describe('strict SemVer', () => {
  it('parses the complete SemVer 2.0.0 grammar', () => {
    const version = parseStrictSemver('1.2.3-alpha.1+build.7');
    expect(version).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['alpha', '1'],
      build: ['build', '7'],
    });
    expect(Object.isFrozen(version)).toBe(true);
    expect(Object.isFrozen(version.prerelease)).toBe(true);
    expect(Object.isFrozen(version.build)).toBe(true);
  });

  it.each([
    '', '1', '1.2', '1.2.3.4', 'v1.2.3', ' 1.2.3', '1.2.3 ',
    '01.2.3', '1.02.3', '1.2.03', '1.2.3-01', '1.2.3-', '1.2.3+',
    '1.2.3-alpha..1', '1.2.3-alpha_1', '1.2.3-α', '1.2.3+build_1',
    '1.2.3^1', '1.2.3 ~ 1.3.0', '1.2.3 - 1.3.0',
  ])('rejects malformed version %j', (value) => {
    expect(() => parseStrictSemver(value)).toThrow(TypeError);
  });

  it('compares numeric and prerelease identifiers without locale rules', () => {
    expect(compareSemver(parseStrictSemver('2.0.0'), parseStrictSemver('10.0.0'))).toBe(-1);
    expect(compareSemver(parseStrictSemver('1.0.0-2'), parseStrictSemver('1.0.0-10'))).toBe(-1);
    expect(compareSemver(parseStrictSemver('1.0.0-alpha'), parseStrictSemver('1.0.0-alpha.1'))).toBe(-1);
    expect(compareSemver(parseStrictSemver('1.0.0-alpha'), parseStrictSemver('1.0.0-beta'))).toBe(-1);
    expect(compareSemver(parseStrictSemver('1.0.0'), parseStrictSemver('1.0.0+different'))).toBe(0);
    expect(compareSemver(parseStrictSemver('9007199254740991.0.0'), parseStrictSemver('9007199254740990.0.0'))).toBe(1);
  });

  it('accepts strict SemVer syntax and preserves arbitrary-length numeric components', () => {
    const large = parseStrictSemver('9007199254740993.0.0');
    const next = parseStrictSemver('9007199254740994.0.0');
    expect(compareSemver(large, next)).toBeLessThan(0);
  });

  it('accepts arbitrary-length numeric core components without loss of ordering', () => {
    for (const value of ['9007199254740992.0.0', '0.9007199254740992.0', '0.0.9007199254740992']) {
      expect(() => parseStrictSemver(value)).not.toThrow();
    }
  });

  it.each([
    'v1.2.3', '1.02.3', '1.2', '1.2.3 ', '1.2.3-*', '1.2.3^4', '1.2.3~4',
    '1.2.3-01', '1.2.3..4', '1.2.3+build..two',
  ])('rejects non-strict SemVer %s', (value) => {
    expect(() => parseStrictSemver(value)).toThrow('Invalid strict SemVer 2.0.0 value');
  });

  it('matches prereleases only through an explicit same-base prerelease comparator', () => {
    const candidate = parseStrictSemver('1.2.3-beta.2');
    expect(matchesVersionRange(candidate, validateVersionRange({
      clauses: [[{ op: 'GTE', version: '1.2.3-beta.1' }]],
    }))).toBe(true);
    expect(matchesVersionRange(candidate, validateVersionRange({ clauses: [] }))).toBe(false);
  });

  it('compares arbitrary-length numeric prerelease identifiers exactly', () => {
    expect(compareSemver(parseStrictSemver('0.0.0-9007199254740993'), parseStrictSemver('0.0.0-9007199254740992'))).toBe(1);
  });

  it('normalizes hostile non-TypeError proxy failures in sameSemverBase', () => {
    const hostile = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error('hostile proxy');
      },
    }) as StrictSemver;
    expect(() => sameSemverBase(hostile, parseStrictSemver('1.0.0'))).toThrow('Invalid strict SemVer 2.0.0 value');
  });

  it('rejects unsafe or accessor-backed parsed values', () => {
    expect(() => parseStrictSemver({})).toThrow(TypeError);
    const prerelease = ['alpha'] as string[];
    const value = {
      major: 1,
      minor: 0,
      patch: 0,
      prerelease,
      build: [],
    } as StrictSemver;
    Object.defineProperty(value, 'major', { get: () => 1 });
    expect(() => compareSemver(value, parseStrictSemver('1.0.0'))).toThrow(TypeError);
    const sparse = [] as string[];
    sparse.length = 1;
    const sparseValue = { ...parseStrictSemver('1.0.0'), prerelease: sparse } as StrictSemver;
    expect(() => compareSemver(sparseValue, parseStrictSemver('1.0.0'))).toThrow(TypeError);
  });
  it('rejects forged negative-zero core components', () => {
    const value = { ...parseStrictSemver('1.0.0'), major: -0 } as StrictSemver;
    expect(() => compareSemver(value, parseStrictSemver('1.0.0'))).toThrow(TypeError);
  });
});
