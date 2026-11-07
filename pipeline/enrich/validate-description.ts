import type { FactPacket } from './facts';
import { findUnverifiableClaim, type ResilienceFacts } from './unverifiable-claims';
import { MAX_GRADE, readability } from './readability';

export type ValidationErrorCode =
  | 'SUMMARY_LENGTH_INVALID'
  | 'DESCRIPTION_LENGTH_INVALID'
  | 'CONTAINS_URL'
  | 'CONTAINS_LICENCE'
  | 'CONTAINS_SECURITY_VERDICT'
  | 'CONTAINS_MARKDOWN'
  | 'UNAUTHORIZED_INTEGRATION'
  | 'DURATION_CLAIM'
  | 'COST_CLAIM'
  | 'UNGROUNDED_RESILIENCE_CLAIM'
  | 'FILLER_PHRASE'
  | 'READABILITY_TOO_HIGH';

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string; code: ValidationErrorCode };

const FORBIDDEN_LICENCES = /\b(MIT|Apache|GPL|BSD|ISC|CC0|Unlicense|proprietary)\b/i;
const FORBIDDEN_VERDICTS = /\b(secure|insecure|safe|unsafe|vulnerable|malicious|trusted)\b/i;
const URL_PATTERN = /(https?:\/\/|ftp:\/\/|www\.)[^\s"']+/i;
const MARKDOWN_PATTERN = /^#{1,6}\s+|\*\*[^*]+\*\*|__[^_]+__|(?<!\w)\*[^*]+\*(?!\w)|(?<!\w)_[^_]+_(?!\w)|`[^`]+`|^```|^\s*[*+-]\s+|^\s*\d+\.\s+|^\s*>\s+|!?\[[^\]]*\]\([^)]*\)/m;

const COMMON_INTEGRATIONS = [
  'slack', 'github', 'telegram', 'discord', 'airtable', 'notion', 'trello', 'jira',
  'hubspot', 'salesforce', 'stripe', 'twilio', 'gmail', 'zendesk', 'pipedrive',
  'clickup', 'asana', 'shopify', 'woocommerce', 'mailchimp', 'sendgrid', 'aws',
  's3', 'dropbox', 'box', 'onedrive', 'google sheets', 'google drive', 'google calendar',
  'bigquery', 'postgres', 'mysql', 'mongodb', 'redis', 'supabase', 'snowflake',
];

export function validateDescription(
  summary: string,
  description: string,
  facts: FactPacket,
  resilience?: ResilienceFacts,
): ValidationResult {
  if (summary.length < 40 || summary.length > 280) {
    return {
      valid: false,
      reason: `Summary length (${summary.length}) must be between 40 and 280 characters`,
      code: 'SUMMARY_LENGTH_INVALID',
    };
  }

  if (description.length < 200 || description.length > 1600) {
    return {
      valid: false,
      reason: `Description length (${description.length}) must be between 200 and 1600 characters`,
      code: 'DESCRIPTION_LENGTH_INVALID',
    };
  }

  const combined = `${summary}\n${description}`;

  if (URL_PATTERN.test(combined)) {
    return {
      valid: false,
      reason: 'Text contains forbidden URL',
      code: 'CONTAINS_URL',
    };
  }

  if (FORBIDDEN_LICENCES.test(combined)) {
    return {
      valid: false,
      reason: 'Text contains forbidden licence identifier',
      code: 'CONTAINS_LICENCE',
    };
  }

  if (FORBIDDEN_VERDICTS.test(combined)) {
    return {
      valid: false,
      reason: 'Text contains forbidden security verdict',
      code: 'CONTAINS_SECURITY_VERDICT',
    };
  }

  if (MARKDOWN_PATTERN.test(combined)) {
    return {
      valid: false,
      reason: 'Text contains forbidden markdown formatting',
      code: 'CONTAINS_MARKDOWN',
    };
  }

  // Check unauthorized integrations.
  //
  // Both sides are compared with separators removed. The workflow records an
  // integration as the n8n node token (`googlesheets`), while prose necessarily
  // writes the product name (`Google Sheets`). Comparing those raw rejected
  // accurate descriptions as ungrounded, which was the single largest cause of
  // fallbacks in the first production run.
  const collapse = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const allowed = new Set(
    [...facts.integrations, ...(facts.nodeNames || [])].map(collapse).filter(Boolean),
  );
  const collapsedText = collapse(combined);

  for (const integration of COMMON_INTEGRATIONS) {
    if (integration === 'box' && !/\bBox\b/.test(combined)) continue;
    const needle = collapse(integration);
    if (!needle || !collapsedText.includes(needle)) continue;
    const isGrounded = [...allowed].some(
      (value) => value.includes(needle) || needle.includes(value),
    );
    if (!isGrounded) {
      return {
        valid: false,
        reason: `Text mentions unauthorized integration: ${integration}`,
        code: 'UNAUTHORIZED_INTEGRATION',
      };
    }
  }

  // Claims the analyser cannot support. Checked after grounding so the more
  // specific "you named a service that is not here" wins when both apply.
  const claim = findUnverifiableClaim(combined, resilience);
  if (claim !== null) {
    return { valid: false, reason: reasonForClaim(claim), code: claim };
  }

  // Readability last: it is the only rule that is a matter of degree, so a text
  // that breaks a factual rule should be reported for that instead.
  const score = readability(description);
  if (score.grade > MAX_GRADE) {
    return {
      valid: false,
      reason: `Description reads at grade ${score.grade}, above the maximum of ${MAX_GRADE}`,
      code: 'READABILITY_TOO_HIGH',
    };
  }

  return { valid: true };
}

function reasonForClaim(claim: ValidationErrorCode): string {
  switch (claim) {
    case 'DURATION_CLAIM':
      return 'Text claims a runtime or duration, which no workflow field supports';
    case 'COST_CLAIM':
      return 'Text states a cost figure, which the analyser does not compute';
    case 'UNGROUNDED_RESILIENCE_CLAIM':
      return 'Text claims retry or failure isolation that the workflow does not configure';
    default:
      return 'Text contains a filler phrase that asserts nothing';
  }
}
