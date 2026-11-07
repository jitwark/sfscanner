/**
 * Opt-in workflow privacy preparation (PD-03): replaces credential references, sensitive
 * authorization headers, internal endpoints, webhook paths and embedded tokens with safe
 * placeholders before an export leaves the operator's machine. The result is a fresh copy plus an
 * exact change list and a reviewable diff; structure is preserved and the input is never mutated.
 * Redaction is heuristic and rule-bounded, so it never guarantees complete secret or PII removal.
 * Pure, deterministic and free of host APIs so the browser worker and CLI share one contract.
 */
export const PRIVACY_PREPARE_SCHEMA_V1 = 'n8n-workflow-privacy-prepare-v1' as const;
export const PRIVACY_PREPARE_DISCLAIMER_V1 = 'Heuristic and rule-bounded privacy preparation. Does NOT guarantee complete secret or PII removal. The raw diff and change excerpts contain the original removed values and are sensitive local review material; never share or upload them.' as const;

export const CREDENTIAL_ID_PLACEHOLDER = '[REDACTED_CREDENTIAL_ID]' as const;
export const CREDENTIAL_NAME_PLACEHOLDER = '[REDACTED_CREDENTIAL_NAME]' as const;
export const HEADER_VALUE_PLACEHOLDER = '[REDACTED_HEADER_VALUE]' as const;
export const INTERNAL_URL_PLACEHOLDER = 'https://internal.example.invalid/...' as const;
export const TOKEN_PLACEHOLDER = '[REDACTED_TOKEN]' as const;
export const WEBHOOK_PATH_PLACEHOLDER = '[REDACTED_WEBHOOK_PATH]' as const;
export const WEBHOOK_ID_PLACEHOLDER = '[REDACTED_WEBHOOK_ID]' as const;

export type PrivacyChangeKind = 'CREDENTIAL' | 'HEADER' | 'INTERNAL_URL' | 'TOKEN';
export type PrivacyChange = Readonly<{ path: string; kind: PrivacyChangeKind; originalExcerpt: string; replacement: string }>;
export type PrivacyPrepareOptions = Readonly<{ internalUrlPlaceholder?: string; internalHostSuffixes?: readonly string[] }>;
export type PrivacyPrepareResult = Readonly<{
  schemaVersion: typeof PRIVACY_PREPARE_SCHEMA_V1;
  workflow: Readonly<Record<string, unknown>>;
  changed: boolean;
  changes: readonly PrivacyChange[];
  diff: string;
  completeRedactionGuaranteed: false;
  disclaimer: typeof PRIVACY_PREPARE_DISCLAIMER_V1;
}>;

type Dict = Readonly<Record<string, unknown>>;
type WalkContext = Readonly<{ changes: PrivacyChange[]; suffixes: readonly string[]; urlPlaceholder: string; nodeType: string | null }>;

