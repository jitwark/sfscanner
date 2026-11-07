import {
  ADMITTED_PROFILE_V2, BUILTIN_AUTHORITIES_V2, DEFAULT_SCAN_CONFIG_V2, SCAN_CONFIG_V2_FIELDS,
  SCAN_CONFIG_V2_MAX_CONCURRENCY, SCAN_CONFIG_V2_MAX_DOMAINS, SCAN_CONFIG_V2_MAX_PATTERNS, SCAN_CONFIG_V2_MAX_STRING,
  isAdmittedProfileSpecifierV2, isApprovedDomainV2,
  type ScanConfigV2,
} from './contracts';
import { normalizeAdmittedPathV2 } from './path-admission';

export type ConfigLoadOptions = Readonly<{ configDirectory?: string; cli?: unknown }>;
export type ConfigLoadResult = Readonly<{ ok: true; config: ScanConfigV2 } | { ok: false; code: 'INVALID_CONFIG'; errors: readonly string[] }>;
type Plain = Record<string, unknown>;
const BUILTIN: Record<string, true> = { builtin: true };
const CLI_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'fail-on': 'failOn', 'require-complete': 'requireComplete', 'max-concurrency': 'concurrency',
  'allow-unsigned-development-rules': 'allowUnsignedDevelopmentRules',
  'no-color': 'noColor', config: 'configPath',
});
const REPEATABLE_CLI: Record<string, true> = { inputs: true, include: true, exclude: true, approvedDomains: true };

export function loadExplicitConfig(input: unknown, options: ConfigLoadOptions = {}): ConfigLoadResult {
  const errors: string[] = [];
  const config = parseConfig(input, errors);
  const cli = readCli(options.cli, errors);
  if (typeof options.configDirectory !== 'undefined' && typeof options.configDirectory !== 'string') errors.push('config directory is invalid');
  if (!config || !cli) return failure(errors);
  const configPathCount = Number(Object.prototype.hasOwnProperty.call(config, 'configPath'))
    + Number(Object.prototype.hasOwnProperty.call(cli, 'configPath'))
    + Number(Object.prototype.hasOwnProperty.call(cli, '_configPath'));
  if (configPathCount > 1) errors.push('config path supplied more than once');
  const merged: Plain = Object.assign(Object.create(null), DEFAULT_SCAN_CONFIG_V2, config);
  for (const key of Object.keys(cli)) if (key !== 'configPath' && key !== '_configPath') merged[key] = cli[key];
  if (Object.prototype.hasOwnProperty.call(cli, 'configPath')) merged.configPath = cli.configPath;
  else if (Object.prototype.hasOwnProperty.call(cli, '_configPath')) merged.configPath = cli._configPath;
  const result = normalize(merged, config, cli, errors);
  return result ? Object.freeze({ ok: true as const, config: deepFreeze(result) }) : failure(errors);
}

export function validateScanConfigV2(input: unknown): ConfigLoadResult { return loadExplicitConfig(input); }

function parseConfig(input: unknown, errors: string[]): Plain | undefined {
  if (typeof input === 'string') {
    if (input.length > SCAN_CONFIG_V2_MAX_STRING * 16 || duplicateKeys(input)) { errors.push('configuration JSON is invalid'); return undefined; }
    try { input = JSON.parse(input) as unknown; } catch { errors.push('configuration JSON is invalid'); return undefined; }
  }
  const value = record(input);
  if (!value) { errors.push('configuration must be a closed object'); return undefined; }
  for (const key of Object.keys(value)) if (!(SCAN_CONFIG_V2_FIELDS as readonly string[]).includes(key)) errors.push(`unknown configuration key: ${safeErrorKey(key)}`);
  if (value.schemaVersion !== 'n8n-scan-config-v2') errors.push('unsupported schemaVersion');
  return Object.keys(value).every((key) => (SCAN_CONFIG_V2_FIELDS as readonly string[]).includes(key)) ? value : undefined;
}

