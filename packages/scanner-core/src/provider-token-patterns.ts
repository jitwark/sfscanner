/**
 * Provider token shapes shared by scanner classification and evidence redaction.
 *
 * Bodies are intentionally unanchored. Classifiers wrap them as complete values,
 * while redaction finds a token inside arbitrary text.
 */
export type ProviderTokenSurface = 'classify' | 'redact';

export type ProviderTokenProvenance =
  | { kind: 'VENDOR_DOCS'; url: string }
  | { kind: 'FIRST_PARTY'; ref: string };

export type ProviderTokenPattern = {
  kind: string;
  body: string;
  flags: '' | 'i';
  redactionBoundary?: 'start' | 'both';
  surfaces: readonly ProviderTokenSurface[];
  provenance: ProviderTokenProvenance;
  canary: { positive: string; nearMiss: string };
};

export const PROVIDER_TOKEN_PATTERNS = [
  {
    kind: 'bearer token',
    body: 'Bearer[ \t]+[A-Za-z0-9._~+/=-]{8,}',
    flags: 'i',
    redactionBoundary: 'start',
    surfaces: ['classify', 'redact'],
    provenance: { kind: 'VENDOR_DOCS', url: 'https://www.rfc-editor.org/rfc/rfc6750' },
    canary: { positive: 'Bearer opaque-token-value-123', nearMiss: 'Bearer short' },
  },
  {
    kind: 'basic auth',
    body: 'Basic[ \t]+[A-Za-z0-9+/=-]{8,}',
    flags: 'i',
    redactionBoundary: 'start',
    surfaces: ['classify', 'redact'],
    provenance: { kind: 'VENDOR_DOCS', url: 'https://www.rfc-editor.org/rfc/rfc7617' },
    canary: { positive: 'Basic YWJjZGVmZw==', nearMiss: 'Basic short' },
  },
  {
    kind: 'Stripe API key',
    body: 'sk_(?:live|test)_[A-Za-z0-9_]{8,}',
    flags: '',
    surfaces: ['classify', 'redact'],
    provenance: { kind: 'VENDOR_DOCS', url: 'https://docs.stripe.com/keys' },
    canary: { positive: 'sk_live_12345678', nearMiss: 'sk_live_1234567' },
  },
  {
    kind: 'Google API key',
    body: 'AIza[0-9A-Za-z_-]{35}',
    flags: '',
    surfaces: ['classify', 'redact'],
    provenance: { kind: 'VENDOR_DOCS', url: 'https://cloud.google.com/docs/authentication/api-keys' },
    canary: { positive: `AIza${'A'.repeat(35)}`, nearMiss: `AIza${'A'.repeat(34)}` },
  },
  {
    kind: 'AWS access key',
    body: '(?:AKIA|ASIA)[0-9A-Z]{16}',
    flags: '',
    surfaces: ['classify', 'redact'],
    provenance: { kind: 'VENDOR_DOCS', url: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html' },
    canary: { positive: `AKIA${'A'.repeat(16)}`, nearMiss: `AKIA${'A'.repeat(15)}` },
  },
  {
    kind: 'Slack token',
    body: 'xox[baprs]-[A-Za-z0-9-]{10,}',
    flags: '',
    surfaces: ['classify', 'redact'],
    provenance: { kind: 'VENDOR_DOCS', url: 'https://api.slack.com/authentication/token-types' },
    canary: { positive: 'xoxb-1234567890', nearMiss: 'xoxb-123456789' },
  },
  {
    kind: 'GitHub token',
    // GitHub documents token types by prefix, not complete grammars. These
    // minimum shapes are local precision heuristics informed by its examples.
    // Example bodies: https://docs.github.com/en/rest/credentials/revoke.
    // For ghs_, use GitHub's opaque matcher for stateful and stateless formats;
    // see https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header/.
    body: '(?:(?:ghp|gho|ghu)_[A-Za-z0-9_]{36,}(?![A-Za-z0-9_.-])|ghr_[A-Za-z0-9_]{76,}(?![A-Za-z0-9_.-])|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59,}(?![A-Za-z0-9_.-])|ghs_[A-Za-z0-9._-]{36,})',
    flags: '',
    surfaces: ['classify', 'redact'],
    provenance: { kind: 'VENDOR_DOCS', url: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github' },
    canary: { positive: `ghp_${'A'.repeat(36)}`, nearMiss: `ghp_${'A'.repeat(35)}` },
  },
  {
    kind: 'JWT',
    body: 'eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+',
    flags: '',
    surfaces: ['classify', 'redact'],
    provenance: { kind: 'VENDOR_DOCS', url: 'https://www.rfc-editor.org/rfc/rfc7519' },
    canary: { positive: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl', nearMiss: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' },
  },
  {
    kind: 'Anthropic API key',
    body: 'sk-ant-[A-Za-z0-9_-]{20,}',
    flags: '',
    surfaces: ['classify', 'redact'],
    provenance: { kind: 'VENDOR_DOCS', url: 'https://docs.anthropic.com/en/api/getting-started' },
    canary: { positive: `sk-ant-api03-${'A'.repeat(20)}`, nearMiss: `sk-ant-api03-${'A'.repeat(13)}` },
  },
  {
    kind: 'OpenAI API key',
    body: 'sk-(?!ant-)[A-Za-z0-9_-]{20,}',
    flags: '',
    surfaces: ['classify', 'redact'],
    provenance: { kind: 'VENDOR_DOCS', url: 'https://platform.openai.com/docs/api-reference/authentication' },
    canary: { positive: `sk-proj-${'A'.repeat(20)}`, nearMiss: `sk-proj-${'A'.repeat(14)}` },
  },
  {
    kind: 'Hugging Face token',
    body: 'hf_[A-Za-z0-9]{20,}',
    flags: '',
    surfaces: ['classify', 'redact'],
    provenance: { kind: 'VENDOR_DOCS', url: 'https://huggingface.co/docs/hub/security-tokens' },
    canary: { positive: `hf_${'A'.repeat(20)}`, nearMiss: `hf_${'A'.repeat(19)}` },
  },
  {
    kind: 'Replicate API token',
    body: 'r8_[A-Za-z0-9]{37}',
    flags: '',
    surfaces: ['classify', 'redact'],
    provenance: { kind: 'VENDOR_DOCS', url: 'https://replicate.com/docs/topics/security/api-tokens' },
    canary: { positive: `r8_${'A'.repeat(37)}`, nearMiss: `r8_${'A'.repeat(36)}` },
  },
  {
    kind: 'SecureFlow API key',
    body: 'sfk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9_-]{8,16}\\.[A-Za-z0-9_-]{32,128}(?![A-Za-z0-9_-])',
    flags: 'i',
    redactionBoundary: 'start',
    surfaces: ['redact'],
    provenance: { kind: 'FIRST_PARTY', ref: 'src/auth/api-keys.ts:139-141' },
    canary: {
      positive: `sfk_22222222-2222-4222-8222-222222222222_AbCdEf12345.${'s'.repeat(43)}`,
      nearMiss: `sfk_22222222-2222-4222-8222-222222222222_AbCdEf12345.${'s'.repeat(31)}`,
    },
  },
  {
    kind: 'Stripe restricted key',
    body: 'rk_(?:live|test)_[A-Za-z0-9_]{8,}',
    flags: '',
    surfaces: ['classify', 'redact'],
    provenance: { kind: 'VENDOR_DOCS', url: 'https://docs.stripe.com/keys#limit-access' },
    canary: { positive: 'rk_live_12345678', nearMiss: 'rk_live_1234567' },
  },
] as const satisfies readonly ProviderTokenPattern[];

export function classifierPattern(entry: ProviderTokenPattern): RegExp {
  return new RegExp(`^(?:${entry.body})$`, entry.flags);
}

export function redactionPattern(entry: ProviderTokenPattern): RegExp {
  const suffix = entry.redactionBoundary === 'start' ? '' : '\\b';
  return new RegExp(`\\b(?:${entry.body})${suffix}`, `${entry.flags}g`);
}
