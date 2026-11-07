import type { AdmittedRuleV2 } from '../capabilities/scheduler';

/**
 * The admitted rule catalogue is the only authority for what a rule is.
 *
 * A rule id that is not in the admitted catalogue is never neutral. It is either a rule that
 * would have been scored or one that would only have been reported, and those are not the same
 * failure: a scoring unknown must fail closed — the finding is refused, the owning capability is
 * refused, and the run cannot publish an assessment — while a report-only unknown may degrade the
 * run and let the assessment stand without that rule.
 *
 * The burden of proof is on "report-only". Only a declared, non-required owner proves it, because
 * a capability becomes required/scoring only in a new admitted profile version
 * (`core-registry-contracts.md`). An id whose owner cannot be established — a finding at the result
 * boundary, a pack body, a synthetic catalogue lookup — is treated as scoring.
 *
 * This module is the reason those rules cannot drift: the case, its registry code, and the
 * fields the catalogue owns are declared once here and consumed by the pack admission boundary,
 * the scheduler, the analyzer adapter, and the result composer.
 */
export type UnknownRuleCaseV2 = 'SCORING' | 'REPORT_ONLY';

/** The closed-registry codes the two cases map to (`diagnostic-and-exit-registry.md`). */
export const UNKNOWN_RULE_DIAGNOSTIC_V2 = Object.freeze({
  SCORING: 'UNKNOWN_SCORING_RULE',
  REPORT_ONLY: 'UNKNOWN_REPORT_ONLY_RULE',
} as const);
export type UnknownRuleDiagnosticCodeV2 = (typeof UNKNOWN_RULE_DIAGNOSTIC_V2)[UnknownRuleCaseV2];

/**
 * The identity fields the admitted catalogue owns. A rule body, a safe fact, or a caller may
 * repeat them; none of them may set them.
 */
export const RULE_AUTHORITY_FIELDS_V2 = Object.freeze([
  'revision', 'capabilityId', 'effect', 'severity', 'confidence', 'evidenceSchemaId', 'remediationId',
] as const);
export type RuleAuthorityFieldV2 = (typeof RULE_AUTHORITY_FIELDS_V2)[number];
export type RuleAuthorityClaimV2 = Readonly<Partial<Record<RuleAuthorityFieldV2, string>>>;

/** A capability that declares rules, and therefore an owner an unknown id can be attributed to. */
export type UnknownRuleOwnerV2 = Readonly<{ required: boolean }>;

/**
 * Which unknown case an id is. Every boundary asks this one question, so the answer lives once:
 * only a declared, non-required owner makes an unknown id report-only.
 */
export function unknownRuleCaseV2(owner: UnknownRuleOwnerV2 | undefined): UnknownRuleCaseV2 {
  return owner !== undefined && owner.required === false ? 'REPORT_ONLY' : 'SCORING';
}

/** True when every field the claim repeats is the admitted value. A claim may omit, never override. */
export function ruleAuthorityMatchesV2(rule: AdmittedRuleV2, claim: RuleAuthorityClaimV2): boolean {
  for (const field of RULE_AUTHORITY_FIELDS_V2) {
    const claimed = claim[field];
    if (claimed !== undefined && claimed !== rule[field]) return false;
  }
  return true;
}

/**
 * Read an admitted rule from a catalogue. Real `Map` instances and the scheduler's frozen
 * immutable map view are the only admitted shapes; anything else yields no rule rather than a
 * caller-defined lookup.
 */
export function admittedRuleV2(rules: ReadonlyMap<string, AdmittedRuleV2>, ruleId: string): AdmittedRuleV2 | undefined {
  if (rules instanceof Map && Object.getPrototypeOf(rules) === Map.prototype) return Map.prototype.get.call(rules, ruleId);
  const descriptor = Object.getOwnPropertyDescriptor(rules, 'get');
  if (Object.getPrototypeOf(rules) !== null || !Object.isFrozen(rules) || descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') return undefined;
  return (descriptor.value as (key: string) => AdmittedRuleV2 | undefined).call(rules, ruleId);
}

export type RuleResolutionV2 = Readonly<
  | { ok: true; rule: AdmittedRuleV2 }
  | { ok: false; ruleId: string; case: UnknownRuleCaseV2; diagnosticCode: UnknownRuleDiagnosticCodeV2 }
>;

export function resolveRuleAuthorityV2(rules: ReadonlyMap<string, AdmittedRuleV2>, ruleId: string, owner?: UnknownRuleOwnerV2): RuleResolutionV2 {
  const rule = admittedRuleV2(rules, ruleId);
  if (rule !== undefined) return Object.freeze({ ok: true as const, rule });
  const ruleCase = unknownRuleCaseV2(owner);
  return Object.freeze({ ok: false as const, ruleId, case: ruleCase, diagnosticCode: UNKNOWN_RULE_DIAGNOSTIC_V2[ruleCase] });
}

export type DeclaredRulesResolutionV2 = Readonly<
  | { ok: true; rules: ReadonlyMap<string, AdmittedRuleV2> }
  | { ok: false; ruleId: string; case: UnknownRuleCaseV2; diagnosticCode: UnknownRuleDiagnosticCodeV2 }
>;

/**
 * Resolve every rule a capability declares. A capability may not run against a catalogue that is
 * missing a rule it declares: the first unknown id decides the case for the whole declaration.
 */
export function resolveDeclaredRulesV2(declared: readonly string[], rules: ReadonlyMap<string, AdmittedRuleV2>, owner: UnknownRuleOwnerV2): DeclaredRulesResolutionV2 {
  const resolved = new Map<string, AdmittedRuleV2>();
  for (const ruleId of declared) {
    const resolution = resolveRuleAuthorityV2(rules, ruleId, owner);
    if (!resolution.ok) return resolution;
    resolved.set(ruleId, resolution.rule);
  }
  return Object.freeze({ ok: true as const, rules: resolved });
}
