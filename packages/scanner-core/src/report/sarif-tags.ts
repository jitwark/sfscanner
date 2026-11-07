import { betaDefaultRuleCatalog, betaHardenedRuleCatalog, type RuleCatalogEntry } from '../policy/rule-catalog';

/**
 * SARIF `properties.tags` for a rule's CWE and OWASP Agentic metadata.
 *
 * This lives in scanner-core, not beside an emitter, because there are two
 * emitters — the browser report and the CLI — and only one of them had the tags
 * when they were written separately. The same finding carried its CWE in the
 * place a person reads it and lost it in the place a machine reads it.
 *
 * The CWE form matters. GitHub code scanning surfaces the CWE badge for the
 * `external/cwe/cwe-###` tag that CodeQL emits, zero-padded to three digits; a
 * plain `CWE-78` string is accepted, displayed nowhere, and looks correct in a
 * diff. There is no equivalent published convention for the OWASP Agentic Top
 * 10, so that tag is a readable slug and is not claimed to do anything in the
 * GitHub UI.
 */
const ruleByPolicyId: ReadonlyMap<string, RuleCatalogEntry> = new Map(
  [...betaDefaultRuleCatalog, ...betaHardenedRuleCatalog].map((rule) => [rule.policyId, rule]),
);

export const RULES_DOCUMENTATION_URI = 'https://github.com/jitwark/n8n-Secureflow/blob/main/docs/scanner/policy-inventory.md';

/** GitHub preserves the underscores in the per-rule `### \`RULE_ID\`` headings. */
export function sarifHelpUriFor(policyId: string): string {
  return `${RULES_DOCUMENTATION_URI}#${policyId.toLowerCase()}`;
}

export function cweTag(cweId: string): string {
  return `external/cwe/cwe-${cweId.slice('CWE-'.length).padStart(3, '0')}`;
}

export function owaspAgenticTag(category: string): string {
  return `owasp-agentic/${category.toLowerCase().replace(/\s+/g, '-')}`;
}

/**
 * Tags for a policy ID, or `undefined` when there are none.
 *
 * `undefined` rather than `[]` on purpose, in both the unknown-policy case and
 * the deliberately-unmapped one (`UNAPPROVED_DOMAIN`). An empty `tags` array in
 * a published SARIF document reads as "reviewed, and no CWE applies", which is
 * a claim; absence is not.
 */
export function sarifTagsFor(policyId: string): string[] | undefined {
  const rule = ruleByPolicyId.get(policyId);
  if (!rule) return undefined;
  const tags = [...rule.cweIds.map(cweTag), ...(rule.owaspAgenticIds ?? []).map(owaspAgenticTag)];
  return tags.length > 0 ? tags : undefined;
}
