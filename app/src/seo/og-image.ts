import type { Entry } from '@hub/contracts';
import { absoluteSiteUrl } from './site-origin';
const GENERATED_INTEGRATIONS: Record<string, true> = {
  generic: true, openai: true, 'google-sheets': true, slack: true, telegram: true, postgres: true,
  supabase: true, github: true, gmail: true, 'google-drive': true, notion: true, airtable: true,
  hubspot: true, stripe: true, discord: true, whatsapp: true, anthropic: true, gemini: true,
  openrouter: true, aws: true, s3: true, redis: true, mysql: true, mongodb: true, nocodb: true,
  baserow: true, jira: true, shopify: true, wordpress: true, twitter: true, facebook: true,
  linkedin: true, outlook: true, 'google-docs': true, 'google-calendar': true, youtube: true,
  spotify: true, pipedrive: true, twilio: true, rss: true, mattermost: true, graphql: true,
  email: true, http: true, webhook: true, schedule: true, code: true, agent: true, rag: true,
  database: true, mcp: true, zendesk: true, linear: true, trello: true, clickup: true,
  asana: true, salesforce: true, intercom: true, mailchimp: true, sendgrid: true,
};


const GENERIC_NODES: Record<string, true> = {
  code: true,
  set: true,
  if: true,
  manual: true,
  webhook: true,
  schedule: true,
  'sticky-note': true,
  'no-op': true,
  switch: true,
  'respond-to-webhook': true,
  error: true,
  'manual-trigger': true,
  'schedule-trigger': true,
  'webhook-trigger': true,
};

export function getPrimaryIntegration(integrations: string[] = []): string {
  if (!integrations || integrations.length === 0) return 'generic';
  const external = integrations.find((i) => !GENERIC_NODES[i.toLowerCase()]);
  const candidate = (external || integrations[0] || 'generic').toLowerCase();
  return GENERATED_INTEGRATIONS[candidate] ? candidate : 'generic';
}

export function getEffectiveGrade(grade?: string): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  if (grade === 'CRITICAL') return 'CRITICAL';
  if (grade === 'HIGH') return 'HIGH';
  if (grade === 'MEDIUM') return 'MEDIUM';
  return 'LOW';
}

/**
 * Resolve the static OG image URL for an entry, or nothing without a release
 * origin — an image URL on a fabricated host is worse than no image.
 */
export function resolveOgImage(entry: Entry): string | null {
  const primaryInt = getPrimaryIntegration(entry.structure?.integrations);
  const grade = getEffectiveGrade(entry.security?.grade);
  return absoluteSiteUrl(`/og/og-${primaryInt}-${grade}.png`);
}
