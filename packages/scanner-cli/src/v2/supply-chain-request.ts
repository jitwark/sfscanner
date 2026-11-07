import type { TargetContextV3 } from '@hub/contracts/scanner-v2-result';
import { validateTargetContextV3, type AdvisoryInventoryStateV3 } from '@hub/scanner-core/v2';
import { isValidStrictSemver } from './supply-chain-snapshot';

export type PackageVersionV2 =
  | Readonly<{ state: 'KNOWN'; name: string; version: string; inventoryDigest: string }>
  | Readonly<{ state: 'UNKNOWN'; name: string; reason: 'VERSION_MISSING' }>;

export type SupplyChainEvaluationV2 = Readonly<{
  status: 'NOT_REQUESTED' | 'NO_DECLARED_PACKAGES' | 'UNAVAILABLE' | 'REFUSED';
  reason: 'NONE' | 'NO_ADMITTED_SNAPSHOT' | 'INVENTORY_UNVERIFIED' | 'TRANSPORT_TIMEOUT'
    | 'TRANSPORT_CANCELLED' | 'TRANSPORT_FAILED' | 'HTTP_STATUS' | 'REDIRECT_REFUSED'
    | 'BODY_OVERSIZED' | 'PIN_INVALID' | 'SNAPSHOT_DIGEST_MISMATCH' | 'INVALID_UTF8'
    | 'INVALID_JSON' | 'DUPLICATE_KEY' | 'SNAPSHOT_SCHEMA_UNSUPPORTED' | 'SOURCE_MISMATCH'
    | 'CAPTURE_MISMATCH' | 'SNAPSHOT_STALE' | 'SNAPSHOT_FUTURE' | 'RECORD_LIMIT'
    | 'DUPLICATE_ADVISORY' | 'RECORD_INVALID' | 'CATALOGUE_ADMISSION_FAILED';
}>;

export type SupplyChainRequestV2 = Readonly<{
  schemaVersion: 'supply-chain-request-v2';
  status: 'DISABLED' | 'EMPTY' | 'READY' | 'REFUSED';
  inventoryDigest: string;
  inventoryState: AdvisoryInventoryStateV3;
  evaluation: SupplyChainEvaluationV2;
  packages: readonly PackageVersionV2[];
}>;

const SCHEMA_VERSION = 'supply-chain-request-v2' as const;
const DIGEST = /^[0-9a-f]{64}$/u;
const PACKAGE_NAME = /^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/u;
const REQUEST_KEYS = ['schemaVersion', 'status', 'inventoryDigest', 'inventoryState', 'evaluation', 'packages'] as const;
const EVALUATION_KEYS = ['status', 'reason'] as const;
const KNOWN_KEYS = ['state', 'name', 'version', 'inventoryDigest'] as const;
const UNKNOWN_KEYS = ['state', 'name', 'reason'] as const;
const UNAVAILABLE = new Set<string>([
  'NO_ADMITTED_SNAPSHOT', 'TRANSPORT_TIMEOUT', 'TRANSPORT_CANCELLED', 'TRANSPORT_FAILED',
  'HTTP_STATUS', 'REDIRECT_REFUSED', 'BODY_OVERSIZED', 'PIN_INVALID',
  'SNAPSHOT_DIGEST_MISMATCH', 'INVALID_UTF8', 'INVALID_JSON', 'DUPLICATE_KEY',
  'SNAPSHOT_SCHEMA_UNSUPPORTED', 'SOURCE_MISMATCH', 'CAPTURE_MISMATCH', 'SNAPSHOT_STALE',
  'SNAPSHOT_FUTURE', 'RECORD_LIMIT', 'DUPLICATE_ADVISORY', 'RECORD_INVALID',
  'CATALOGUE_ADMISSION_FAILED',
]);

type Plain = Record<string, unknown>;
function compare(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1; }
function evaluation(inventoryState: AdvisoryInventoryStateV3, packages: number, supplied?: SupplyChainEvaluationV2): SupplyChainEvaluationV2 {
  if (inventoryState === 'UNVERIFIED') return Object.freeze({ status: 'REFUSED', reason: 'INVENTORY_UNVERIFIED' });
  if (packages === 0) return Object.freeze({ status: 'NO_DECLARED_PACKAGES', reason: 'NONE' });
  return supplied === undefined ? Object.freeze({ status: 'UNAVAILABLE', reason: 'NO_ADMITTED_SNAPSHOT' }) : Object.freeze({ status: supplied.status, reason: supplied.reason });
}

