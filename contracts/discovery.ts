export const TAG_GROUPS = [
  'integration', 'intent', 'trigger', 'capability', 'complexity', 'security', 'rights',
] as const;

export type TagGroup = (typeof TAG_GROUPS)[number];

export type NormalizedTag = {
  slug: string;
  label: string;
  group: TagGroup;
  count: number;
};

export type FacetCounts = {
  rights: Record<string, number>;
  grade: Record<string, number>;
  trigger: Record<string, number>;
  complexity: Record<string, number>;
  capabilities: Record<string, number>;
  integrations: Record<string, number>;
  tags: Record<string, number>;
};

export type FacetData = {
  total: number;
  counts: FacetCounts;
  facets: NormalizedTag[];
  bitsets: Record<string, string>;
  /**
   * Entry ids in ordinal order — the order the bitsets are indexed by.
   *
   * This lived in `semantic-index.json`, where it agreed with the bitsets only
   * because two modules happened to iterate the same array. Co-generating it
   * with the bitsets makes the agreement structural rather than coincidental,
   * and it is what lets the semantic index be fetched lazily: the worker needs
   * ordinals at init, and it must not need a 1.55 MB download to get them.
   */
  ordinals: string[];
};

export type TaxonomyGroup = Exclude<TagGroup, 'integration' | 'intent'>;

type TaxonomyValue = { slug: string; label: string };

const TAXONOMY: Record<TaxonomyGroup, Record<string, TaxonomyValue>> = {
  trigger: {
    webhook: { slug: 'webhook', label: 'Webhook' }, schedule: { slug: 'schedule', label: 'Schedule' },
    manual: { slug: 'manual', label: 'Manual' }, chat: { slug: 'chat', label: 'Chat' },
    email: { slug: 'email', label: 'Email' }, form: { slug: 'form', label: 'Form' },
    'execute-workflow': { slug: 'execute-workflow', label: 'Execute Workflow' },
    unknown: { slug: 'unknown', label: 'Uncategorized' },
  },
  capability: {
    code: { slug: 'code', label: 'Code' }, ai: { slug: 'ai', label: 'AI' },
    webhook: { slug: 'webhook', label: 'Webhook' }, unknown: { slug: 'unknown', label: 'Uncategorized' },
  },
  complexity: {
    simple: { slug: 'simple', label: 'Simple' }, medium: { slug: 'medium', label: 'Medium' },
    complex: { slug: 'complex', label: 'Complex' }, unknown: { slug: 'unknown', label: 'Uncategorized' },
  },
  security: {
    low: { slug: 'LOW', label: 'LOW' }, medium: { slug: 'MEDIUM', label: 'MEDIUM' },
    high: { slug: 'HIGH', label: 'HIGH' }, critical: { slug: 'CRITICAL', label: 'CRITICAL' },
    unknown: { slug: 'UNKNOWN', label: 'UNKNOWN' },
  },
  rights: {
    redistributable: { slug: 'redistributable', label: 'Redistributable' },
    'link-only': { slug: 'link_only', label: 'Link-only' },
    unknown: { slug: 'unknown', label: 'Uncategorized' },
  },
};

const FREE_LABELS: Record<'integration' | 'intent', Record<string, string>> = {
  integration: {
    openai: 'OpenAI', github: 'GitHub', slack: 'Slack', gmail: 'Gmail', telegram: 'Telegram',
    discord: 'Discord', airtable: 'Airtable', notion: 'Notion', postgres: 'PostgreSQL',
    mysql: 'MySQL', mongodb: 'MongoDB', supabase: 'Supabase', 'google-sheets': 'Google Sheets',
    'google-drive': 'Google Drive', 'google-docs': 'Google Docs', 'google-calendar': 'Google Calendar',
    whatsapp: 'WhatsApp', unknown: 'Uncategorized',
  },
  intent: {
    notification: 'Notification', email: 'Email', schedule: 'Schedule', webhook: 'Webhook',
    chat: 'Chat', form: 'Form', code: 'Code', database: 'Database', 'file-processing': 'File processing',
    scraping: 'Scraping', rag: 'RAG', 'ai-agent': 'AI agent', unknown: 'Uncategorized',
  },
};

export function normalizeDiscoverySlug(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const slug = value.trim().toLowerCase()
    .replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug || 'unknown';
}

export function normalizeDiscoveryFilterValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const slug = normalizeDiscoverySlug(value);
  return slug === 'unknown' && value.trim().toLowerCase() !== 'unknown' ? null : slug;
}

function taxonomyValue(group: TaxonomyGroup, value: unknown): TaxonomyValue | undefined {
  const slug = normalizeDiscoverySlug(value);
  const aliases: Partial<Record<TaxonomyGroup, Record<string, string>>> = {
    capability: { 'has-code': 'code', hascode: 'code', 'has-ai': 'ai', hasai: 'ai', 'has-webhook': 'webhook', haswebhook: 'webhook' },
    rights: { linkonly: 'link-only' },
  };
  return TAXONOMY[group][aliases[group]?.[slug] ?? slug];
}

export function normalizeTaxonomyValue(group: TaxonomyGroup, value: unknown): string {
  return (taxonomyValue(group, value) ?? TAXONOMY[group].unknown!).slug;
}

export function normalizeTaxonomyFilterValue(group: TaxonomyGroup, value: unknown): string | null {
  return taxonomyValue(group, value)?.slug ?? null;
}

function freeLabel(slug: string): string {
  if (slug === 'unknown') return 'Uncategorized';
  const acronyms: Record<string, string> = {
    ai: 'AI', api: 'API', crm: 'CRM', csv: 'CSV', http: 'HTTP', json: 'JSON', n8n: 'n8n',
    rag: 'RAG', rss: 'RSS', sms: 'SMS', sql: 'SQL', url: 'URL', xml: 'XML',
  };
  return slug.split('-').map((word) => acronyms[word] ?? `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
}

export function toNormalizedTag(group: TagGroup, value: unknown, count: number, label?: string): NormalizedTag {
  if (group === 'integration' || group === 'intent') {
    const slug = normalizeDiscoverySlug(value);
    return { slug, label: label?.trim() || FREE_LABELS[group][slug] || freeLabel(slug), group, count };
  }
  const slug = normalizeTaxonomyValue(group, value);
  const taxonomy = Object.values(TAXONOMY[group]).find((item) => item.slug === slug) ?? TAXONOMY[group].unknown!;
  return { slug, label: taxonomy.label, group, count };
}

export type SearchDisplayItem = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  integrations: string[];
  tags: string[];
  triggers: string[];
  capabilities: string[];
  grade: string;
  rights: string;
  complexity: string;
  nodeCount: number;
  sourceRepo?: string;
  descriptionSource?: string;
  isIndexable?: boolean;
  isPrerendered?: boolean;
};

type DiscoveryEntry = {
  id: string; slug: string; title: string; summary: string; tags?: string[];
  structure?: { integrations?: string[]; trigger?: string; complexity?: string; nodeCount?: number; hasCode?: boolean; hasAI?: boolean; hasWebhook?: boolean };
  security?: { grade?: string }; rights?: { status?: string }; source?: { repo?: string; permalink?: string };
  descriptionSource?: string; isPrerendered?: boolean;
};

export function discoveryFields(entry: DiscoveryEntry) {
  const capabilities = [entry.structure?.hasCode && 'code', entry.structure?.hasAI && 'ai', entry.structure?.hasWebhook && 'webhook']
    .filter((value): value is string => Boolean(value));
  return {
    integrations: [...new Set((entry.structure?.integrations ?? []).map(normalizeDiscoverySlug))],
    tags: [...new Set((entry.tags ?? []).map(normalizeDiscoverySlug))],
    triggers: [normalizeTaxonomyValue('trigger', entry.structure?.trigger)],
    capabilities,
    grade: normalizeTaxonomyValue('security', entry.security?.grade),
    rights: normalizeTaxonomyValue('rights', entry.rights?.status),
    complexity: normalizeTaxonomyValue('complexity', entry.structure?.complexity),
  };
}

export function toSearchDisplayItem(
  entry: DiscoveryEntry,
  state: { isIndexable?: boolean; isPrerendered?: boolean } = {},
): SearchDisplayItem {
  return {
    id: entry.id,
    slug: entry.slug,
    title: entry.title,
    summary: entry.summary,
    ...discoveryFields(entry),
    nodeCount: entry.structure?.nodeCount ?? 0,
    sourceRepo: entry.source?.repo ?? entry.source?.permalink,
    descriptionSource: entry.descriptionSource,
    isIndexable: state.isIndexable,
    isPrerendered: state.isPrerendered ?? entry.isPrerendered,
  };
}
