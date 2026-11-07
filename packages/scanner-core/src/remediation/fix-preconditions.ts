import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { classifyProviderToken } from '../analyzers/secrets/provider-token-registry';
import { canonicalJsonBytes } from '../canonical-json';
import { freeze } from '../workflow-v2/workflow-digest';
import type { FixPrerequisiteEvidenceV1, Sha256V1 } from './fix-suggestion';
import { decodeJsonPointer } from './json-patch';

export const MISSING_OR_INVALID_CREDENTIAL_MAPPING = 'MISSING_OR_INVALID_CREDENTIAL_MAPPING' as const;
export const MISSING_OR_INVALID_ENDPOINT = 'MISSING_OR_INVALID_ENDPOINT' as const;
export const CREDENTIAL_INVENTORY_SCHEMA = 'selected-credential-inventory-v1' as const;

export type CredentialMappingRefusalV1 = Readonly<{ ok: false; reason: typeof MISSING_OR_INVALID_CREDENTIAL_MAPPING }>;
export type EndpointSelectionRefusalV1 = Readonly<{ ok: false; reason: typeof MISSING_OR_INVALID_ENDPOINT }>;

export type CredentialInventoryEntryV1 = Readonly<{ credentialId: string; type: string }>;
export type CredentialInventoryV1 = Readonly<{
  schemaVersion: typeof CREDENTIAL_INVENTORY_SCHEMA;
  credentials: readonly CredentialInventoryEntryV1[];
}>;
export type SelectedCredentialMappingV1 = Readonly<{
  nodeIdentityDigest: Sha256V1; credentialType: string; credentialId: string; inventoryDigest: Sha256V1;
}>;
export type SelectedEndpointV1 = Readonly<{
  nodeIdentityDigest: Sha256V1; oldEndpointSha256: Sha256V1; replacementUrl: string;
  targetIdentityDigest: Sha256V1; compatibilityDigest: Sha256V1;
}>;

export type CredentialInventoryReadV1 =
  | Readonly<{ ok: true; inventory: CredentialInventoryV1; digest: Sha256V1 }>
  | CredentialMappingRefusalV1;
export type CredentialMappingCheckV1 = Readonly<{ mapping: unknown; inventory: unknown; nodeIdentityDigest: string }>;
export type CredentialMappingValidationV1 =
  | Readonly<{ ok: true; mapping: SelectedCredentialMappingV1; evidence: FixPrerequisiteEvidenceV1 }>
  | CredentialMappingRefusalV1;
export type EndpointSelectionCheckV1 = Readonly<{
  selection: unknown; nodeIdentityDigest: string; currentEndpoint: unknown;
}>;
export type EndpointSelectionValidationV1 =
  | Readonly<{ ok: true; selection: SelectedEndpointV1; evidence: FixPrerequisiteEvidenceV1 }>
  | EndpointSelectionRefusalV1;

const CREDENTIAL_REFUSAL: CredentialMappingRefusalV1 = Object.freeze({
  ok: false, reason: MISSING_OR_INVALID_CREDENTIAL_MAPPING,
});
const ENDPOINT_REFUSAL: EndpointSelectionRefusalV1 = Object.freeze({
  ok: false, reason: MISSING_OR_INVALID_ENDPOINT,
});
const INVENTORY_KEYS = ['schemaVersion', 'credentials'] as const;
const CREDENTIAL_KEYS = ['credentialId', 'type'] as const;
const MAPPING_KEYS = ['nodeIdentityDigest', 'credentialType', 'credentialId', 'inventoryDigest'] as const;
const ENDPOINT_KEYS = [
  'nodeIdentityDigest', 'oldEndpointSha256', 'replacementUrl', 'targetIdentityDigest', 'compatibilityDigest',
] as const;
const CANONICAL_INDEX = /^(?:0|[1-9][0-9]*)$/;
const MAX_URL_CHARS = 2_048;
const NOT_FOUND: Readonly<{ ok: false }> = Object.freeze({ ok: false });