const DEFAULT_INTERNAL_SUFFIXES: readonly string[] = Object.freeze(['.local', '.internal', '.localdomain', '.lan', '.home.arpa', '.corp', '.intranet']);
const WEBHOOK_TYPE = 'n8n-nodes-base.webhook';
const EXCERPT_LIMIT = 80;
const SENSITIVE_HEADER_NAMES: Readonly<Record<string, true>> = Object.freeze({
  authorization: true, 'proxy-authorization': true, cookie: true, 'set-cookie': true, 'x-api-key': true,
  'x-auth-token': true, 'x-access-token': true, 'x-secret': true, 'x-api-token': true, 'api-key': true, apikey: true,
});
const SECRET_PARAMETER_KEYS: Readonly<Record<string, true>> = Object.freeze({
  password: true, passwd: true, apikey: true, api_key: true, token: true, secret: true, clientsecret: true, client_secret: true,
  privatekey: true, private_key: true, accesstoken: true, access_token: true, refreshtoken: true, refresh_token: true, authorization: true,
});
const URL_HOST_RE = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(\[[^\]]+\]|[^:/?#]+)/i;
const EMBEDDED_TOKEN_RULES: readonly (readonly [RegExp, string])[] = Object.freeze([
  [/([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|sig|signature|auth|password|code)=)[^&#\s]+/gi, `$1${TOKEN_PLACEHOLDER}`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${TOKEN_PLACEHOLDER}`],
  [/\bBasic\s+[A-Za-z0-9+/=]+/g, `Basic ${TOKEN_PLACEHOLDER}`],
] as const);

const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Writes an own enumerable property so keys such as `__proto__` stay data instead of mutating the prototype. */
const defineOwn = (target: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
};
const escapePointer = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');
const excerpt = (value: string): string => (value.length <= EXCERPT_LIMIT ? value : `${value.slice(0, EXCERPT_LIMIT - 3)}...`);
const cmp = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Records a replacement unless the value is already the placeholder, which keeps reruns idempotent. */
function recordChange(changes: PrivacyChange[], path: string, kind: PrivacyChangeKind, original: string, replacement: string): string {
  if (original !== replacement) changes.push(Object.freeze({ path, kind, originalExcerpt: excerpt(original), replacement }));
  return replacement;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^[0-9]{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return first === 0 || first === 10 || first === 127 || (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31) || (first === 169 && second === 254) ||
    (first === 100 && second >= 64 && second <= 127);
}

const IPV4_MAPPED_RE = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}:[0-9a-f]{1,4})$/i;

/** Reads the IPv4 address behind an `::ffff:` prefix, accepting dotted and hex-pair spellings. */
function mappedIpv4(host: string): string | null {
  const text = IPV4_MAPPED_RE.exec(host)?.[1];
  if (text === undefined) return null;
  if (text.includes('.')) return text;
  const [high = 0, low = 0] = text.split(':').map((group) => Number.parseInt(group, 16));
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function isInternalIpv6(host: string): boolean {
  const mapped = mappedIpv4(host);
  if (mapped !== null) return isPrivateIpv4(mapped);
  if (host === '::' || host === '::1') return true;
  // Unique-local fc00::/7 and link-local fe80::/10 ranges never route off the local network.
  return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}

function isInternalHost(host: string, suffixes: readonly string[]): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (normalized === 'localhost' || normalized === '0.0.0.0') return true;
  if (normalized.includes(':')) return isInternalIpv6(normalized);
  if (isPrivateIpv4(normalized)) return true;
  if (suffixes.some((suffix) => normalized.endsWith(suffix))) return true;
  return !normalized.includes('.');
}

/** Resolves a URL host through the WHATWG parser, which canonicalizes octal, dword and hex IPv4 spellings. */
function resolveUrlHost(value: string): string {
  const match = URL_HOST_RE.exec(value);
  if (match === null) return '';
  const fallback = match[1] ?? '';
  try {
    return new URL(value).hostname || fallback;
  } catch {
    return fallback;
  }
}

function isInternalUrl(value: string, suffixes: readonly string[]): boolean {
  const host = resolveUrlHost(value);
  return host.length > 0 && isInternalHost(host, suffixes);
}

function sanitizeString(value: string, path: string, ctx: WalkContext): string {
  if (value.length === 0) return value;
  if (isInternalUrl(value, ctx.suffixes)) return recordChange(ctx.changes, path, 'INTERNAL_URL', value, ctx.urlPlaceholder);
  if (!path.includes('/parameters/')) return value;
  if (SECRET_PARAMETER_KEYS[path.slice(path.lastIndexOf('/') + 1).toLowerCase()] === true) return recordChange(ctx.changes, path, 'TOKEN', value, TOKEN_PLACEHOLDER);
  const scrubbed = EMBEDDED_TOKEN_RULES.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), value);
  return scrubbed === value ? value : recordChange(ctx.changes, path, 'TOKEN', value, scrubbed);
}

function sanitizeValue(value: unknown, path: string, ctx: WalkContext): unknown {
  if (Array.isArray(value)) return value.map((item, index) => sanitizeValue(item, `${path}/${index}`, ctx));
  if (isDict(value)) return sanitizeObject(value, path, ctx);
  return typeof value === 'string' ? sanitizeString(value, path, ctx) : value;
}

function sanitizeCredentials(input: Dict, path: string, ctx: WalkContext): Dict {
  const out: Record<string, unknown> = {};
  for (const [credentialType, details] of Object.entries(input)) {
    const typePath = `${path}/${escapePointer(credentialType)}`;
    if (!isDict(details)) {
      defineOwn(out, credentialType, sanitizeValue(details, typePath, ctx));
      continue;
    }
    const cleaned: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(details)) {
      const valuePath = `${typePath}/${escapePointer(key)}`;
      if (key === 'id' && (typeof raw === 'string' || typeof raw === 'number') && String(raw).length > 0) {
        defineOwn(cleaned, key, recordChange(ctx.changes, valuePath, 'CREDENTIAL', String(raw), CREDENTIAL_ID_PLACEHOLDER));
      } else if (key === 'name' && typeof raw === 'string' && raw.length > 0) {
        defineOwn(cleaned, key, recordChange(ctx.changes, valuePath, 'CREDENTIAL', raw, CREDENTIAL_NAME_PLACEHOLDER));
      } else {
        defineOwn(cleaned, key, sanitizeValue(raw, valuePath, ctx));
      }
    }
    defineOwn(out, credentialType, cleaned);
  }
  return out;
}

