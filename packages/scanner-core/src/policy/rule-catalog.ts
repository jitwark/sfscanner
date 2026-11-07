import type { FindingConfidence, PolicyEffect, ScanSeverity } from './policy';

export type RuleCatalogEntry = {
  policyId: string;
  defaultSeverity: ScanSeverity;
  defaultConfidence: FindingConfidence;
  precision: 'HIGH' | 'MEDIUM' | 'LOW';
  policyEffect: PolicyEffect;
  curationAction: 'NONE' | 'REVIEW';
  serveAction: 'DISPLAY' | 'HIDE';
  /** CWE identifiers (`CWE-###`) this rule's finding maps to. See docs/scanner/policy-inventory.md
   *  for the reviewed rationale behind each mapping, including the ones this catalog deliberately
   *  narrows or rejects. Empty only for a policy ID listed in `RULES_WITHOUT_CWE`. */
  cweIds: readonly string[];
  /** OWASP Agentic Top 10 category names. Only the two agentic rules carry this; every other
   *  rule leaves it undefined rather than an empty array, so "not agentic" and "agentic with an
   *  unresolved mapping" stay distinguishable. */
  owaspAgenticIds?: readonly string[];
};

/**
 * Policy IDs with no CWE mapping, on purpose, not by omission. `UNAPPROVED_DOMAIN` was reviewed
 * against CWE-918 (SSRF) and that mapping was rejected: SSRF requires an attacker-influenced
 * destination, but this rule fires on any URL outside an allowlist, including one hardcoded by
 * the workflow's own author with no external input involved. CWE-918 is reserved for
 * `TAINTED_REQUEST_URL`, the rule with an actual tainted-destination claim. See the `[^domain]`
 * footnote in docs/scanner/policy-inventory.md for the full rationale.
 */
export const RULES_WITHOUT_CWE = ['UNAPPROVED_DOMAIN'] as const;

const betaRule = (
  policyId: string,
  defaultSeverity: ScanSeverity,
  defaultConfidence: FindingConfidence,
  precision: RuleCatalogEntry['precision'],
  cweIds: readonly string[],
): RuleCatalogEntry => ({
  policyId,
  defaultSeverity,
  defaultConfidence,
  precision,
  policyEffect: 'LEGACY_SCORE',
  curationAction: 'NONE',
  serveAction: 'DISPLAY',
  cweIds,
});

export const betaDefaultRuleCatalog: readonly RuleCatalogEntry[] = [
  betaRule('N8N_EXECUTE_COMMAND', 'CRITICAL', 'HIGH', 'HIGH', ['CWE-78']),
  betaRule('N8N_CODE_NODE', 'LOW', 'HIGH', 'HIGH', ['CWE-94']),
  // Literal Authorization values are a hardcoded credential (CWE-798); expression/credential-
  // driven values that still leaked as a raw header are an insufficiently protected transmission
  // (CWE-522). Both apply to this rule depending on evidence shape, so both are catalogued.
  betaRule('RAW_AUTH_HEADER', 'HIGH', 'MEDIUM', 'MEDIUM', ['CWE-798', 'CWE-522']),
  betaRule('RAW_SECRET_INDICATOR', 'HIGH', 'MEDIUM', 'MEDIUM', ['CWE-798']),
  betaRule('UNAPPROVED_DOMAIN', 'MEDIUM', 'HIGH', 'HIGH', []),
  betaRule('UNKNOWN_NODE_PACKAGE', 'LOW', 'MEDIUM', 'MEDIUM', ['CWE-1357']),
  betaRule('WEBHOOK_EXPOSURE', 'MEDIUM', 'MEDIUM', 'MEDIUM', ['CWE-306']),
];

const reportOnlyRule = (
  policyId: string,
  defaultSeverity: ScanSeverity,
  defaultConfidence: FindingConfidence,
  precision: RuleCatalogEntry['precision'],
  cweIds: readonly string[],
  owaspAgenticIds?: readonly string[],
): RuleCatalogEntry => ({
  policyId,
  defaultSeverity,
  defaultConfidence,
  precision,
  policyEffect: 'REPORT_ONLY',
  curationAction: 'REVIEW',
  serveAction: 'DISPLAY',
  cweIds,
  ...(owaspAgenticIds ? { owaspAgenticIds } : {}),
});

export const TAINT_POLICY_IDS = [
  'TAINTED_COMMAND',
  'TAINTED_SQL_QUERY',
  'TAINTED_REQUEST_URL',
  'TAINTED_FILE_PATH',
  'TAINTED_CODE_INPUT',
  'TAINTED_REQUEST_HEADER',
  'TAINTED_AI_PROMPT',
  'AI_AGENT_UNGATED_TOOL',
] as const;

export type TaintPolicyId = (typeof TAINT_POLICY_IDS)[number];

export const betaHardenedRuleCatalog: readonly RuleCatalogEntry[] = [
  ...betaDefaultRuleCatalog,
  // CWE-95 ("Eval Injection") precisely fits only this rule's EVAL/FUNCTION_CONSTRUCTOR
  // indicators; CHILD_PROCESS_* is closer to CWE-78 and FILESYSTEM_ACCESS to CWE-73. One CWE per
  // policy ID is a simplification of the eight indicators this rule reports under; see the
  // `[^js]`/`[^py]` footnotes in docs/scanner/policy-inventory.md.
  reportOnlyRule('JAVASCRIPT_DYNAMIC_EXECUTION', 'HIGH', 'HIGH', 'HIGH', ['CWE-95']),
  reportOnlyRule('PYTHON_DYNAMIC_EXECUTION', 'HIGH', 'MEDIUM', 'MEDIUM', ['CWE-95']),
  reportOnlyRule('TAINTED_COMMAND', 'CRITICAL', 'MEDIUM', 'MEDIUM', ['CWE-78']),
  reportOnlyRule('TAINTED_SQL_QUERY', 'HIGH', 'MEDIUM', 'MEDIUM', ['CWE-89']),
  reportOnlyRule('TAINTED_REQUEST_URL', 'HIGH', 'MEDIUM', 'MEDIUM', ['CWE-918']),
  reportOnlyRule('TAINTED_FILE_PATH', 'HIGH', 'MEDIUM', 'MEDIUM', ['CWE-22']),
  reportOnlyRule('TAINTED_CODE_INPUT', 'HIGH', 'MEDIUM', 'MEDIUM', ['CWE-94']),
  reportOnlyRule('TAINTED_REQUEST_HEADER', 'MEDIUM', 'MEDIUM', 'MEDIUM', ['CWE-113']),
  // No CWE is dedicated to LLM prompt injection; CWE-77 ("Command Injection") is the nearest
  // structural analogy (untrusted data reaching an interpreter that blends instructions and
  // data). OWASP Agentic's "Prompt Injection" is the precise, purpose-built taxonomy tag and
  // should be treated as primary; CWE-77 is a bridge for CWE-only tooling.
  reportOnlyRule('TAINTED_AI_PROMPT', 'MEDIUM', 'LOW', 'LOW', ['CWE-77'], ['Prompt Injection']),
  // CWE-269 (Improper Privilege Management) frames the agent as holding privilege it should not
  // autonomously exercise; the alternative CWE-862 (Missing Authorization) was reviewed and is
  // also defensible, but the OWASP Agentic "Excessive Agency" pairing does the precise work
  // either way, so CWE-269 is kept per docs/scanner/policy-inventory.md.
  reportOnlyRule('AI_AGENT_UNGATED_TOOL', 'MEDIUM', 'LOW', 'LOW', ['CWE-269'], ['Excessive Agency']),
];
