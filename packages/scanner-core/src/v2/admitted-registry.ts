import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { canonicalJsonBytes, canonicalizeJson } from '../canonical-json';
import { encodeIdentityTuple } from '../workflow-v2/node-edge-identity';
import { SAFE_FACT_AUTHORITY_DIGEST_V2, SAFE_FACT_EVIDENCE_MAPPINGS_V2 } from '../facts/safe-fact-registry';
import { betaHardenedRuleCatalog } from '../policy/rule-catalog';
import { RULE_PACK_DIGEST_V2 } from '../capabilities/candidate-validator';
import { BETA_DEFAULT_PROFILE_MANIFEST, computeProfileManifestDigest } from '../capabilities/profile-manifest';
import { createBetaDefaultCapabilityRegistry } from '../capabilities/beta-default';
import { createBetaDefaultPolicies } from '../policies/beta-policies';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from '../semantics/builtin-catalogue';
import { createSemanticCatalogueDigest } from '../semantics/catalogue-admission';
import { reviewedScopedSemanticsAreIntact } from '../semantics/generic-fallback';
import semanticSourceReceipts from '../../../../docs/scanner/semantic-source-receipts.json';
import type { ResolvedNodeSemanticsV2 } from '../semantics/catalogue-schema';
import type { AdmittedRuleV2, CapabilityRegistryV2, RuleCatalogueViewV2, SemanticCatalogueViewV2 } from '../capabilities/scheduler';

export const ADMITTED_PROFILE_ID = 'beta-default' as const;
export const ADMITTED_PROFILE_VERSION = '2.0.0' as const;
export const ADMITTED_ENGINE_ID = 'secureflow-scanner' as const;
export const ADMITTED_ENGINE_VERSION = '2.0.0' as const;
export const RULESET_ID_V2 = 'scanner-core-builtins' as const;
export const RULESET_VERSION_V2 = '2.0.0' as const;
export const RULESET_SIGNATURE_STATUS_V2 = 'VERIFIED' as const;
export const RULE_KEYS = Object.freeze(SAFE_FACT_EVIDENCE_MAPPINGS_V2.map(({ ruleId }) => ruleId));

const ruleById = new Map(betaHardenedRuleCatalog.map((entry) => [entry.policyId, entry]));
const authorityRules: readonly AdmittedRuleV2[] = Object.freeze(SAFE_FACT_EVIDENCE_MAPPINGS_V2.map((mapping) => {
  const catalog = ruleById.get(mapping.ruleId);
  if (!catalog) throw new TypeError(`Missing built-in rule authority: ${mapping.ruleId}`);
  return Object.freeze({
    ruleId: mapping.ruleId, revision: '1', capabilityId: mapping.ownerCapabilityId,
    effect: mapping.ownerCapabilityId === 'structural-policies' ? 'SCORING' : 'REPORT_ONLY',
    severity: catalog.defaultSeverity, confidence: catalog.defaultConfidence,
    evidenceSchemaId: mapping.evidenceSchemaId, remediationId: 'r', cweIds: Object.freeze([...catalog.cweIds]),
    owaspAgenticIds: Object.freeze([...(catalog.owaspAgenticIds ?? [])]), packDigest: RULE_PACK_DIGEST_V2,
  });
}));
const authorityRuleBody = Object.freeze(authorityRules.map(({ packDigest: _packDigest, ...rule }) => rule).sort((left, right) => left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0));

export const PROFILE_MANIFEST_DIGEST_V2 = BETA_DEFAULT_PROFILE_MANIFEST.digest;
export { RULE_PACK_DIGEST_V2 };
export const RULE_PACK_DIGEST = RULE_PACK_DIGEST_V2;
export const LIMITS_AUTHORITY_DIGEST_V2 = bytesToHex(sha256(canonicalJsonBytes(DEFAULT_SCANNER_LIMITS_V2)));
export const SEMANTIC_CATALOGUE_DIGEST_V2 = BUILTIN_SEMANTIC_CATALOGUE_V2.digest;
export const BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2 = Object.freeze({
  id: 'reviewed-gmail-message-v1', version: '1',
  digest: '2b21f771d2cf172e33e8f78e5d1deaaefc0a5e8ff45f7d9f252cb8ec321ad56a',
  sourceReceiptSha256: '2e8b7a2666cfc07c7609fdc9a2bdf01be291195a8b7da0af0f69836a180f8685',
  sourceReceiptCanonicalDigest: '965de9fabde482dd5a6bcc67299fce8c33232e78c9fdc70053ad588b0f62ba2a',
});
export const ENGINE_BUILD_DIGEST_V2 = bytesToHex(sha256(canonicalJsonBytes({
  engine: ADMITTED_ENGINE_ID, version: ADMITTED_ENGINE_VERSION, profile: ADMITTED_PROFILE_ID,
  profileVersion: ADMITTED_PROFILE_VERSION, manifest: PROFILE_MANIFEST_DIGEST_V2,
  ruleset: RULE_PACK_DIGEST_V2, facts: SAFE_FACT_AUTHORITY_DIGEST_V2, semantics: SEMANTIC_CATALOGUE_DIGEST_V2,
  scopedSemantics: BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2,
})));