/** SHA-256 over canonical JSON bytes, so a digest never depends on member order or whitespace. */
export function canonicalJsonSha256(value: unknown): Sha256V1 {
  return bytesToHex(sha256(canonicalJsonBytes(value)));
}

/**
 * Reads the selected credential inventory. The inventory lists IDs and types only; any other
 * member — a value, a token, an expression — is not a selected inventory.
 */
export function readCredentialInventory(input: unknown): CredentialInventoryReadV1 {
  const record = asRecord(input);
  if (!record || !exactKeys(record, INVENTORY_KEYS)) return CREDENTIAL_REFUSAL;
  if (record.schemaVersion !== CREDENTIAL_INVENTORY_SCHEMA || !Array.isArray(record.credentials)) {
    return CREDENTIAL_REFUSAL;
  }
  const credentials: CredentialInventoryEntryV1[] = [];
  const seen = new Set<string>();
  for (const entry of record.credentials) {
    const item = asRecord(entry);
    if (!item || !exactKeys(item, CREDENTIAL_KEYS)) return CREDENTIAL_REFUSAL;
    if (!isSafeText(item.credentialId) || !isSafeText(item.type) || seen.has(item.credentialId)) {
      return CREDENTIAL_REFUSAL;
    }
    seen.add(item.credentialId);
    credentials.push(Object.freeze({ credentialId: item.credentialId, type: item.type }));
  }
  const inventory: CredentialInventoryV1 = Object.freeze({
    schemaVersion: CREDENTIAL_INVENTORY_SCHEMA,
    credentials: Object.freeze(credentials),
  });
  return freeze({ ok: true, inventory, digest: canonicalJsonSha256(inventory) } satisfies CredentialInventoryReadV1);
}

/**
 * Binds one user-selected credential to the node and proves it against the caller's inventory.
 * Nothing is inferred from a finding: an absent ID, a wrong type, a stale inventory digest or a
 * mapping for another node is refused rather than repaired.
 */
export function validateCredentialMapping(input: CredentialMappingCheckV1): CredentialMappingValidationV1 {
  const inventory = readCredentialInventory(input.inventory);
  if (!inventory.ok) return CREDENTIAL_REFUSAL;
  const record = asRecord(input.mapping);
  if (!record || !exactKeys(record, MAPPING_KEYS)) return CREDENTIAL_REFUSAL;
  const { nodeIdentityDigest, credentialType, credentialId, inventoryDigest } = record;
  if (!isSha256(nodeIdentityDigest) || !isSha256(inventoryDigest) || !isSha256(input.nodeIdentityDigest)) {
    return CREDENTIAL_REFUSAL;
  }
  if (!isSafeText(credentialType) || !isSafeText(credentialId)) return CREDENTIAL_REFUSAL;
  if (nodeIdentityDigest !== input.nodeIdentityDigest || inventoryDigest !== inventory.digest) return CREDENTIAL_REFUSAL;
  const selected = inventory.inventory.credentials.find((entry) => entry.credentialId === credentialId);
  if (!selected || selected.type !== credentialType) return CREDENTIAL_REFUSAL;
  const mapping: SelectedCredentialMappingV1 = Object.freeze({
    nodeIdentityDigest, credentialType, credentialId, inventoryDigest,
  });
  return freeze({
    ok: true,
    mapping,
    evidence: Object.freeze({ code: 'CREDENTIAL_MAPPING', evidenceDigest: canonicalJsonSha256(mapping) }),
  } satisfies CredentialMappingValidationV1);
}

/** Identity of an endpoint destination: the canonical origin of the selected replacement URL. */
export function endpointTargetIdentitySha256(url: string): Sha256V1 | undefined {
  const parsed = parseHttpUrl(url);
  return parsed === undefined ? undefined : canonicalJsonSha256(parsed.origin);
}

