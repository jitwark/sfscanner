/**
 * Credential patterns ported from n8n-vault-core patterns.py and cross-checked with
 * provider-token-patterns.ts.
 */

export type SecretPatternDef = {
  name: string;
  pattern: RegExp;
  keyPattern?: RegExp;
  positiveTest: { key?: string; value: string };
  negativeTest: { key?: string; value: string };
};

export const SECRET_PATTERNS: readonly SecretPatternDef[] = [
  {
    name: 'openai_api_key',
    pattern: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/,
    positiveTest: { value: 'sk-proj-12345678901234567890' },
    negativeTest: { value: 'sk-short' },
  },
  {
    name: 'anthropic_api_key',
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/,
    positiveTest: { value: 'sk-ant-api03-12345678901234567890' },
    negativeTest: { value: 'sk-ant-short' },
  },
  {
    name: 'google_api_key',
    pattern: /AIza[0-9A-Za-z_-]{35}/,
    positiveTest: { value: 'AIzaSyA1234567890123456789012345678901234' },
    negativeTest: { value: 'AIzaSyShort' },
  },
  {
    name: 'github_token',
    pattern: /(?:ghp|gho|ghu)_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_]{12,}/,
    positiveTest: { value: 'ghp_123456789012345678901234567890' },
    negativeTest: { value: 'ghp_short' },
  },
  {
    name: 'slack_token',
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/,
    positiveTest: { value: 'xoxb-1234567890-1234567890' },
    negativeTest: { value: 'xoxb-short' },
  },
  {
    name: 'aws_access_key',
    pattern: /AKIA[0-9A-Z]{16}/,
    positiveTest: { value: 'AKIAIOSFODNN7EXAMPLE' },
    negativeTest: { value: 'AKIAIOSFODNN' },
  },
  {
    name: 'stripe_api_key',
    pattern: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]{8,}/,
    positiveTest: { value: 'sk_live_1234567890abcdef' },
    negativeTest: { value: 'sk_live_short' },
  },
  {
    name: 'sendgrid_api_key',
    pattern: /SG\.[A-Za-z0-9_-]{20,}/,
    positiveTest: { value: 'SG.1234567890123456789012.1234567890123456789012345678901234567890123' },
    negativeTest: { value: 'SG.short' },
  },
  {
    name: 'twilio_key',
    pattern: /(?:AC|SK)[a-zA-Z0-9]{32}/,
    positiveTest: { value: `AC${'1234567890'.repeat(3)}12` },
    negativeTest: { value: 'AC123456' },
  },
  {
    name: 'jwt_token',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    positiveTest: { value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl' },
    negativeTest: { value: 'eyJshort.eyJshort.' },
  },
  {
    name: 'bearer_token',
    pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
    positiveTest: { value: 'Bearer mySecretToken12345' },
    negativeTest: { value: 'Bearer short' },
  },
  {
    name: 'basic_auth_url',
    pattern: /https?:\/\/[^\s:@]+:[^\s:@]+@[^\s/:]+/,
    positiveTest: { value: 'https://user:password123@example.com/api' },
    negativeTest: { value: 'https://example.com/api' },
  },
  {
    name: 'huggingface_token',
    pattern: /hf_[A-Za-z0-9]{20,}/,
    positiveTest: { value: 'hf_12345678901234567890123456' },
    negativeTest: { value: 'hf_short' },
  },
  {
    name: 'replicate_token',
    pattern: /r8_[A-Za-z0-9]{37}/,
    positiveTest: { value: 'r8_1234567890123456789012345678901234567' },
    negativeTest: { value: 'r8_short' },
  },
  {
    name: 'groq_api_key',
    pattern: /gsk_[a-zA-Z0-9]{20,}/,
    positiveTest: { value: 'gsk_12345678901234567890123456' },
    negativeTest: { value: 'gsk_short' },
  },
  {
    name: 'tavily_api_key',
    pattern: /tvly-[a-zA-Z0-9_-]{20,}/,
    positiveTest: { value: 'tvly-123456789012345678901234' },
    negativeTest: { value: 'tvly-short' },
  },
  {
    name: 'tavus_api_key',
    pattern: /tvir-[a-zA-Z0-9_-]{20,}/,
    positiveTest: { value: 'tvir-123456789012345678901234' },
    negativeTest: { value: 'tvir-short' },
  },
  {
    name: 'generic_secret_key_value',
    keyPattern: /^(?:api[_-]?key|api_key|apiKey|apikey|secret|password|passwd|pass|token|bearer|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|app[_-]?secret|webhook[_-]?secret|private[_-]?key|secret[_-]?key|master[_-]?key)$/i,
    pattern: /^[a-zA-Z0-9_\-\.\+/=]{32,}$/,
    positiveTest: { key: 'apiKey', value: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6' },
    negativeTest: { key: 'apiKey', value: 'shortValue' },
  },
];