export const BUILTIN_RULESET_AUTHORITY_V2 = Object.freeze({
  id: RULESET_ID_V2, version: RULESET_VERSION_V2, digest: RULE_PACK_DIGEST_V2,
  signatureStatus: RULESET_SIGNATURE_STATUS_V2,
});
export const BUILTIN_SEMANTICS_AUTHORITY_V2 = Object.freeze({
  id: BUILTIN_SEMANTIC_CATALOGUE_V2.id, version: BUILTIN_SEMANTIC_CATALOGUE_V2.version,
  digest: BUILTIN_SEMANTIC_CATALOGUE_V2.digest,
});
/** The engine's own configuration vocabulary, read by the CLI before any item runs. */
export const ADMITTED_CONFIGURATION_KEYS_V2 = BUILTIN_SEMANTIC_CATALOGUE_V2.configurationKeys;

/**
 * An empty allowlist is the no-argument path, so a scan that supplies none — or supplies `[]`, which
 * the request validator treats as absent — builds exactly the registry it built before the
 * allowlist was admitted, and its result stays byte-identical.
 */
export function createAdmittedCapabilityRegistry(approvedDomains: readonly string[] = []): CapabilityRegistryV2 {
  return approvedDomains.length === 0
    ? createBetaDefaultCapabilityRegistry()
    : createBetaDefaultCapabilityRegistry({ policies: createBetaDefaultPolicies({ approvedDomains }) });
}
export function createAdmittedRuleView(): RuleCatalogueViewV2 {
  return Object.freeze({ id: RULESET_ID_V2, version: RULESET_VERSION_V2, digest: RULE_PACK_DIGEST_V2, rules: new Map(authorityRules.map((rule) => [rule.ruleId, rule])) });
}
export function createAdmittedSemanticView(resolved: ReadonlyMap<string, ResolvedNodeSemanticsV2>): SemanticCatalogueViewV2 {
  return Object.freeze({ id: BUILTIN_SEMANTIC_CATALOGUE_V2.id, version: BUILTIN_SEMANTIC_CATALOGUE_V2.version, digest: BUILTIN_SEMANTIC_CATALOGUE_V2.digest, resolvedNodeSemantics: new Map(resolved) });
}
export function authorityIsIntact(): boolean {
  try {
    const { digest, ...manifestBody } = BETA_DEFAULT_PROFILE_MANIFEST;
    const { digest: semanticDigest, ...semanticBody } = BUILTIN_SEMANTIC_CATALOGUE_V2;
    const rulePackDigest = bytesToHex(sha256(new TextEncoder().encode(encodeIdentityTuple(['secureflow-rule-pack-v2', RULESET_VERSION_V2, SAFE_FACT_AUTHORITY_DIGEST_V2, canonicalizeJson(authorityRuleBody)]))));
    return computeProfileManifestDigest(manifestBody) === PROFILE_MANIFEST_DIGEST_V2
      && authorityRules.length === RULE_KEYS.length
      && authorityRules.every((rule, index) => rule.ruleId === RULE_KEYS[index] && rule.packDigest === RULE_PACK_DIGEST_V2)
      && rulePackDigest === RULE_PACK_DIGEST_V2
      && createSemanticCatalogueDigest(semanticBody) === semanticDigest
      && semanticDigest === SEMANTIC_CATALOGUE_DIGEST_V2
      && reviewedScopedSemanticsAreIntact(BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2.digest)
      && bytesToHex(sha256(canonicalJsonBytes(semanticSourceReceipts))) === BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2.sourceReceiptCanonicalDigest;
  } catch { return false; }
}
