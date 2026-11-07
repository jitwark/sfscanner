import { compareTargetCodePointsV3 as compareCodePoints, createTargetContextDigestV3 } from '@hub/contracts/scanner-target-v3';
import { parseStrictSemver } from './semver';

export type TargetContextV3 = Readonly<{
  schemaVersion: 'scanner-target-v3';
  n8nVersion?: string;
  edition: 'COMMUNITY' | 'ENTERPRISE' | 'CLOUD' | 'UNKNOWN';
  deployment: 'SELF_HOSTED' | 'CLOUD' | 'UNKNOWN';
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'UNKNOWN';
  taskRunner: 'LEGACY' | 'NATIVE' | 'UNKNOWN';
  communityPackages: readonly Readonly<{ name: string; version?: string }>[];
  configuration: readonly Readonly<{ key: string; state: 'ENABLED' | 'DISABLED' | 'UNKNOWN' }>[];
  contextDigest: string;
}>;

export type TargetContextValidationOptions = Readonly<{
  allowedConfigurationKeys?: ReadonlySet<string> | readonly string[];
}>;
type Plain = Record<string, unknown>;
type Body = Omit<TargetContextV3, 'contextDigest'>;
const TOP = ['schemaVersion', 'n8nVersion', 'edition', 'deployment', 'role', 'taskRunner', 'communityPackages', 'configuration', 'contextDigest'] as const;
const DIGEST = /^[0-9a-f]{64}$/;
const BAD_KEY = /[%\\]/;
const PACKAGE_NAME = /^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/;
const MAX_TEXT_LENGTH = 4096;
const MAX_COLLECTION_ITEMS = 100_000;
const ENUMS = {
  edition: ['COMMUNITY', 'ENTERPRISE', 'CLOUD', 'UNKNOWN'],
  deployment: ['SELF_HOSTED', 'CLOUD', 'UNKNOWN'],
  role: ['OWNER', 'ADMIN', 'MEMBER', 'UNKNOWN'],
  taskRunner: ['LEGACY', 'NATIVE', 'UNKNOWN'],
} as const;

