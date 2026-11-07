import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
export const SCAN_CONFIG_SCHEMA_V2 = 'n8n-scan-config-v2' as const;
export type ScanFormatV2 = 'json' | 'ndjson' | 'sarif' | 'table';
export type ScanSeverityV2 = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type ScanConfigV2 = Readonly<{
  schemaVersion: typeof SCAN_CONFIG_SCHEMA_V2;
  format?: ScanFormatV2;
  profile?: string;
  output?: string;
  inputs?: readonly string[];
  configPath?: string;
  failOn?: ScanSeverityV2;
  requireComplete?: boolean;
  concurrency?: number;
  rules?: string;
  catalogue?: string;
  limits?: string;
  target?: string;
  include?: readonly string[];
  exclude?: readonly string[];
  approvedDomains?: readonly string[];
  allowUnsignedDevelopmentRules?: boolean;
  noColor?: boolean;
}>;

export const ADMITTED_PROFILE_V2 = Object.freeze({ id: 'beta-default', version: '2.0.0', digest: '3ca5d69db2554383e22c44afe507cc98e381ea58a7e42aaac0ee8f7497fb4f44' });

/**
 * The profile spellings a caller may write, and the one place they are listed. Both the
 * config loader and the MCP tool read this, so a profile cannot be admitted on one
 * surface and refused on the other; the bare id and its `id@version` pin are the same
 * admission, and both canonicalize to `ADMITTED_PROFILE_V2.id`.
 */
export const ADMITTED_PROFILE_SPECIFIERS_V2: readonly string[] = Object.freeze([
  ADMITTED_PROFILE_V2.id,
  `${ADMITTED_PROFILE_V2.id}@${ADMITTED_PROFILE_V2.version}`,
]);

export function isAdmittedProfileSpecifierV2(value: unknown): value is string {
  return typeof value === 'string' && ADMITTED_PROFILE_SPECIFIERS_V2.includes(value);
}
export const BUILTIN_AUTHORITIES_V2 = Object.freeze({
  profile: ADMITTED_PROFILE_V2,
  rules: Object.freeze({ id: 'scanner-core-builtins', version: '2.0.0', digest: '30bdc8343582b6a4efc13538d3475db87d07fa28bea4027f9e93b813213fd510', signatureStatus: 'VERIFIED' as const }),
  semantics: Object.freeze({ id: 'scanner-core-builtins', version: '2.2.0', digest: '58419339dcf99ed398d2955282662e6f6d37208f62393cafb56818d4a38182d7' }),
  limits: Object.freeze({ schemaVersion: 'scanner-limits-v2' as const, digest: 'fca787753ca88f71cf0d174427f4ac730a7aef1c823aaf73aa1ea72af92b4077' }),
});
export const PROFILE_MANIFEST_DIGEST_V2 = ADMITTED_PROFILE_V2.digest;
export const BUILTIN_RULESET_AUTHORITY_V2 = BUILTIN_AUTHORITIES_V2.rules;
export const BUILTIN_SEMANTICS_AUTHORITY_V2 = BUILTIN_AUTHORITIES_V2.semantics;
export const BUILTIN_LIMITS_AUTHORITY_V2 = BUILTIN_AUTHORITIES_V2.limits;
export const RULE_PACK_DIGEST_V2 = BUILTIN_RULESET_AUTHORITY_V2.digest;
export const SEMANTIC_CATALOGUE_DIGEST_V2 = BUILTIN_SEMANTICS_AUTHORITY_V2.digest;
/** Detached literals: parity checks must detect drift rather than importing live core pins. */
export const BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2 = Object.freeze({
  id: 'reviewed-gmail-message-v1', version: '1',
  digest: '2b21f771d2cf172e33e8f78e5d1deaaefc0a5e8ff45f7d9f252cb8ec321ad56a',
  sourceReceiptSha256: '2e8b7a2666cfc07c7609fdc9a2bdf01be291195a8b7da0af0f69836a180f8685',
  sourceReceiptCanonicalDigest: '965de9fabde482dd5a6bcc67299fce8c33232e78c9fdc70053ad588b0f62ba2a',
});

/**
 * One tool identity for every machine surface: the JSON/NDJSON scan envelopes and the
 * rules/explain/profiles metadata documents. The digest folds the admitted engine, profile,
 * ruleset, and semantics authorities, so a re-pin moves every surface together instead of
 * leaving a frozen literal behind on one of them.
 */
export const CLI_VERSION_V2 = '0.1.0' as const;
export type CliToolIdentityV2 = Readonly<{ name: 'n8n-scan'; version: string; buildDigest: string }>;
export const CLI_TOOL_V2: CliToolIdentityV2 = Object.freeze({
  name: 'n8n-scan',
  version: CLI_VERSION_V2,
  buildDigest: createHash('sha256').update(canonicalizeJson({
    engine: 'secureflow-scanner', version: '2.0.0', profile: ADMITTED_PROFILE_V2,
    ruleset: BUILTIN_RULESET_AUTHORITY_V2.digest, semantics: BUILTIN_SEMANTICS_AUTHORITY_V2.digest,
    scopedSemantics: BUILTIN_SCOPED_SEMANTICS_AUTHORITY_V2,
  })).digest('hex'),
});

export const DEFAULT_SCAN_CONFIG_V2: ScanConfigV2 = Object.freeze({
  schemaVersion: SCAN_CONFIG_SCHEMA_V2,
  format: 'json', profile: ADMITTED_PROFILE_V2.id, failOn: 'INFO', requireComplete: false, concurrency: 1,
  rules: 'builtin', catalogue: 'builtin', limits: 'builtin',
  include: Object.freeze(['**/*.json']), exclude: Object.freeze(['.git/**', 'node_modules/**']),
  approvedDomains: Object.freeze([]),
  allowUnsignedDevelopmentRules: false, noColor: false,
});

export const SCAN_CONFIG_V2_FIELDS = Object.freeze([
  'schemaVersion', 'format', 'profile', 'output', 'inputs', 'configPath', 'failOn', 'requireComplete', 'concurrency',
  'rules', 'catalogue', 'limits', 'target', 'include', 'exclude', 'approvedDomains',
  'allowUnsignedDevelopmentRules', 'noColor',
] as const);
export const SCAN_CONFIG_V2_MAX_STRING = 4096;
export const SCAN_CONFIG_V2_MAX_PATTERNS = 1024;
export const SCAN_CONFIG_V2_MAX_CONCURRENCY = 16;
export const SCAN_CONFIG_V2_MAX_DOMAINS = 1_000;
export const DOMAIN_V2 = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
export function isApprovedDomainV2(value: unknown): value is string {
  return typeof value === 'string' && DOMAIN_V2.test(value);
}