/** Closed request metadata. Evaluation remains a fact-owned state, never a top-level verdict. */
export function buildSupplyChainRequest(input: Readonly<{
  enabled: boolean; target: TargetContextV3; inventoryState: AdvisoryInventoryStateV3;
  evaluation?: SupplyChainEvaluationV2;
}>): SupplyChainRequestV2 {
  const target = validateTargetContextV3(input.target);
  const inventoryDigest = target.contextDigest;
  if (!DIGEST.test(inventoryDigest)) throw new TypeError('target.contextDigest must be lowercase sha-256');
  if (!input.enabled) return Object.freeze({ schemaVersion: SCHEMA_VERSION, status: 'DISABLED', inventoryDigest, inventoryState: input.inventoryState, evaluation: Object.freeze({ status: 'NOT_REQUESTED', reason: 'NONE' }), packages: Object.freeze([]) });
  if (input.inventoryState === 'UNVERIFIED') return Object.freeze({ schemaVersion: SCHEMA_VERSION, status: 'REFUSED', inventoryDigest, inventoryState: input.inventoryState, evaluation: evaluation(input.inventoryState, 0, input.evaluation), packages: Object.freeze([]) });
  const packages = target.communityPackages.map((pkg) => pkg.version === undefined
    ? Object.freeze({ state: 'UNKNOWN' as const, name: pkg.name, reason: 'VERSION_MISSING' as const })
    : Object.freeze({ state: 'KNOWN' as const, name: pkg.name, version: pkg.version, inventoryDigest }))
    .sort((left, right) => compare(left.name, right.name) || compare('version' in left ? left.version : '', 'version' in right ? right.version : ''));
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, status: packages.length === 0 ? 'EMPTY' : 'READY', inventoryDigest, inventoryState: input.inventoryState, evaluation: evaluation(input.inventoryState, packages.length, input.evaluation), packages: Object.freeze(packages) });
}

function plain(input: unknown): Plain | undefined {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(input).length !== 0) return undefined;
    const output: Plain = Object.create(null);
    for (const key of Object.getOwnPropertyNames(input)) { const descriptor = Object.getOwnPropertyDescriptor(input, key); if (!descriptor || !('value' in descriptor)) return undefined; output[key] = descriptor.value; }
    return output;
  } catch { return undefined; }
}
function exact(record: Plain, keys: readonly string[]): boolean { const names = Object.getOwnPropertyNames(record); return names.length === keys.length && keys.every((key) => names.includes(key)); }
function dense(input: unknown): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return undefined;
    const length = input.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > 100_000 || Object.getOwnPropertyNames(input).length !== length + 1) return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(input, String(index)); if (!descriptor || !('value' in descriptor)) return undefined; output.push(descriptor.value); }
    return output;
  } catch { return undefined; }
}
function validName(input: unknown): input is string { return typeof input === 'string' && new TextEncoder().encode(input).byteLength <= 214 && PACKAGE_NAME.test(input); }
function validPackage(input: unknown, inventoryDigest: string): boolean {
  const record = plain(input); if (!record || !validName(record.name)) return false;
  return record.state === 'KNOWN' ? exact(record, KNOWN_KEYS) && isValidStrictSemver(record.version) && record.inventoryDigest === inventoryDigest
    : record.state === 'UNKNOWN' && exact(record, UNKNOWN_KEYS) && record.reason === 'VERSION_MISSING';
}
function validEvaluation(input: unknown): boolean {
  const record = plain(input); if (!record || !exact(record, EVALUATION_KEYS)) return false;
  if (record.status === 'NOT_REQUESTED' || record.status === 'NO_DECLARED_PACKAGES') return record.reason === 'NONE';
  if (record.status === 'UNAVAILABLE') return typeof record.reason === 'string' && UNAVAILABLE.has(record.reason);
  return record.status === 'REFUSED' && record.reason === 'INVENTORY_UNVERIFIED';
}
export function validateSupplyChainRequestV2(input: unknown): input is SupplyChainRequestV2 {
  try {
    const record = plain(input); if (!record || !exact(record, REQUEST_KEYS) || record.schemaVersion !== SCHEMA_VERSION || !validEvaluation(record.evaluation)) return false;
    if (typeof record.inventoryDigest !== 'string' || !DIGEST.test(record.inventoryDigest)) return false;
    if (record.inventoryState !== 'DECLARED' && record.inventoryState !== 'UNVERIFIED') return false;
    const packages = dense(record.packages); if (!packages || !packages.every((item) => validPackage(item, record.inventoryDigest as string))) return false;
    const identities = new Set<string>(), missing = new Set<string>(), names = new Set<string>();
    let previous = '';
    for (const item of packages) {
      const p = item as Plain;
      const key = `${p.name}\u0000${p.version ?? ''}`;
      if (identities.has(key) || key <= previous || missing.has(String(p.name))
        || p.state === 'UNKNOWN' && names.has(String(p.name))) return false;
      identities.add(key); names.add(String(p.name)); if (p.state === 'UNKNOWN') missing.add(String(p.name)); previous = key;
    }
    const evalRecord = record.evaluation as Plain;
    if (record.status === 'DISABLED') return evalRecord.status === 'NOT_REQUESTED' && packages.length === 0;
    if (record.status === 'REFUSED') return record.inventoryState === 'UNVERIFIED' && evalRecord.status === 'REFUSED' && evalRecord.reason === 'INVENTORY_UNVERIFIED' && packages.length === 0;
    if (record.status === 'EMPTY') return record.inventoryState === 'DECLARED' && evalRecord.status === 'NO_DECLARED_PACKAGES' && packages.length === 0;
    return record.status === 'READY' && record.inventoryState === 'DECLARED' && evalRecord.status === 'UNAVAILABLE' && packages.length > 0;
  } catch { return false; }
}
