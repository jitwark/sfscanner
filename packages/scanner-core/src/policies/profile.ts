import type { ScanPolicy } from '../policy/policy';
import {
  betaDefaultRuleCatalog,
  betaHardenedRuleCatalog,
  type RuleCatalogEntry,
} from '../policy/rule-catalog';
import { createBetaDefaultCapabilityRegistry } from '../capabilities/beta-default';
import { BETA_DEFAULT_PROFILE_MANIFEST, type ProfileManifestV2 } from '../capabilities/profile-manifest';
import type { CapabilityRegistryV2 } from '../capabilities/scheduler';
import { createBetaDefaultPolicies, type BetaPolicyOptions } from './beta-policies';
import { SCANNER_VERSION } from '../scanner-version';

export type PolicyProfileId = 'beta-default' | 'beta-hardened';

export type PolicyProfileEntry = Readonly<{
  ok: true;
  profileId: PolicyProfileId;
  version: typeof SCANNER_VERSION;
  createPolicies: (options?: BetaPolicyOptions) => ScanPolicy[];
  ruleCatalog: readonly RuleCatalogEntry[];
  includesSourceSpans: boolean;
  includesJavaScriptAnalysis: boolean;
  includesPythonAnalysis: boolean;
  includesTaintAnalysis: boolean;
  capabilityManifest: ProfileManifestV2 | null;
  createCapabilityRegistry: (() => CapabilityRegistryV2) | null;
}>;

export type PolicyProfileMissing = {
  ok: false;
  code: 'UNKNOWN_PROFILE';
  profileId: string;
};

export type PolicyProfileResult = PolicyProfileEntry | PolicyProfileMissing;

const registry = Object.create(null) as Record<string, PolicyProfileEntry>;

registry['beta-default'] = Object.freeze({
  ok: true,
  profileId: 'beta-default',
  version: SCANNER_VERSION,
  createPolicies: createBetaDefaultPolicies,
  ruleCatalog: betaDefaultRuleCatalog,
  includesSourceSpans: false,
  includesJavaScriptAnalysis: false,
  includesPythonAnalysis: false,
  includesTaintAnalysis: false,
  capabilityManifest: BETA_DEFAULT_PROFILE_MANIFEST,
  createCapabilityRegistry: () => createBetaDefaultCapabilityRegistry(),
});

registry['beta-hardened'] = Object.freeze({
  ...registry['beta-default'],
  profileId: 'beta-hardened',
  includesSourceSpans: true,
  includesJavaScriptAnalysis: true,
  includesPythonAnalysis: true,
  includesTaintAnalysis: true,
  ruleCatalog: betaHardenedRuleCatalog,
  capabilityManifest: null,
  createCapabilityRegistry: null,
});

Object.freeze(registry);

export function resolvePolicyProfile(profileId: string): PolicyProfileResult {
  const entry = registry[profileId];
  if (entry) return entry;
  return { ok: false, code: 'UNKNOWN_PROFILE', profileId };
}