/**
 * Accepts an endpoint replacement only when the user selected it explicitly, the old endpoint is
 * still the observed one, and the destination identity plus compatibility evidence agree. A bare
 * HTTP-to-HTTPS scheme change is the inferred fix this contract refuses.
 */
export function validateEndpointSelection(input: EndpointSelectionCheckV1): EndpointSelectionValidationV1 {
  const record = asRecord(input.selection);
  if (!record || !exactKeys(record, ENDPOINT_KEYS)) return ENDPOINT_REFUSAL;
  const { nodeIdentityDigest, oldEndpointSha256, replacementUrl, targetIdentityDigest, compatibilityDigest } = record;
  if (!isSha256(nodeIdentityDigest) || !isSha256(oldEndpointSha256) || !isSha256(targetIdentityDigest)
    || !isSha256(compatibilityDigest) || !isSha256(input.nodeIdentityDigest)) return ENDPOINT_REFUSAL;
  if (nodeIdentityDigest !== input.nodeIdentityDigest) return ENDPOINT_REFUSAL;
  if (typeof input.currentEndpoint !== 'string' || input.currentEndpoint.length === 0) return ENDPOINT_REFUSAL;
  if (oldEndpointSha256 !== canonicalJsonSha256(input.currentEndpoint)) return ENDPOINT_REFUSAL;
  if (!isSafeText(replacementUrl) || replacementUrl === input.currentEndpoint) return ENDPOINT_REFUSAL;
  const replacement = parseHttpUrl(replacementUrl);
  if (!replacement || isHttpsOnlySubstitution(input.currentEndpoint, replacement)) return ENDPOINT_REFUSAL;
  const observed = parseHttpUrl(input.currentEndpoint);
  if (observed !== undefined && observed.href === replacement.href) return ENDPOINT_REFUSAL;
  if (endpointTargetIdentitySha256(replacementUrl) !== targetIdentityDigest) return ENDPOINT_REFUSAL;
  const selection: SelectedEndpointV1 = Object.freeze({
    nodeIdentityDigest, oldEndpointSha256, replacementUrl, targetIdentityDigest, compatibilityDigest,
  });
  return freeze({
    ok: true,
    selection,
    evidence: Object.freeze({ code: 'ENDPOINT_COMPATIBILITY', evidenceDigest: compatibilityDigest }),
  } satisfies EndpointSelectionValidationV1);
}

/** Reads one member from an already-parsed JSON tree without applying or guessing any change. */
export function readJsonPointerValue(
  root: unknown,
  pointer: string,
): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }> {
  const segments = decodeJsonPointer(pointer);
  if (segments === undefined) return NOT_FOUND;
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!CANONICAL_INDEX.test(segment)) return NOT_FOUND;
      const index = Number(segment);
      if (index >= current.length) return NOT_FOUND;
      current = current[index];
      continue;
    }
    const record = asRecord(current);
    if (!record || !Object.prototype.hasOwnProperty.call(record, segment)) return NOT_FOUND;
    current = record[segment];
  }
  return Object.freeze({ ok: true, value: current } satisfies { ok: true; value: unknown });
}

function parseHttpUrl(value: string): URL | undefined {
  if (value.length > MAX_URL_CHARS) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (parsed.username !== '' || parsed.password !== '') return undefined;
  return parsed;
}

function isHttpsOnlySubstitution(current: string, replacement: URL): boolean {
  let observed: URL;
  try {
    observed = new URL(current);
  } catch {
    return false;
  }
  return observed.protocol === 'http:' && replacement.protocol === 'https:'
    && observed.host === replacement.host && observed.pathname === replacement.pathname
    && observed.search === replacement.search && observed.hash === replacement.hash;
}

function isSafeText(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.startsWith('=')) {
    return false;
  }
  if (value.includes('$env.') || value.includes('CREDENTIAL_REPLACE_ME') || value.includes('{{')) return false;
  return classifyProviderToken(value) === undefined;
}

function isSha256(value: unknown): value is Sha256V1 {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
