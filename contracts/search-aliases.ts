/** Curated lexical/semantic expansions shared by index generation and the browser worker. */
export const SEARCH_ALIASES: Record<string, string[]> = {
  email: ['gmail', 'smtp', 'sendgrid', 'outlook', 'mailgun', 'imap'], ai: ['openai', 'anthropic', 'gemini', 'langchain', 'ollama', 'agent'],
  llm: ['openai', 'anthropic', 'gemini', 'langchain', 'ollama', 'agent'], db: ['postgres', 'mysql', 'mongodb', 'supabase', 'airtable'],
  database: ['postgres', 'mysql', 'mongodb', 'supabase', 'airtable'], chat: ['slack', 'discord', 'telegram', 'whatsapp', 'teams'],
  chatbot: ['slack', 'discord', 'telegram', 'whatsapp', 'teams'], sheet: ['google-sheets', 'excel', 'airtable', 'notion'],
  spreadsheet: ['google-sheets', 'excel', 'airtable', 'notion'], crm: ['hubspot', 'salesforce', 'pipedrive'],
  webhook: ['http', 'api', 'rest', 'trigger'], schedule: ['cron', 'interval', 'timer'],
  calendar: ['google-calendar', 'outlook-calendar', 'cal-com'], docs: ['google-docs', 'notion', 'coda'],
  storage: ['s3', 'google-drive', 'dropbox', 'box'], ecommerce: ['shopify', 'woocommerce', 'stripe'],
  payments: ['stripe', 'paypal', 'square'], analytics: ['posthog', 'google-analytics', 'mixpanel'],
  vector: ['pinecone', 'qdrant', 'chroma', 'weaviate', 'vector-store'], embeddings: ['openai-embeddings', 'cohere', 'vector-store'],
  social: ['twitter', 'x', 'linkedin', 'facebook', 'instagram'], messaging: ['twilio', 'slack', 'discord', 'telegram'],
  support: ['zendesk', 'intercom', 'freshdesk'], 'project-management': ['jira', 'trello', 'linear', 'asana', 'clickup'],
  'code-hosting': ['github', 'gitlab', 'bitbucket'], scraping: ['firecrawl', 'tavily', 'apify', 'puppeteer'],
  forms: ['typeform', 'jotform', 'google-forms', 'tally'], sms: ['twilio', 'messagebird', 'sns'],
  notifications: ['slack', 'discord', 'pushover', 'pagerduty'], marketing: ['mailchimp', 'activecampaign', 'convertkit'],
  monitoring: ['sentry', 'datadog', 'betterstack'], http: ['api', 'rest', 'request', 'webhook', 'fetch'],
  code: ['javascript', 'python', 'function', 'script', 'transform'], openai: ['gpt', 'chatgpt', 'llm', 'ai', 'embeddings'],
  notification: ['slack', 'discord', 'email', 'telegram', 'pushover'], 'ai-agent': ['agent', 'langchain', 'autogen', 'vector-store', 'memory'],
  'google-sheets': ['sheets', 'spreadsheet', 'excel', 'csv', 'table'], gmail: ['email', 'mail', 'inbox', 'google-mail', 'smtp'],
  'file-processing': ['pdf', 'csv', 'json', 'file', 'parse', 'extract'], 'google-drive': ['drive', 'gdrive', 'cloud-storage', 'file', 'storage'],
  telegram: ['bot', 'chat', 'message', 'telegram-bot'], airtable: ['db', 'database', 'table', 'base', 'grid'],
  memory: ['buffer-memory', 'vector-store', 'redis', 'chat-memory'], form: ['typeform', 'tally', 'google-forms', 'survey', 'submission'],
  automation: ['workflow', 'bot', 'cron', 'trigger', 'integration'], lead: ['crm', 'hubspot', 'salesforce', 'contact', 'prospect'],
  image: ['vision', 'dalle', 'stability', 'image-generation', 'ocr'], audio: ['whisper', 'speech', 'transcription', 'voice'],
  auth: ['oauth', 'oauth2', 'jwt', 'api-key', 'token'], rss: ['feed', 'news', 'blog', 'xml'],
  queue: ['rabbitmq', 'sqs', 'redis', 'pubsub', 'message-queue'], cloud: ['aws', 'gcp', 'azure', 's3', 'cloud-storage'],
  devops: ['docker', 'kubernetes', 'terraform', 'ci-cd', 'github-actions'], crypto: ['bitcoin', 'ethereum', 'web3', 'blockchain', 'binance'],
  translation: ['deepl', 'google-translate', 'translate', 'i18n'], security: ['scanner', 'audit', 'vulnerability', 'secret', 'threat'],
  export: ['csv', 'json', 'pdf', 'download', 'dump'], invoice: ['stripe', 'quickbooks', 'xero', 'billing', 'accounting'],
};

/** Own-property lookup: see the note on SEARCH_ALIASES. Never index it directly. */
export function aliasesFor(token: string): string[] {
  return Object.hasOwn(SEARCH_ALIASES, token) ? SEARCH_ALIASES[token]! : [];
}
