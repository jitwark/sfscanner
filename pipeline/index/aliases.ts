export const ALIASES: Record<string, string[]> = {
  email: ['gmail', 'smtp', 'sendgrid', 'outlook', 'mailgun', 'imap'],
  ai: ['openai', 'anthropic', 'gemini', 'langchain', 'ollama', 'agent'],
  llm: ['openai', 'anthropic', 'gemini', 'langchain', 'ollama', 'agent'],
  db: ['postgres', 'mysql', 'mongodb', 'supabase', 'airtable'],
  database: ['postgres', 'mysql', 'mongodb', 'supabase', 'airtable'],
  chat: ['slack', 'discord', 'telegram', 'whatsapp', 'teams'],
  chatbot: ['slack', 'discord', 'telegram', 'whatsapp', 'teams'],
  sheet: ['google-sheets', 'excel', 'airtable', 'notion'],
  spreadsheet: ['google-sheets', 'excel', 'airtable', 'notion'],
  crm: ['hubspot', 'salesforce', 'pipedrive'],
  webhook: ['http', 'api', 'rest', 'trigger'],
  schedule: ['cron', 'interval', 'timer'],
  calendar: ['google-calendar', 'outlook-calendar', 'cal-com'],
  docs: ['google-docs', 'notion', 'coda'],
  storage: ['s3', 'google-drive', 'dropbox', 'box'],
  ecommerce: ['shopify', 'woocommerce', 'stripe'],
  payments: ['stripe', 'paypal', 'square'],
  analytics: ['posthog', 'google-analytics', 'mixpanel'],
  vector: ['pinecone', 'qdrant', 'chroma', 'weaviate', 'vector-store'],
  embeddings: ['openai-embeddings', 'cohere', 'vector-store'],
  social: ['twitter', 'x', 'linkedin', 'facebook', 'instagram'],
  messaging: ['twilio', 'slack', 'discord', 'telegram'],
  support: ['zendesk', 'intercom', 'freshdesk'],
  'project-management': ['jira', 'trello', 'linear', 'asana', 'clickup'],
  'code-hosting': ['github', 'gitlab', 'bitbucket'],
  scraping: ['firecrawl', 'tavily', 'apify', 'puppeteer'],
  forms: ['typeform', 'jotform', 'google-forms', 'tally'],
  sms: ['twilio', 'messagebird', 'sns'],
  notifications: ['slack', 'discord', 'pushover', 'pagerduty'],
  marketing: ['mailchimp', 'activecampaign', 'convertkit'],
  monitoring: ['sentry', 'datadog', 'betterstack'],
};

export function expandQuery(query: string): string {
  if (!query.trim()) return '';

  const tokens = query.match(/"[^"]*"|\S+/g) || [];
  const resultTokens: string[] = [];
  const seenTerms = new Set<string>();

  for (const token of tokens) {
    if (token.startsWith('"') && token.endsWith('"')) {
      resultTokens.push(token);
      continue;
    }

    const term = token.toLowerCase();
    if (!seenTerms.has(term)) {
      seenTerms.add(term);
      resultTokens.push(token);
    }

    const aliases = ALIASES[term];
    if (aliases) {
      for (const alias of aliases) {
        if (!seenTerms.has(alias)) {
          seenTerms.add(alias);
          resultTokens.push(alias);
        }
      }
    }
  }

  return resultTokens.join(' ');
}
