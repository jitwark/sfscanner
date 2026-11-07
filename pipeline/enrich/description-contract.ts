import type { GeneratedDescription } from '@hub/contracts';
import type { DescriptionEvidence } from './description-evidence';

export type DescriptionValidationResult =
  | { valid: true; value: GeneratedDescription }
  | { valid: false; errors: string[] };

export function renderGeneratedDescription(value: GeneratedDescription): string {
  const steps = value.howItWorks.map((step) => step.trim()).join('\n');
  const limits = value.limitations.map((limit) => limit.trim()).join('\n');
  return [
    value.outcome.trim(),
    `Before: ${value.beforeAfter.before.trim()} After: ${value.beforeAfter.after.trim()}`,
    value.exampleScenario.trim(),
    `How it works:\n${steps}`,
    `What to keep in mind:\n${limits}`,
    `Who this is for: ${value.audience.trim()}`,
  ].join('\n\n');
}

const KNOWN_SERVICES = [
  'slack', 'github', 'telegram', 'discord', 'airtable', 'notion', 'trello', 'jira',
  'hubspot', 'salesforce', 'stripe', 'twilio', 'gmail', 'zendesk', 'pipedrive',
  'clickup', 'asana', 'shopify', 'woocommerce', 'mailchimp', 'sendgrid', 'aws',
  's3', 'dropbox', 'onedrive', 'google sheets', 'google drive', 'google calendar',
  'bigquery', 'postgres', 'mysql', 'mongodb', 'redis', 'supabase', 'snowflake',
];

const UNSUPPORTED = [
  /https?:\/\//i,
  /\b(?:MIT|Apache|GPL|BSD|ISC|CC0|Unlicense|proprietary)\s+(?:licen[cs](?:e|ed|ing)?|terms?|notice|copyright)\b/i,
  /\b(?:licen[cs](?:e|ed|ing)?|terms?|notice|copyright)\s+(?:under\s+)?(?:MIT|Apache|GPL|BSD|ISC|CC0|Unlicense|proprietary)\b/i,
  /\b(?:released|distributed|available)\s+under\s+(?:the\s+)?(?:MIT|Apache|GPL|BSD|ISC|CC0|Unlicense|proprietary)\b/i,
  /\b(?:secure|insecure|safe|unsafe|vulnerable|malicious|trusted)\b/i,
  /(?:[$£€]\s*\d|\b\d+\s*(?:cents?|dollars?|euros?)\b|\b(?:takes|runs in|completes in|finishes in|within)\s+(?:about\s+|around\s+|roughly\s+|under\s+|less than\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a few|several)\s*[-\s]?(?:milli)?(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b|\b(?:cheap|expensive)\b)/i,
  /\b(?:retry|retries|retrying|failure isolation|never fails)\b/i,
];
const REQUIRED_KEYS = new Set(['headline', 'summary', 'outcome', 'beforeAfter', 'exampleScenario', 'howItWorks', 'limitations', 'audience']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: GeneratedDescription): string {
  return [
    value.headline, value.summary, value.outcome, value.beforeAfter.before,
    value.beforeAfter.after, value.exampleScenario, ...value.howItWorks,
    ...value.limitations, value.audience,
  ].join('\n');
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function parse(value: unknown, errors: string[]): GeneratedDescription | null {
  if (!isRecord(value)) {
    errors.push('output must be an object');
    return null;
  }
  for (const key of Object.keys(value)) if (!REQUIRED_KEYS.has(key)) errors.push(`unexpected field: ${key}`);
  const strings = ['headline', 'summary', 'outcome', 'exampleScenario', 'audience'];
  for (const key of strings) if (typeof value[key] !== 'string' || !value[key].trim()) errors.push(`${key} is required`);
  const beforeAfter = value.beforeAfter;
  if (!isRecord(beforeAfter) || typeof beforeAfter.before !== 'string' || typeof beforeAfter.after !== 'string') {
    errors.push('beforeAfter.before and beforeAfter.after are required');
  } else {
    for (const key of Object.keys(beforeAfter)) if (key !== 'before' && key !== 'after') errors.push(`unexpected beforeAfter field: ${key}`);
  }
  if (!Array.isArray(value.howItWorks) || value.howItWorks.length < 3 || value.howItWorks.some((item) => typeof item !== 'string')) {
    errors.push('howItWorks must contain at least three strings');
  }
  if (!Array.isArray(value.limitations) || value.limitations.length < 1 || value.limitations.some((item) => typeof item !== 'string')) {
    errors.push('limitations must contain at least one string');
  }
  if (errors.length > 0) return null;
  return value as unknown as GeneratedDescription;
}

export function validateGeneratedDescription(value: unknown, evidence: DescriptionEvidence): DescriptionValidationResult {
  const errors: string[] = [];
  const parsed = parse(value, errors);
  if (!parsed) return { valid: false, errors };
  const combined = textOf(parsed);
  if (parsed.headline.length < 20 || parsed.headline.length > 140) errors.push('headline must be between 20 and 140 characters');
  if (parsed.summary.length < 40 || parsed.summary.length > 280) errors.push('summary must be between 40 and 280 characters');
  if (words(combined) < 300) errors.push('description must contain at least 300 words');
  if (!/\b(?:example|imagine|for instance)\b/i.test(parsed.exampleScenario)) errors.push('exampleScenario must be labeled as hypothetical');
  for (const pattern of UNSUPPORTED) if (pattern.test(combined)) errors.push(`unsupported claim or content: ${pattern}`);

  const normalized = combined.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const collapsed = normalized.replace(/\s+/g, '');
  const allowed = new Set(evidence.integrations.map((item) => item.toLowerCase().replace(/[^a-z0-9]+/g, '')));
  for (const service of KNOWN_SERVICES) {
    const normalizedService = service.replace(/[^a-z0-9]+/g, '');
    const spacedService = service.toLowerCase();
    const escaped = spacedService.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const appears = new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, 'i').test(normalized) ||
      (spacedService.includes(' ') && normalized.includes(spacedService.replace(/\s+/g, '')));
    if (appears && ![...allowed].some((item) => item.includes(normalizedService) || normalizedService.includes(item))) {
      errors.push(`unsupported integration mentioned: ${service}`);
    }
  }
  const groundedToken = [...evidence.integrations, ...evidence.nodeTypes.map((type) => type.split('.').at(-1) ?? type)]
    .map((item) => item.toLowerCase().replace(/[^a-z0-9]+/g, ''))
    .find((item) => item.length > 2 && collapsed.includes(item));
  if (!groundedToken) errors.push('description does not mention a grounded workflow node or integration');
  return errors.length ? { valid: false, errors } : { valid: true, value: parsed };
}
