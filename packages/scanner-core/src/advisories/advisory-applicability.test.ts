import { describe, expect, it } from 'vitest';
import { parseStrictSemver } from '../semantics/semver';
import { validateTargetContextV3, type TargetContextV3 } from '../semantics/target-context';
import { evaluateAdvisoryApplicability } from './advisory-applicability';
import type { AdvisoryRecordV2 } from './advisory-schema';

const makeAdvisory = (overrides: Partial<AdvisoryRecordV2>): AdvisoryRecordV2 => ({
  id: 'CVE-FIXTURE-0001',
  aliases: ['CVE-FIXTURE-0001'],
  packageName: 'n8n',
  rawAffectedRange: '>=1.0.0 <2.0.0',
  affected: { clauses: [[{ op: 'GTE', version: '1.0.0' }, { op: 'LT', version: '2.0.0' }]] },
  fixedVersions: [],
  fixedBranches: [],
  prerequisites: [],
  sourceUrl: 'https://nvd.nist.gov/vuln/detail/CVE-FIXTURE-0001',
  sourceDigest: '0'.repeat(64),
  reviewedAt: '2026-09-10',
  reviewer: 'fixture-reviewer',
  reviewState: 'ADMITTED',
  ...overrides,
});

const target = (overrides: Partial<TargetContextV3> = {}): TargetContextV3 => {
  const input: Record<string, unknown> = {
    schemaVersion: 'scanner-target-v3',
    n8nVersion: '1.5.0',
    edition: 'COMMUNITY',
    deployment: 'SELF_HOSTED',
    role: 'ADMIN',
    taskRunner: 'NATIVE',
    communityPackages: [],
    configuration: [],
    ...overrides,
  };
  if (Object.prototype.hasOwnProperty.call(overrides, 'n8nVersion') && overrides.n8nVersion === undefined) delete input.n8nVersion;
  return validateTargetContextV3(input);
};

describe('advisory applicability', () => {
  it('matches an admitted advisory only against explicit host version and prerequisites', () => {
    expect(evaluateAdvisoryApplicability(makeAdvisory({}), target())).toBe('APPLICABLE');
  });

  it('returns UNKNOWN when the host version or prerequisite is absent', () => {
    const advisory = makeAdvisory({ prerequisites: [{ key: 'edition', expected: 'cloud' }] });
    expect(evaluateAdvisoryApplicability(advisory, validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: [], configuration: [] }))).toBe('UNKNOWN');
    const cases: { override: Partial<TargetContextV3>; prerequisite: Readonly<{ key: string; expected: string }>[]; packageName?: string }[] = [
      { override: { n8nVersion: undefined }, prerequisite: [] },
      { override: { edition: 'UNKNOWN' }, prerequisite: [{ key: 'edition', expected: 'CLOUD' }] },
      { override: { deployment: 'UNKNOWN' }, prerequisite: [{ key: 'deployment', expected: 'CLOUD' }] },
      { override: { role: 'UNKNOWN' }, prerequisite: [{ key: 'role', expected: 'ADMIN' }] },
      { override: { taskRunner: 'UNKNOWN' }, prerequisite: [{ key: 'taskRunner', expected: 'NATIVE' }] },
      { override: { configuration: [] }, prerequisite: [{ key: 'configuration:allowNetwork', expected: 'ENABLED' }] },
      { override: { communityPackages: [] }, prerequisite: [], packageName: '@vendor/tool' },
    ];
    for (const testCase of cases) {
      const advisory = makeAdvisory({ packageName: testCase.packageName ?? 'n8n', prerequisites: testCase.prerequisite });
      expect(evaluateAdvisoryApplicability(advisory, target(testCase.override))).toBe('UNKNOWN');
    }
  });

  it('returns NOT_APPLICABLE for known failed prerequisites and outside ranges', () => {
    const advisory = makeAdvisory({ prerequisites: [{ key: 'edition', expected: 'CLOUD' }] });
    expect(evaluateAdvisoryApplicability(advisory, target({ edition: 'COMMUNITY' }))).toBe('NOT_APPLICABLE');
    expect(evaluateAdvisoryApplicability(advisory, target({ n8nVersion: '2.0.0' }))).toBe('NOT_APPLICABLE');
    const configurationAdvisory = makeAdvisory({ prerequisites: [{ key: 'configuration:allowNetwork', expected: 'ENABLED' }] });
    expect(evaluateAdvisoryApplicability(configurationAdvisory, target({ configuration: [{ key: 'allowNetwork', state: 'DISABLED' }] }))).toBe('NOT_APPLICABLE');
    const packageAdvisory = makeAdvisory({ prerequisites: [{ key: 'package:@vendor/tool', expected: '3.0.0' }], packageName: '@vendor/tool' });
    expect(evaluateAdvisoryApplicability(packageAdvisory, target({ communityPackages: [{ name: '@vendor/tool', version: '4.0.0' }] }))).toBe('NOT_APPLICABLE');
  });

  it('checks community package name and version without inferring from workflow nodes', () => {
    const advisory = makeAdvisory({
      packageName: '@vendor/tool',
      affected: { clauses: [[{ op: 'GTE', version: '3.0.0' }, { op: 'LT', version: '4.0.0' }]] },
    });
    expect(evaluateAdvisoryApplicability(advisory, target({ communityPackages: [{ name: '@vendor/tool', version: '3.2.0' }] }))).toBe('APPLICABLE');
    expect(evaluateAdvisoryApplicability(advisory, target({ communityPackages: [{ name: '@vendor/tool', version: '2.9.0' }] }))).toBe('NOT_APPLICABLE');
    expect(evaluateAdvisoryApplicability(advisory, target({ communityPackages: [] }))).toBe('UNKNOWN');
  });

  it('excludes explicit fixed versions even when a publisher range includes one', () => {
    const advisory = makeAdvisory({ fixedVersions: [parseStrictSemver('1.5.0')] });
    expect(evaluateAdvisoryApplicability(advisory, target())).toBe('NOT_APPLICABLE');
  });

  it('never produces APPLICABLE for withdrawn, rejected, or quarantined records', () => {
    for (const reviewState of ['WITHDRAWN', 'REJECTED', 'QUARANTINED'] as const) {
      expect(evaluateAdvisoryApplicability(makeAdvisory({ reviewState }), target())).toBe('UNKNOWN');
    }
  });
  it('returns UNKNOWN when a fixed version is malformed outside admission', () => {
    const malformedFixedVersion = { major: 1 } as AdvisoryRecordV2['fixedVersions'][number];
    expect(evaluateAdvisoryApplicability(makeAdvisory({ fixedVersions: [malformedFixedVersion] }), target())).toBe('UNKNOWN');
  });
});