function readCli(input: unknown, errors: string[]): Plain | undefined {
  if (input === undefined) return {};
  const value = record(input); if (!value) { errors.push('CLI configuration is invalid'); return undefined; }
  const out: Plain = Object.create(null);
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (rawKey === 'config') {
      if (Object.prototype.hasOwnProperty.call(out, '_configPath')) errors.push('config path supplied more than once');
      out._configPath = rawValue;
      continue;
    }
    const key = CLI_NAMES[rawKey] ?? rawKey;
    if (!(SCAN_CONFIG_V2_FIELDS as readonly string[]).includes(key)) { errors.push(`unknown CLI configuration key: ${safeErrorKey(rawKey)}`); continue; }
    out[key] = REPEATABLE_CLI[key] === true && typeof rawValue === 'string' ? [rawValue] : rawValue;
  }
  return out;
}
function normalize(value: Plain, config: Plain, cli: Plain, errors: string[]): ScanConfigV2 | undefined {
  const out: Plain = Object.assign(Object.create(null), { schemaVersion: 'n8n-scan-config-v2' });
  const format = value.format; if (format !== 'json' && format !== 'ndjson' && format !== 'sarif' && format !== 'table') errors.push('format is invalid'); else out.format = format;
  const profile = value.profile;
  if (!isAdmittedProfileSpecifierV2(profile)) errors.push('profile is not admitted'); else out.profile = ADMITTED_PROFILE_V2.id;
  if (value.failOn !== 'CRITICAL' && value.failOn !== 'HIGH' && value.failOn !== 'MEDIUM' && value.failOn !== 'LOW' && value.failOn !== 'INFO') errors.push('failOn is invalid'); else out.failOn = value.failOn;
  for (const key of ['requireComplete', 'allowUnsignedDevelopmentRules', 'noColor']) {
    if (typeof value[key] !== 'boolean') errors.push(`${key} is invalid`); else out[key] = value[key];
  }
  if (!Number.isSafeInteger(value.concurrency) || (value.concurrency as number) < 1 || (value.concurrency as number) > SCAN_CONFIG_V2_MAX_CONCURRENCY) errors.push('concurrency is outside the admitted range'); else out.concurrency = value.concurrency;
  for (const key of ['rules', 'catalogue'] as const) {
    const raw = value[key];
    if (typeof raw !== 'string' || BUILTIN[raw] !== true) errors.push(`${key} is not admitted in built-in-only v2`); else out[key] = 'builtin';
  }
  for (const key of ['limits', 'target', 'output', 'configPath'] as const) if (value[key] !== undefined || Object.prototype.hasOwnProperty.call(value, key)) {
    const raw = value[key]; if (typeof raw !== 'string') errors.push(`${key} is invalid`); else { const path = localPath(raw, false, errors, key === 'limits'); if (path) out[key] = path; }
  }
  for (const key of ['inputs', 'include', 'exclude'] as const) {
    const raw = value[key]; if (raw === undefined) { if (Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${key} is invalid`); continue; }
    const items = arrayValues(raw);
    if (!items || items.length > SCAN_CONFIG_V2_MAX_PATTERNS) { errors.push(`${key} is outside the admitted limit`); continue; }
    const paths: string[] = [];
    for (const item of items) {
      if (typeof item !== 'string') errors.push(`${key} contains an invalid path`);
      else if (key === 'inputs') {
        const path = normalizeAdmittedPathV2(item);
        if (path === undefined) errors.push('inputs contains an invalid path'); else paths.push(path);
      } else {
        const path = localPath(item, true, errors);
        if (path) paths.push(path);
      }
    }
    out[key] = Object.freeze(paths);
  }
  const rawDomains = value.approvedDomains;
  const domainItems = arrayValues(rawDomains);
  if (!domainItems || domainItems.length > SCAN_CONFIG_V2_MAX_DOMAINS) errors.push('approvedDomains is outside the admitted limit');
  else {
    const domains: string[] = [];
    for (const item of domainItems) {
      if (!isApprovedDomainV2(item)) errors.push('approvedDomains contains an invalid domain');
      else domains.push(item.toLowerCase());
    }
    out.approvedDomains = Object.freeze([...new Set(domains)].sort());
  }
  if (!Object.prototype.hasOwnProperty.call(config, 'include') && !Object.prototype.hasOwnProperty.call(cli, 'include')) out.include = DEFAULT_SCAN_CONFIG_V2.include;
  if (!Object.prototype.hasOwnProperty.call(config, 'exclude') && !Object.prototype.hasOwnProperty.call(cli, 'exclude')) out.exclude = DEFAULT_SCAN_CONFIG_V2.exclude;
  return errors.length === 0 ? out as ScanConfigV2 : undefined;
}

function localPath(raw: string, pattern: boolean, errors: string[], allowBuiltin = false): string | undefined {
  if (raw.length === 0 || raw.length > SCAN_CONFIG_V2_MAX_STRING || /[\u0000-\u001f\u007f]/.test(raw)) { errors.push('path is invalid'); return undefined; }
  if (BUILTIN[raw] === true) { if (allowBuiltin) return 'builtin'; errors.push('built-in marker is not valid for this path'); return undefined; }
  const normalized = raw.replaceAll('\\', '/');
  if (/^(?:[a-z][a-z\d+.-]*:|\/|[a-z]:)/i.test(normalized)) { errors.push('absolute or remote path is not admitted'); return undefined; }
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (pattern || parts.length === 0) { errors.push('path escapes its config directory'); return undefined; } parts.pop(); continue; }
    parts.push(part);
  }
  if (parts.length === 0) { errors.push('path is invalid'); return undefined; }
  return parts.join('/');
}
function arrayValues(value: unknown): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) return undefined;
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== value.length + 1) return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) return undefined;
      output.push(descriptor.value);
    }
    return output;
  } catch { return undefined; }
}
function safeErrorKey(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) ? value : 'field';
}

export {
  ADMITTED_PROFILE_V2,
  BUILTIN_AUTHORITIES_V2,
  BUILTIN_LIMITS_AUTHORITY_V2,
  BUILTIN_RULESET_AUTHORITY_V2,
  BUILTIN_SEMANTICS_AUTHORITY_V2,
  CLI_TOOL_V2,
  DEFAULT_SCAN_CONFIG_V2,
  PROFILE_MANIFEST_DIGEST_V2,
  RULE_PACK_DIGEST_V2,
  SCAN_CONFIG_SCHEMA_V2,
  SEMANTIC_CATALOGUE_DIGEST_V2,
  type ScanConfigV2,
} from './contracts';

function record(value: unknown): Plain | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const proto = Object.getPrototypeOf(value); if (proto !== Object.prototype && proto !== null) return undefined;
    if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
    const out: Plain = Object.create(null);
    for (const key of Object.getOwnPropertyNames(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined; out[key] = descriptor.value; }
    return out;
  } catch { return undefined; }
}

function duplicateKeys(text: string): boolean {
  let index = 0;
  const skip = () => { while (/\s/.test(text[index] ?? '')) index += 1; };
  const string = () => { index += 1; while (index < text.length) { const char = text[index++]; if (char === '\\') index += 1; else if (char === '"') return; } throw new Error(); };
  const value = (): void => { skip(); const char = text[index]; if (char === '{') return object(); if (char === '[') return array(); if (char === '"') { string(); return; } const start = index; while (index < text.length && !/[\s,\]}]/.test(text[index]!)) index += 1; if (start === index) throw new Error(); };
  const object = (): void => { index += 1; const keys = new Set<string>(); skip(); if (text[index] === '}') { index += 1; return; } while (index < text.length) { skip(); if (text[index] !== '"') throw new Error(); const start = index; string(); const key = text.slice(start, index); if (keys.has(key)) throw new Error(); keys.add(key); skip(); if (text[index++] !== ':') throw new Error(); value(); skip(); if (text[index] === '}') { index += 1; return; } if (text[index++] !== ',') throw new Error(); } throw new Error(); };
  const array = (): void => { index += 1; skip(); if (text[index] === ']') { index += 1; return; } while (index < text.length) { value(); skip(); if (text[index] === ']') { index += 1; return; } if (text[index++] !== ',') throw new Error(); } throw new Error(); };
  try { value(); skip(); if (index !== text.length) throw new Error(); return false; } catch { return true; }
}
function failure(errors: readonly string[]): ConfigLoadResult {
  return Object.freeze({ ok: false, code: 'INVALID_CONFIG' as const, errors: Object.freeze([...new Set(errors)].sort()) });
}
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T { if (value && typeof value === 'object') { if (seen.has(value)) return value; seen.add(value); for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Plain)[key], seen); Object.freeze(value); } return value; }

