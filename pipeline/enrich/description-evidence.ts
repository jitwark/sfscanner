export type DescriptionEvidence = {
  nodeCount: number;
  nodeNames: string[];
  nodeTypes: string[];
  integrations: string[];
  trigger: string;
  hasCode: boolean;
  hasAI: boolean;
  hasWebhook: boolean;
};

const SERVICE_TOKENS = new Set([
  'slack', 'github', 'telegram', 'discord', 'airtable', 'notion', 'trello', 'jira',
  'hubspot', 'salesforce', 'stripe', 'twilio', 'gmail', 'zendesk', 'pipedrive',
  'clickup', 'asana', 'shopify', 'woocommerce', 'mailchimp', 'sendgrid', 'aws',
  's3', 'dropbox', 'box', 'onedrive', 'googlesheets', 'googledrive', 'googlecalendar',
  'bigquery', 'postgres', 'mysql', 'mongodb', 'redis', 'supabase', 'snowflake',
]);

const SERVICE_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['googlesheets', ['googlesheets', 'google sheets', 'google_sheets']],
  ['googledrive', ['googledrive', 'google drive', 'google_drive']],
  ['googlecalendar', ['googlecalendar', 'google calendar', 'google_calendar']],
  ['s3', ['s3', 'amazon s3', 'aws s3', 'awss3']],
  ...[...SERVICE_TOKENS]
    .filter((token) => !['googlesheets', 'googledrive', 'googlecalendar', 's3'].includes(token))
    .map((token) => [token, [token]] as const),
];

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function lastToken(type: string): string {
  return (type.split('.').at(-1) ?? type).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value.toLowerCase());
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, output));
    return;
  }
  if (record(value)) Object.values(value).forEach((child) => collectStrings(child, output));
}

export function buildDescriptionEvidence(workflow: unknown): DescriptionEvidence {
  const nodes = record(workflow) && Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const safeNodes = nodes.filter(record);
  const nodeNames = safeNodes.map((node) => typeof node.name === 'string' ? node.name : '').filter(Boolean);
  const nodeTypes = safeNodes.map((node) => typeof node.type === 'string' ? node.type : '').filter(Boolean);
  const tokens = nodeTypes.map(lastToken);
  const visibleText: string[] = [];
  safeNodes.forEach((node) => collectStrings(node, visibleText));
  const flattened = visibleText.join(' ').replace(/[^a-z0-9]+/gi, '');
  const integrations = new Set(tokens.filter((token) => SERVICE_TOKENS.has(token)));
  for (const [canonical, aliases] of SERVICE_ALIASES) {
    if (aliases.some((alias) => flattened.includes(alias.replace(/[^a-z0-9]+/gi, '')))) integrations.add(canonical);
  }
  const triggerNode = safeNodes.find((node) => typeof node.type === 'string' && /trigger|webhook|cron|schedule/i.test(node.type));
  const trigger = triggerNode && typeof triggerNode.type === 'string' ? lastToken(triggerNode.type) : 'manual';
  return {
    nodeCount: safeNodes.length,
    nodeNames,
    nodeTypes,
    integrations: [...integrations].sort(),
    trigger,
    hasCode: tokens.some((token) => token === 'code' || token === 'function' || token === 'functionitem'),
    hasAI: tokens.some((token) => /openai|anthropic|gemini|langchain|lmchat|aichain/.test(token)),
    hasWebhook: tokens.some((token) => token.includes('webhook')),
  };
}
