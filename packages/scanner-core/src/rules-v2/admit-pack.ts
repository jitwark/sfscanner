import type { RulePackV2 } from './pack-schema';
import { validateTrustStoreV2, type TrustStoreV2 } from './trust-store';
import { verifyRulePack, type RulePackRejectionCodeV2 } from './verify-pack';

/**
 * Reserved post-v2 external-pack admission (WC-0703 preparation; no v2 caller reaches this module;
 * the CLI, the versioned config and the browser worker still refuse every external pack).
 *
 * Normative source: rule-pack-contract.md:70-74 — the unsigned-development authority "would admit only
 * a pack with zero signatures and otherwise valid content, and would force every rule to report-only;
 * it would never ignore an invalid presented signature. In v2 the option is refused outright."
 *
 * Composition, in order: a pack whose `signatures` value is not an array is never the unsigned case
 * (E1a types that shape as `RULE_PACK_SIGNATURE_MALFORMED`), and only a zero-length array takes the
 * development path; every other pack goes to `verifyRulePack`, which re-validates the store it is
 * given and decides admission. The development path cannot forgive a presented signature because it
 * is unreachable once a signature entry exists, valid or not.
 *
 * Report-only is expressed as the decision's `scoring: false`; the pack cannot carry a scoring claim
 * (`RulePackV2` rules have no severity, confidence or scoring field — scoring is scanner-owned), so
 * `scoring` is the whole authority view a caller can act on. The returned pack is the caller's pack
 * object, never a rewritten or downgraded copy.
 *
 * The store floor applies unchanged on every path: the development path validates the document
 * itself before admitting, and verification does the same, so an invalid or rolled-back store
 * admits nothing. A validated store is **not** an authenticated root — custody and version pinning
 * carry that property (E1a report §11.5), and this helper never treats a store digest as proof of
 * store authorship. The pack object itself is still the caller's type obligation, exactly as in
 * `verifyRulePack`.
 *
 * Synchronous by contract compatibility: the whole composition is synchronous, so no Promise is
 * introduced at the reserved admission boundary.
 */
export type RulePackAdmissionCodeV2 = 'RULE_PACK_UNTRUSTED' | 'RULE_PACK_INVALID';
export type RulePackAdmissionDecisionV2 = Readonly<
  | { ok: true; scoring: boolean; pack: RulePackV2 }
  | { ok: false; code: RulePackAdmissionCodeV2; reason: RulePackRejectionCodeV2 }
>;
export type RulePackAdmissionOptionsV2 = Readonly<{ allowUnsignedDevelopment: boolean }>;

/**
 * A store-level refusal is `RULE_PACK_INVALID`: the authority document an operator selected cannot be
 * used, and the refusal says nothing about the pack's signature. Every signature-level refusal is
 * `RULE_PACK_UNTRUSTED`. The E1a code travels along as `reason` so a caller never loses the cause.
 */
function refuse(reason: RulePackRejectionCodeV2): RulePackAdmissionDecisionV2 {
  const storeLevel = reason === 'TRUST_STORE_INVALID' || reason === 'TRUST_STORE_ROLLBACK';
  return Object.freeze({ ok: false as const, code: storeLevel ? ('RULE_PACK_INVALID' as const) : ('RULE_PACK_UNTRUSTED' as const), reason });
}

export function admitPack(
  pack: RulePackV2,
  trustStore: TrustStoreV2,
  options: RulePackAdmissionOptionsV2,
): RulePackAdmissionDecisionV2 {
  const unsigned = Array.isArray(pack.signatures) && pack.signatures.length === 0;
  if (unsigned && options?.allowUnsignedDevelopment === true) {
    const admitted = validateTrustStoreV2(trustStore);
    if (!admitted.ok) return refuse(admitted.code);
    return Object.freeze({ ok: true as const, scoring: false, pack });
  }
  const verdict = verifyRulePack(pack, trustStore);
  if (!verdict.ok) return refuse(verdict.code);
  return Object.freeze({ ok: true as const, scoring: true, pack });
}
