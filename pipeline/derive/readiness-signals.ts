import { getIntegrationInfo } from '../enrich/integration-map.js';
// One shared definition, so the readiness row and `structure.hasAI` cannot
// disagree about whether a workflow calls a model. See `ai-detection.ts`.
import { isAiNodeType } from './ai-detection.js';
import type { ReadinessAiModel } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import type { ReadinessNode } from './readiness-types.js';

/** The segment after the last dot, lowercased: `n8n-nodes-base.noOp` -> `noop`. */
function compactType(type: string): string {
  const segments = type.split('.');
  return (segments[segments.length - 1] ?? type).toLowerCase();
}

/** Everything before the last dot, or null when the type has no dot to split on. */
function packageOf(type: string): string | null {
  const lastDot = type.lastIndexOf('.');
  return lastDot > 0 ? type.slice(0, lastDot) : null;
}

// Deterministic fallback when a credential key's owning node type is not in
// integration-map.ts: strip the common credential-name suffixes, then split
// camelCase into title-cased words. Not a guess at the product's real name —
// a pure string transform, same idea as `structure.ts`'s `integration()`.
function humanizeCredentialKey(key: string): string {
  const stripped = key.replace(/OAuth2Api$/, '').replace(/OAuth2$/, '').replace(/Api$/, '');
  const spaced = stripped.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  if (!spaced) return key;
  return spaced
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Distinct credential requirements, mapped to human product names via the owning node's type first. */
export function deriveCredentials(nodes: ReadinessNode[]): string[] {
  const labels = new Set<string>();
  for (const node of nodes) {
    const creds = node.credentials;
    if (!creds || typeof creds !== 'object' || Array.isArray(creds)) continue;
    for (const key of Object.keys(creds as Record<string, unknown>)) {
      const label = getIntegrationInfo(node.type)?.label ?? humanizeCredentialKey(key);
      if (label) labels.add(label);
    }
  }
  return [...labels].sort(compareCanonicalStrings);
}

// Explicit, hand-maintained list of node types that write or send something
// outside the workflow, keyed by their compact (last-dot-segment) type. This
// is deliberately not derived from integration-map.ts: most integrations there
// are read-or-write, and only a subset of their operations actually write.
const WRITE_ACTION_TYPES: Record<string, string> = {
  gmail: 'sends email',
  emailsend: 'sends email',
  smtp: 'sends email',
  microsoftoutlook: 'sends email',
  slack: 'posts to Slack',
  telegram: 'sends Telegram messages',
  discord: 'posts to Discord',
  whatsapp: 'sends WhatsApp messages',
  twitter: 'posts to X/Twitter',
  linkedin: 'posts to LinkedIn',
  facebookgraphapi: 'posts to Facebook',
  mattermost: 'posts to Mattermost',
  googlesheets: 'updates Google Sheets',
  googledrive: 'uploads to Google Drive',
  googledocs: 'writes Google Docs',
  microsoftexcel: 'updates Excel',
  microsoftonedrive: 'uploads to OneDrive',
  notion: 'writes to Notion',
  airtable: 'writes to Airtable',
  hubspot: 'writes to HubSpot',
  mailchimp: 'sends via Mailchimp',
  stripe: 'writes to Stripe',
  shopify: 'writes to Shopify',
  woocommerce: 'writes to WooCommerce',
  postgres: 'writes to Postgres',
  mysql: 'writes to MySQL',
  mongodb: 'writes to MongoDB',
  supabase: 'writes to Supabase',
  awss3: 'uploads to S3',
  s3: 'uploads to S3',
  wordpress: 'publishes to WordPress',
  trello: 'writes to Trello',
  jira: 'writes to Jira',
  clickup: 'writes to ClickUp',
  respondtowebhook: 'responds to the webhook caller',
};

export function deriveWriteActions(nodes: ReadinessNode[]): string[] {
  const actions = new Set<string>();
  for (const node of nodes) {
    const action = WRITE_ACTION_TYPES[compactType(node.type)];
    if (action) actions.add(action);
  }
  return [...actions].sort(compareCanonicalStrings);
}

const MODEL_KEY_RE = /^model(id)?$/i;

// Bounded, sorted-key search for a "model"/"modelId" field so the result does
// not depend on the input object's own key insertion order.
function findModel(value: unknown, depth: number): string | null {
  if (depth > 3 || !value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort(compareCanonicalStrings);
  for (const key of keys) {
    if (!MODEL_KEY_RE.test(key)) continue;
    const candidate = obj[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === 'object') {
      const nestedValue = (candidate as Record<string, unknown>).value;
      if (typeof nestedValue === 'string' && nestedValue.trim()) return nestedValue.trim();
    }
  }
  for (const key of keys) {
    const nested = findModel(obj[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** Whether an AI node is present and, if determinable, the model it is pinned to. */
export function deriveAiModel(nodes: ReadinessNode[]): ReadinessAiModel {
  const aiNodes = nodes.filter(node => isAiNodeType(node.type));
  if (aiNodes.length === 0) return { present: false, model: null };
  const sorted = [...aiNodes].sort((a, b) => compareCanonicalStrings(a.name, b.name));
  for (const node of sorted) {
    if (!node.parameters || typeof node.parameters !== 'object') continue;
    const model = findModel(node.parameters, 0);
    if (model) return { present: true, model };
  }
  return { present: true, model: null };
}

/** Node type packages outside `n8n-nodes-base.*` and `@n8n/*`. */
export function deriveExtraPackages(nodes: ReadinessNode[]): string[] {
  const packages = new Set<string>();
  for (const node of nodes) {
    if (node.type.startsWith('n8n-nodes-base.') || node.type.startsWith('@n8n/')) continue;
    const pkg = packageOf(node.type);
    if (pkg) packages.add(pkg);
  }
  return [...packages].sort(compareCanonicalStrings);
}

const LEGACY_FUNCTION_TYPES: ReadonlySet<string> = new Set(['function', 'functionitem']);
// Node types whose typeVersion 1 behaves meaningfully differently from later
// versions (fewer options, different defaults). A narrow, explicit list, not
// a blanket "typeVersion === 1 is legacy" rule — most nodes' v1 is unremarkable.
const NOTABLE_V1_TYPES: ReadonlySet<string> = new Set(['code', 'httprequest', 'set']);

/** Legacy syntax and node signals: the Function node and notable `typeVersion` values. `hasLegacyExpression` covers `$node[...]`, computed by the caller from the same bounded parameter walk used for replaceable values. */
export function deriveVersionNotes(nodes: ReadinessNode[], hasLegacyExpression: boolean): string[] {
  const notes = new Set<string>();
  if (hasLegacyExpression) notes.add('Uses legacy $node[...] expression syntax');
  for (const node of nodes) {
    const compact = compactType(node.type);
    if (LEGACY_FUNCTION_TYPES.has(compact)) notes.add('Uses the legacy Function node');
    if (NOTABLE_V1_TYPES.has(compact) && node.typeVersion === 1) {
      const label = getIntegrationInfo(node.type)?.label ?? node.type;
      notes.add(`Uses ${label} at its original version (typeVersion 1)`);
    }
  }
  return [...notes].sort(compareCanonicalStrings);
}
