import { describe, expect, it } from 'vitest';
import { BETA_DEFAULT_PROFILE_MANIFEST } from '../capabilities/profile-manifest';
import { betaDefaultRuleCatalog, betaHardenedRuleCatalog } from '../policy/rule-catalog';
import { resolvePolicyProfile } from './profile';

describe('package-local policy profiles', () => {
  it('exposes beta-default with its catalog identity', () => {
    const result = resolvePolicyProfile('beta-default');

    expect(result).toMatchObject({
      ok: true,
      profileId: 'beta-default',
      version: 'scanner-beta-1',
      includesSourceSpans: false,
      includesJavaScriptAnalysis: false,
      includesPythonAnalysis: false,
      includesTaintAnalysis: false,
      ruleCatalog: betaDefaultRuleCatalog,
    });
    if (result.ok) {
      expect(result.createPolicies({}).map((entry) => entry.id)).toEqual(
        betaDefaultRuleCatalog.map((entry) => entry.policyId),
      );
    }
  });

  it('exposes beta-hardened as the same base plus its reviewed report-only catalog', () => {
    const result = resolvePolicyProfile('beta-hardened');

    expect(result).toMatchObject({
      ok: true,
      profileId: 'beta-hardened',
      version: 'scanner-beta-1',
      includesSourceSpans: true,
      includesJavaScriptAnalysis: true,
      includesPythonAnalysis: true,
      includesTaintAnalysis: true,
      ruleCatalog: betaHardenedRuleCatalog,
    });
    if (result.ok) expect(result.ruleCatalog).not.toBe(betaDefaultRuleCatalog);
  });

  it('exposes only the admitted beta-default capability bridge', () => {
    const admitted = resolvePolicyProfile('beta-default');
    const hardened = resolvePolicyProfile('beta-hardened');

    expect(admitted).toMatchObject({ capabilityManifest: BETA_DEFAULT_PROFILE_MANIFEST });
    if (admitted.ok) expect(typeof admitted.createCapabilityRegistry).toBe('function');
    expect(hardened).toMatchObject({ capabilityManifest: null, createCapabilityRegistry: null });
  });

  it.each(['nonexistent-profile', 'toString'])('returns a typed missing result for %s', (profileId) => {
    expect(resolvePolicyProfile(profileId)).toEqual({ ok: false, code: 'UNKNOWN_PROFILE', profileId });
  });

  it('freezes profile entries and resists singleton admission metadata mutation', () => {
    const result = resolvePolicyProfile('beta-default');

    expect(Object.isFrozen(result)).toBe(true);
    if (!result.ok) return;

    const originalProfileId = result.profileId;
    expect(Reflect.set(result, 'profileId', 'beta-hardened')).toBe(false);
    expect(result.profileId).toBe(originalProfileId);
    expect(resolvePolicyProfile('beta-default')).toBe(result);
  });
});