class TargetContextError extends TypeError {}
function invalid(reason: string): never { throw new TargetContextError(reason); }
function has(value: Plain, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function ownRecord(input: unknown, allowed: readonly string[], label: string): Plain {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return invalid(`UNSAFE_INPUT: ${label}`);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return invalid(`UNSAFE_INPUT: ${label}`);
    const names = Object.getOwnPropertyNames(input);
    if (Object.getOwnPropertySymbols(input).length !== 0) return invalid(`UNSAFE_INPUT: ${label}`);
    for (const name of names) if (!allowed.includes(name)) return invalid(`UNKNOWN_KEY: ${label}.${name}`);
    const result: Plain = Object.create(null);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (descriptor === undefined || !('value' in descriptor)) return invalid(`UNSAFE_INPUT: ${label}.${name}`);
      result[name] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof TargetContextError) throw error;
    return invalid(`UNSAFE_INPUT: ${label}`);
  }
}
function denseArray(input: unknown, label: string): readonly unknown[] {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return invalid(`UNSAFE_INPUT: ${label}`);
    const length = Object.getOwnPropertyDescriptor(input, 'length');
    if (length === undefined || !('value' in length) || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_COLLECTION_ITEMS) return invalid(`UNSAFE_INPUT: ${label}`);
    const names = Object.getOwnPropertyNames(input);
    if (names.length !== length.value + 1 || !names.includes('length') || Object.getOwnPropertySymbols(input).length !== 0) return invalid(`UNSAFE_INPUT: ${label}`);
    const result: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (descriptor === undefined || !('value' in descriptor)) return invalid(`UNSAFE_INPUT: ${label}[${index}]`);
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (error instanceof TargetContextError) throw error;
    return invalid(`UNSAFE_INPUT: ${label}`);
  }
}
function safeText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH || value !== value.normalize('NFC') || BAD_KEY.test(value)) return invalid(`INVALID_TEXT: ${label}`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return invalid(`INVALID_TEXT: ${label}`);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return invalid(`INVALID_TEXT: ${label}`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return invalid(`INVALID_TEXT: ${label}`);
  }
  return value;
}
function packageName(value: unknown): string {
  const name = safeText(value, 'package.name');
  if (name.length > 214 || !PACKAGE_NAME.test(name)) return invalid('INVALID_PACKAGE_NAME');
  return name;
}
function allowedKeys(options?: TargetContextValidationOptions): ReadonlySet<string> | undefined {
  if (options === undefined) return undefined;
  const safeOptions = ownRecord(options, ['allowedConfigurationKeys'], 'options');
  const candidate = has(safeOptions, 'allowedConfigurationKeys') ? safeOptions.allowedConfigurationKeys : undefined;
  if (candidate === undefined) return undefined;
  const values = Array.isArray(candidate) ? denseArray(candidate, 'allowedConfigurationKeys') : candidate instanceof Set ? setValues(candidate) : invalid('UNSAFE_INPUT: allowedConfigurationKeys');
  const result = new Set<string>();
  for (const value of values) { const key = safeText(value, 'allowedConfigurationKeys'); if (result.has(key)) return invalid('DUPLICATE_CONFIGURATION_KEY'); result.add(key); }
  return result;
}
function setValues(value: Set<unknown>): readonly unknown[] {
  const result: unknown[] = [];
  Set.prototype.forEach.call(value, (item) => result.push(item));
  return result;
}
function enumValue(value: Plain, key: keyof typeof ENUMS): string {
  if (!has(value, key)) return 'UNKNOWN';
  if (typeof value[key] !== 'string' || !(ENUMS[key] as readonly string[]).includes(value[key] as string)) return invalid(`INVALID_${key.toUpperCase()}`);
  return value[key] as string;
}
function body(input: unknown, options?: TargetContextValidationOptions): Body {
  const value = ownRecord(input, TOP, 'target');
  if (value.schemaVersion !== 'scanner-target-v3') return invalid('INVALID_SCHEMA_VERSION');
  const output: Plain = { schemaVersion: 'scanner-target-v3' };
  if (has(value, 'n8nVersion')) { if (typeof value.n8nVersion !== 'string') return invalid('INVALID_N8N_VERSION'); try { parseStrictSemver(value.n8nVersion); } catch { return invalid('INVALID_N8N_VERSION'); } output.n8nVersion = value.n8nVersion; }
  output.edition = enumValue(value, 'edition'); output.deployment = enumValue(value, 'deployment'); output.role = enumValue(value, 'role'); output.taskRunner = enumValue(value, 'taskRunner');
  const packages = has(value, 'communityPackages') ? denseArray(value.communityPackages, 'communityPackages') : [];
  const packagePairs = new Map<string, Set<string | null>>();
  output.communityPackages = packages.map((raw, index) => { const item = ownRecord(raw, ['name', 'version'], `communityPackages[${index}]`); if (!has(item, 'name')) return invalid('MISSING_KEY: package.name'); const name = packageName(item.name); const versions = packagePairs.get(name) ?? new Set<string | null>(); const version = has(item, 'version') ? item.version : undefined; if (has(item, 'version') && (typeof version !== 'string' || version.length === 0)) return invalid('INVALID_PACKAGE_VERSION'); if (typeof version === 'string') { try { parseStrictSemver(version); } catch { return invalid('INVALID_PACKAGE_VERSION'); } } const key = typeof version === 'string' ? version : null; if (versions.has(key) || (key === null && versions.size > 0) || (key !== null && versions.has(null))) return invalid('DUPLICATE_PACKAGE'); versions.add(key); packagePairs.set(name, versions); return version === undefined ? { name } as Plain : { name, version } as Plain; }).sort((left, right) => compareCodePoints(left.name as string, right.name as string) || compareCodePoints((left.version as string | undefined) ?? '', (right.version as string | undefined) ?? ''));
  const vocabulary = allowedKeys(options);
  const configs = has(value, 'configuration') ? denseArray(value.configuration, 'configuration') : [];
  const configKeys = new Set<string>();
  output.configuration = configs.map((raw, index) => { const item = ownRecord(raw, ['key', 'state'], `configuration[${index}]`); if (!has(item, 'key')) return invalid('MISSING_KEY: configuration.key'); const key = safeText(item.key, 'configuration.key'); if (vocabulary && !vocabulary.has(key)) return invalid('UNKNOWN_CONFIGURATION_KEY'); if (configKeys.has(key)) return invalid('DUPLICATE_CONFIGURATION_KEY'); configKeys.add(key); const state = has(item, 'state') ? item.state : 'UNKNOWN'; if (typeof state !== 'string' || !['ENABLED', 'DISABLED', 'UNKNOWN'].includes(state)) return invalid('INVALID_CONFIGURATION_STATE'); return { key, state } as Plain; }).sort((left, right) => compareCodePoints(left.key as string, right.key as string) || compareCodePoints(left.state as string, right.state as string));
  return output as Body;
}
function digestBody(value: Body): string { return createTargetContextDigestV3(value); }
function freeze<T>(value: T, seen = new WeakSet<object>()): T { if (value !== null && typeof value === 'object') { if (seen.has(value)) return value; seen.add(value); for (const key of Object.getOwnPropertyNames(value)) freeze((value as Plain)[key], seen); Object.freeze(value); } return value; }

export function createTargetDigest(targetWithoutDigest: Omit<TargetContextV3, 'contextDigest'>): string {
  return digestBody(body(targetWithoutDigest));
}
export function validateTargetContextV3(input: unknown, options?: TargetContextValidationOptions): TargetContextV3 {
  try {
    const normalized = body(input, options); const digest = digestBody(normalized); const value = ownRecord(input, TOP, 'target');
    if (has(value, 'contextDigest')) { if (typeof value.contextDigest !== 'string' || !DIGEST.test(value.contextDigest)) return invalid('INVALID_CONTEXT_DIGEST'); if (value.contextDigest !== digest) return invalid('CONTEXT_DIGEST_MISMATCH'); }
    return freeze({ ...normalized, contextDigest: digest }) as TargetContextV3;
  } catch (error) { if (error instanceof TargetContextError) throw error; return invalid('UNSAFE_INPUT'); }
}
