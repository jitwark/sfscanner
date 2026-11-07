import type { FindingConfidence, NormalizedWorkflowNode, ScanFinding, ScanSeverity } from './policy';
import { classifyProviderToken } from '../analyzers/secrets/provider-token-registry';
import { classifyQuotedExpressionTokens } from '../secret-classifier';
import { literalIslands } from './literal-islands';

export type SecretIndicator = {
  path: string;
  kind: string;
  indicator: 'sensitive_key' | 'sensitive_value';
  hasLiteralValue: boolean;
};

/** n8n runtime references, which make a surrounding literal a template rather than raw material. */
const RUNTIME_REFERENCE =
  /\$(?:json|node|nodeVersion|env|credentials|secrets|vars|parameter|execution|workflow|item|items|thisItem|input|binary|now|today|prevNode|runIndex|position|jmespath|if|loop|max|min|randomInt|request|response|body|data|pageCount|itemIndex|self|evaluateExpression|getWorkflowStaticData)\b/i;

const PLACEHOLDER_PREFIXES = new Set([
  'your', 'my', 'example', 'sample', 'placeholder', 'dummy', 'test', 'fake', 'changeme',
  'todo', 'insert', 'replace', 'enter', 'add',
]);
const PLACEHOLDER_WORDS = [
  ...PLACEHOLDER_PREFIXES, 'api', 'access', 'auth', 'secret', 'token', 'key', 'password', 'here', 'value',
].sort((left, right) => right.length - left.length);

/**
 * Public RFC 7235 authentication-scheme tokens. A scheme-only literal island is protocol text,
 * not credential material; any additional literal text keeps the fail-closed result.
 */
const AUTH_SCHEME_ONLY = /^(?:bearer|basic|digest|negotiate|hoba|mutual|token)$/i;

/** Expressions and conventional placeholders are not literal secret material. */
export function isNonSecretLiteral(value: string): boolean {
  const candidate = value.trim();
  if (candidate.length === 0) return true;
  if (classifyProviderToken(candidate) !== undefined) return false;
  if (classifyQuotedExpressionTokens(candidate).length > 0) return false;
  const { literals } = literalIslands(candidate);
  // Only expression-mode text may hide a literal behind a runtime-reference token; an unmarked
  // value such as `mySecret $json` is still literal text this workflow ships.
  const expressionMode = candidate.startsWith('=');
  const raw = literals.filter((island) => !(expressionMode && RUNTIME_REFERENCE.test(island)));
  if (raw.length === 0) return true;
  const material = raw.filter((island) => !AUTH_SCHEME_ONLY.test(island.trim()));
  return material.every(isPlaceholderLiteral);
}

/** Conventional placeholder forms that never carry secret material. */
function isPlaceholderLiteral(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return true;
  if (/^\$?(json|node|env|credentials|secrets|vars|parameter)\b/i.test(trimmed)) return true;
  if (/^[*x._-]+$/i.test(trimmed)) return true;
  if (/^<[^>]*>$/.test(trimmed) || /^\[[^\]]*\]$/.test(trimmed)) return true;
  return isPlaceholderPhrase(trimmed.toLowerCase());
}

/** Match the small placeholder vocabulary in one forward pass without nested quantifiers. */
function isPlaceholderPhrase(value: string): boolean {
  let offset = 0;
  let firstWord = true;

  while (offset < value.length) {
    if (!firstWord) {
      while (offset < value.length && isPlaceholderSeparator(value[offset])) offset += 1;
      if (offset === value.length) return false;
    }

    const word = PLACEHOLDER_WORDS.find((candidate) => value.startsWith(candidate, offset));
    if (!word || (firstWord && !PLACEHOLDER_PREFIXES.has(word))) return false;
    offset += word.length;
    firstWord = false;
  }

  return !firstWord;
}

function isPlaceholderSeparator(character: string | undefined): boolean {
  return character === '_' || character === '-' || (character !== undefined && /\s/.test(character));
}

export function nodeFinding(input: {
  policyId: string;
  title?: string;
  severity: ScanSeverity;
  node: NormalizedWorkflowNode;
  evidence: Record<string, unknown>;
  message: string;
  explanation?: string;
  whyItMatters?: string;
  possibleImpact?: string;
  remediation: string;
  remediationSteps?: string[];
  confidence?: FindingConfidence;
}): ScanFinding {
  return {
    policyId: input.policyId,
    title: input.title ?? input.message,
    severity: input.severity,
    location: { nodeId: input.node.id, nodeName: input.node.name },
    evidence: input.evidence,
    message: input.message,
    explanation: input.explanation ?? input.message,
    whyItMatters: input.whyItMatters ?? 'This issue can change the trust boundary, data exposure, or operational behavior of the workflow.',
    possibleImpact: input.possibleImpact ?? 'The workflow may be harder to review, monitor, or operate safely without additional controls.',
    remediation: input.remediation,
    remediationSteps: input.remediationSteps ?? [input.remediation],
    confidence: input.confidence ?? 'MEDIUM',
  };
}

export function authorizationHeaderEvidence(value: unknown): { present: boolean; literal: boolean } {
  if (Array.isArray(value)) {
    return value.reduce<{ present: boolean; literal: boolean }>((result, child) => {
      const nested = authorizationHeaderEvidence(child);
      return { present: result.present || nested.present, literal: result.literal || nested.literal };
    }, { present: false, literal: false });
  }

  if (!isRecord(value)) return { present: false, literal: false };
  let present = false;
  let literal = false;
  const name = typeof value.name === 'string' ? value.name.trim().toLowerCase() : '';
  for (const [key, child] of Object.entries(value)) {
    if (key.trim().toLowerCase() === 'authorization') {
      present = true;
      if (typeof child === 'string' && !isNonSecretLiteral(child)) literal = true;
    }
    if (typeof child === 'string' && child.trim().toLowerCase() === 'authorization') present = true;
    const nested = authorizationHeaderEvidence(child);
    present = present || nested.present;
    literal = literal || nested.literal;
  }
  if (name === 'authorization') {
    present = true;
    for (const key of ['value', 'val', 'headerValue', 'content'] as const) {
      const paired = value[key];
      if (typeof paired === 'string' && !isNonSecretLiteral(paired)) literal = true;
    }
  }
  return { present, literal };
}

// The pinned n8n-nodes-base@2.15.1 Webhook description offers exactly these three
// authenticated modes (plus `none`). `oauth2` is not an option in that version, so it
// must not be treated as authenticated; the corrected probe and plan-owned sidecar use
// this pinned enum.
//
// `validateWebhookAuthentication` (dist/nodes/Webhook/utils.js:205-289) compares the stored
// value with strict equality, never trims or case-folds it, and has no final `else`, so an
// unknown value fails open at runtime. Only an exact match may suppress WEBHOOK_EXPOSURE.
const AUTHENTICATED_WEBHOOK_METHODS: Readonly<Record<string, true>> = {
  basicAuth: true, headerAuth: true, jwtAuth: true,
};

export function hasWebhookAuthentication(parameters: Record<string, unknown>): boolean {
  const authentication = parameters.authentication;
  return typeof authentication === 'string'
    && AUTHENTICATED_WEBHOOK_METHODS[authentication] === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
