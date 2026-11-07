import { describe, expect, it } from 'vitest';
import { isStrictTargetSemver } from '@hub/contracts/scanner-target-v3';
import { validateTargetContextV3 } from './target-context';

// Every rejection starts from a complete accepted v3 target and changes only the raw version.
// Matching the specific version error prevents schema rejection from making these controls vacuous.
const target = {
  schemaVersion: 'scanner-target-v3' as const, n8nVersion: '1.2.3', edition: 'COMMUNITY' as const,
  deployment: 'SELF_HOSTED' as const, role: 'OWNER' as const, taskRunner: 'NATIVE' as const,
  communityPackages: [{ name: '@scope/pkg', version: '1.2.3' }], configuration: [],
};
const invalidRawVersions = [
  '', '1', '1.2', '1.2.3.4', 'v1.2.3', 'V1.2.3', '=1.2.3', '^1.2.3', '~1.2.3',
  '>1.2.3', '>=1.2.3', '<1.2.3', '<=1.2.3', '1.x', '1.2.x', '*', 'latest', 'next',
  ' 1.2.3', '1.2.3 ', '\t1.2.3', '1.2.3\t', '1.2.3\n', '1.2.3\r\n', '\n1.2.3',
  '01.2.3', '1.02.3', '1.2.03', '-1.2.3', '+1.2.3', '1.-2.3', '1.2.-3',
  '1.2.3-', '1.2.3+', '1.2.3-01', '1.2.3-alpha.01', '1.2.3-alpha..1',
  '1.2.3-alpha_1', '1.2.3-α', '1.2.3+build_1', '1.2.3+build..two', '1.2.3+build+',
  '1.2.3+build.4+other', '1.2.3 - 2.0.0', '1.2.3 || 2.0.0', '1.2.3 2.0.0',
  '1.2.3^4', '1.2.3~4', '1.2.3-*', '1.2.3..4', '1.2.3/extra', '1.2.3\0',
  '１.2.3', '1.2.3-rc.', '1.2.3+.build',
] as const;

describe('target-v3 non-vacuous strict raw version controls', () => {
  it('pins all 55 controls and accepts the otherwise-identical valid v3 fixture', () => {
    expect(invalidRawVersions).toHaveLength(55);
    expect(new Set(invalidRawVersions).size).toBe(55);
    expect(validateTargetContextV3(target).communityPackages).toEqual(target.communityPackages);
  });

  it.each(invalidRawVersions)('rejects exact raw %j at both version boundaries', (version) => {
    expect(() => validateTargetContextV3(target)).not.toThrow();
    expect(() => validateTargetContextV3({ ...target, n8nVersion: version })).toThrow('INVALID_N8N_VERSION');
    expect(() => validateTargetContextV3({ ...target, communityPackages: [{ name: '@scope/pkg', version }] })).toThrow('INVALID_PACKAGE_VERSION');
    expect(isStrictTargetSemver(version)).toBe(false);
  });

  it('preserves valid raw prerelease/build case and both exact installed versions', () => {
    const packages = [{ name: '@scope/pkg', version: '1.2.3-RC.1+Build.7' }, { name: '@scope/pkg', version: '2.0.0' }];
    const value = validateTargetContextV3({ ...target, communityPackages: packages });
    expect(value.communityPackages).toEqual(packages);
    expect(value.contextDigest).not.toBe(validateTargetContextV3(target).contextDigest);
    for (const communityPackages of [[packages[0], packages[0]], [{ name: '@scope/pkg' }, packages[0]], [packages[0], { name: '@scope/pkg' }]]) {
      expect(() => validateTargetContextV3({ ...target, communityPackages })).toThrow('DUPLICATE_PACKAGE');
    }
  });
});
