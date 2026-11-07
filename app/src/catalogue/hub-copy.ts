import { normalizeDiscoverySlug, toNormalizedTag } from '@hub/contracts';
import type { HubInfo, HubKind } from './hub-types';

const BRAND_TITLES: Record<string, string> = {
  openai: 'OpenAI', github: 'GitHub', 'google-sheets': 'Google Sheets', 'google-drive': 'Google Drive',
  'google-docs': 'Google Docs', 'whats-app': 'WhatsApp', n8n: 'n8n', postgres: 'PostgreSQL', mysql: 'MySQL',
  mongodb: 'MongoDB', supabase: 'Supabase', airtable: 'Airtable', discord: 'Discord', telegram: 'Telegram',
  slack: 'Slack', 'email-send': 'Email Send', 'email-read-imap': 'Email Read (IMAP)',
};

export function slugify(text: string): string {
  return normalizeDiscoverySlug(text);
}

export function formatHubTitle(slug: string, kind: HubKind): string {
  if (kind === 'security') return `${slug.toUpperCase()} Security Risk`;
  if (kind === 'trigger') return `${toNormalizedTag('trigger', slug, 0).label} Trigger`;
  return BRAND_TITLES[slug] ?? toNormalizedTag(kind === 'integration' ? 'integration' : 'intent', slug, 0).label;
}

export function generateIntroCopy(hub: Omit<HubInfo, 'introCopy'>): string {
  const { kind, slug, title, totalEntries, companionIntegrations, dominantTrigger, gradeSpread } = hub;
  if (kind === 'security') return securityIntro(slug, totalEntries, companionIntegrations, dominantTrigger, gradeSpread);

  let hash = 0;
  for (let index = 0; index < slug.length; index += 1) {
    hash = (hash * 31 + slug.charCodeAt(index)) >>> 0;
  }
  const countText = `${totalEntries} n8n ${totalEntries === 1 ? 'workflow' : 'workflows'}`;
  const first = hash % 3 === 0 ? `This hub contains ${countText} associated with ${title}.`
    : hash % 3 === 1 ? `This index lists ${countText} associated with ${title}.`
      : `The catalogue records ${countText} with ${title}.`;
  const companions = companionIntegrations.slice(0, 3).map((item) => formatHubTitle(item.name, 'integration')).join(', ');
  const trigger = dominantTrigger ? formatHubTitle(slugify(dominantTrigger), 'trigger') : 'Manual Trigger';
  const second = companions ? companionSentence(hash, title, companions, trigger) : `These workflows rely predominantly on ${trigger} execution.`;
  const third = gradeSentence(hash, gradeSpread);
  return [first, second, third].filter(Boolean).join(' ');
}

function companionSentence(hash: number, title: string, companions: string, trigger: string): string {
  const variant = (hash >> 2) % 3;
  if (variant === 0) return `The most frequent companion integrations are ${companions}, with ${trigger} serving as the primary trigger.`;
  if (variant === 1) return `Workflows in this group commonly connect with ${companions} and rely predominantly on ${trigger} execution.`;
  return `Automations here frequently pair ${title} alongside ${companions}, executed mainly via ${trigger}.`;
}

function gradeSentence(hash: number, spread: HubInfo['gradeSpread']): string {
  const total = spread.low + spread.medium + spread.high + spread.critical + spread.unknown;
  if (!total) return '';
  const elevated = spread.high + spread.critical;
  if ((hash >> 4) % 2 === 0) return `Security analysis classifies ${Math.round((spread.low / total) * 100)}% of these workflows as low risk, ${Math.round((spread.medium / total) * 100)}% medium risk, and ${total - spread.low - spread.medium} requiring heightened review.`;
  return `Across security scans, ${spread.low} ${spread.low === 1 ? 'workflow is' : 'workflows are'} rated low risk, with ${spread.medium} medium risk and ${elevated} in elevated risk bands.`;
}

function securityIntro(slug: string, total: number, companions: HubInfo['companionIntegrations'], dominant: string, spread: HubInfo['gradeSpread']): string {
  const explanations: Record<string, string> = { LOW: 'LOW is the lowest risk band used by the scanner.', MEDIUM: 'MEDIUM is an intermediate risk band used by the scanner.', HIGH: 'HIGH is an elevated risk band used by the scanner.', CRITICAL: 'CRITICAL is the highest risk band used by the scanner.' };
  const explanation = explanations[slug.toUpperCase()] ?? 'This security grade reflects automated risk evaluation criteria.';
  const companionText = companions.length ? companions.slice(0, 3).map((item) => formatHubTitle(item.name, 'integration')).join(', ') : 'no companion integration is recorded';
  const trigger = dominant ? formatHubTitle(slugify(dominant), 'trigger') : 'Manual Trigger';
  const gradeSpread = `${spread.low} LOW, ${spread.medium} MEDIUM, ${spread.high} HIGH, ${spread.critical} CRITICAL, and ${spread.unknown} UNKNOWN`;
  return `This index covers ${total} ${total === 1 ? 'workflow' : 'workflows'} rated as ${slug.toUpperCase()} security risk. ${explanation} The recorded companion integrations are ${companionText}, and the dominant trigger is ${trigger}; the grade spread is ${gradeSpread}. This grade comes from automated analysis and is an advisory signal, not a compliance certificate.`;
}