function sanitizeObject(input: Dict, path: string, ctx: WalkContext): Dict {
  const nodeType = typeof input.type === 'string' ? input.type : ctx.nodeType;
  const scoped: WalkContext = { ...ctx, nodeType };
  const headerName = typeof input.name === 'string' ? input.name.trim().toLowerCase() : null;
  const isHeaderEntry = headerName !== null && path.includes('/headerParameters/parameters/') && SENSITIVE_HEADER_NAMES[headerName] === true;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    const childPath = `${path}/${escapePointer(key)}`;
    if (key === 'credentials' && isDict(raw)) {
      defineOwn(out, key, sanitizeCredentials(raw, childPath, scoped));
    } else if (isHeaderEntry && key === 'value' && typeof raw === 'string' && raw.length > 0) {
      defineOwn(out, key, recordChange(scoped.changes, childPath, 'HEADER', raw, HEADER_VALUE_PLACEHOLDER));
    } else if (key === 'webhookId' && typeof raw === 'string' && raw.length > 0) {
      defineOwn(out, key, recordChange(scoped.changes, childPath, 'TOKEN', raw, WEBHOOK_ID_PLACEHOLDER));
    } else if (key === 'path' && nodeType === WEBHOOK_TYPE && typeof raw === 'string' && raw.length > 0) {
      defineOwn(out, key, recordChange(scoped.changes, childPath, 'TOKEN', raw, WEBHOOK_PATH_PLACEHOLDER));
    } else {
      defineOwn(out, key, sanitizeValue(raw, childPath, scoped));
    }
  }
  return out;
}

/** Every replacement keeps one JSON line per value, so changed lines diff one-to-one without an LCS pass. */
function buildDiff(before: unknown, after: unknown): string {
  const beforeLines = JSON.stringify(before, null, 2).split('\n');
  const afterLines = JSON.stringify(after, null, 2).split('\n');
  const total = Math.max(beforeLines.length, afterLines.length);
  const hunks: string[] = [];
  let index = 0;
  while (index < total) {
    if (beforeLines[index] === afterLines[index]) { index += 1; continue; }
    const start = index;
    const removed: string[] = [];
    const added: string[] = [];
    while (index < total && beforeLines[index] !== afterLines[index]) {
      const beforeLine = beforeLines[index];
      const afterLine = afterLines[index];
      if (beforeLine !== undefined) removed.push(beforeLine);
      if (afterLine !== undefined) added.push(afterLine);
      index += 1;
    }
    hunks.push(`@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`));
  }
  return hunks.length === 0 ? '' : ['--- workflow.before.json', '+++ workflow.after.json', ...hunks].join('\n');
}

/** Validates caller options, which may arrive as untyped JSON, before any redaction runs. */
function readOptions(options: unknown): Readonly<{ urlPlaceholder: string; extraSuffixes: readonly string[] }> {
  if (!isDict(options)) throw new TypeError('options must be an object');
  const unknownKey = Object.keys(options).find((key) => key !== 'internalUrlPlaceholder' && key !== 'internalHostSuffixes');
  if (unknownKey !== undefined) throw new TypeError(`unknown option: ${unknownKey}`);
  const placeholder = options.internalUrlPlaceholder;
  if (placeholder !== undefined && (typeof placeholder !== 'string' || placeholder.trim().length === 0)) throw new TypeError('internalUrlPlaceholder must be a non-empty string');
  const suffixes = options.internalHostSuffixes ?? [];
  if (!Array.isArray(suffixes)) throw new TypeError('internalHostSuffixes must be an array');
  // A bare top-level label such as `com` would redact every public host, so a leading dot is required.
  const extraSuffixes = suffixes.map((suffix: unknown) => {
    const text = typeof suffix === 'string' ? suffix.trim().toLowerCase() : '';
    if (!text.startsWith('.') || text.length < 2) throw new TypeError('internalHostSuffixes entries must be dotted strings');
    return text;
  });
  return { urlPlaceholder: typeof placeholder === 'string' ? placeholder : INTERNAL_URL_PLACEHOLDER, extraSuffixes: [...new Set(extraSuffixes)] };
}

/** Returns a scrubbed deep copy plus the change list and diff; the input workflow is never mutated. */
export function prepareWorkflowPrivacy(workflow: unknown, options: PrivacyPrepareOptions = {}): PrivacyPrepareResult {
  if (!isDict(workflow)) throw new TypeError('workflow must be an object');
  const { urlPlaceholder, extraSuffixes } = readOptions(options);
  const changes: PrivacyChange[] = [];
  const ctx: WalkContext = { changes, suffixes: [...DEFAULT_INTERNAL_SUFFIXES, ...extraSuffixes], urlPlaceholder, nodeType: null };
  const prepared = sanitizeObject(workflow, '', ctx);
  const ordered = changes.sort((left, right) => cmp(left.path, right.path));
  return Object.freeze({
    schemaVersion: PRIVACY_PREPARE_SCHEMA_V1,
    workflow: prepared,
    changed: ordered.length > 0,
    changes: Object.freeze(ordered),
    diff: buildDiff(workflow, prepared),
    completeRedactionGuaranteed: false as const,
    disclaimer: PRIVACY_PREPARE_DISCLAIMER_V1,
  });
}
