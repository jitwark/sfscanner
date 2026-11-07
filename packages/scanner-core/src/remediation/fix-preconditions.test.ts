import { describe, expect, it } from 'vitest';
import {
  canonicalJsonSha256,
  endpointTargetIdentitySha256,
  MISSING_OR_INVALID_CREDENTIAL_MAPPING,
  MISSING_OR_INVALID_ENDPOINT,
  readCredentialInventory,
  readJsonPointerValue,
  validateCredentialMapping,
  validateEndpointSelection,
} from './fix-preconditions';

const NODE = 'a'.repeat(64);
const OTHER_NODE = 'b'.repeat(64);
const COMPATIBILITY = 'c'.repeat(64);
const CURRENT_ENDPOINT = 'http://insecure.example.com';
const REPLACEMENT_ENDPOINT = 'https://api.example.com/v2';

const INVENTORY = {
  schemaVersion: 'selected-credential-inventory-v1',
  credentials: [{ credentialId: 'cred-1', type: 'httpHeaderAuth' }],
};

function inventoryDigest(): string {
  const read = readCredentialInventory(INVENTORY);
  if (!read.ok) throw new Error('fixture inventory refused');
  return read.digest;
}

function mapping(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeIdentityDigest: NODE,
    credentialType: 'httpHeaderAuth',
    credentialId: 'cred-1',
    inventoryDigest: inventoryDigest(),
    ...overrides,
  };
}

function identity(url: string): string {
  const digest = endpointTargetIdentitySha256(url);
  if (digest === undefined) throw new Error('fixture endpoint must be an http(s) URL');
  return digest;
}

function selection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeIdentityDigest: NODE,
    oldEndpointSha256: canonicalJsonSha256(CURRENT_ENDPOINT),
    replacementUrl: REPLACEMENT_ENDPOINT,
    targetIdentityDigest: identity(REPLACEMENT_ENDPOINT),
    compatibilityDigest: COMPATIBILITY,
    ...overrides,
  };
}

function mappingEvidence(input: Readonly<{ mapping?: unknown; inventory?: unknown; nodeIdentityDigest?: string }> = {}) {
  return validateCredentialMapping({
    mapping: input.mapping ?? mapping(),
    inventory: input.inventory ?? INVENTORY,
    nodeIdentityDigest: input.nodeIdentityDigest ?? NODE,
  });
}

function endpointEvidence(input: Readonly<{ selection?: unknown; nodeIdentityDigest?: string; currentEndpoint?: unknown }> = {}) {
  return validateEndpointSelection({
    selection: input.selection ?? selection(),
    nodeIdentityDigest: input.nodeIdentityDigest ?? NODE,
    currentEndpoint: 'currentEndpoint' in input ? input.currentEndpoint : CURRENT_ENDPOINT,
  });
}

const CREDENTIAL_REFUSAL = Object.freeze({ ok: false, reason: MISSING_OR_INVALID_CREDENTIAL_MAPPING });
const ENDPOINT_REFUSAL = Object.freeze({ ok: false, reason: MISSING_OR_INVALID_ENDPOINT });

describe('readCredentialInventory', () => {
  it('accepts a selected inventory and exposes a stable digest without secrets', () => {
    const read = readCredentialInventory(INVENTORY);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(Object.keys(read.inventory).sort()).toEqual(['credentials', 'schemaVersion']);
    expect(Object.isFrozen(read.inventory)).toBe(true);
    expect(read.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(read.digest).toBe(canonicalJsonSha256(INVENTORY));
    expect(Object.isFrozen(read)).toBe(true);
  });

  it('refuses unknown fields, duplicate IDs, expressions and provider tokens', () => {
    expect(readCredentialInventory({ ...INVENTORY, secret: 'value' })).toEqual(CREDENTIAL_REFUSAL);
    expect(readCredentialInventory({
      schemaVersion: 'selected-credential-inventory-v1',
      credentials: [
        { credentialId: 'cred-1', type: 'httpHeaderAuth' },
        { credentialId: 'cred-1', type: 'httpBasicAuth' },
      ],
    })).toEqual(CREDENTIAL_REFUSAL);
    expect(readCredentialInventory({
      schemaVersion: 'selected-credential-inventory-v1',
      credentials: [{ credentialId: '{{ $env.TOKEN }}', type: 'httpHeaderAuth' }],
    })).toEqual(CREDENTIAL_REFUSAL);
    expect(readCredentialInventory({
      schemaVersion: 'selected-credential-inventory-v1',
      credentials: [{ credentialId: 'sk_live_12345678', type: 'httpHeaderAuth' }],
    })).toEqual(CREDENTIAL_REFUSAL);
  });

  it('refuses a wrong schema version, non-object input and padded strings', () => {
    expect(readCredentialInventory({ ...INVENTORY, schemaVersion: 'v2' })).toEqual(CREDENTIAL_REFUSAL);
    expect(readCredentialInventory(undefined)).toEqual(CREDENTIAL_REFUSAL);
    expect(readCredentialInventory([])).toEqual(CREDENTIAL_REFUSAL);
    expect(readCredentialInventory({
      schemaVersion: 'selected-credential-inventory-v1',
      credentials: [{ credentialId: ' cred-1 ', type: 'httpHeaderAuth' }],
    })).toEqual(CREDENTIAL_REFUSAL);
  });
});

describe('validateCredentialMapping', () => {
  it('accepts an existing ID and type proven by the caller inventory', () => {
    const result = mappingEvidence();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.code).toBe('CREDENTIAL_MAPPING');
    expect(result.evidence.evidenceDigest).toBe(canonicalJsonSha256(mapping()));
    expect(Object.isFrozen(result.mapping)).toBe(true);
    expect(result.mapping).not.toHaveProperty('value');
  });

  it('refuses an absent credential ID', () => {
    expect(mappingEvidence({ mapping: mapping({ credentialId: 'cred-missing' }) })).toEqual(CREDENTIAL_REFUSAL);
  });

  it('refuses a credential of the wrong type', () => {
    expect(mappingEvidence({ mapping: mapping({ credentialType: 'httpBasicAuth' }) })).toEqual(CREDENTIAL_REFUSAL);
  });

  it('refuses an inventory digest that no longer matches the inventory', () => {
    expect(mappingEvidence({ mapping: mapping({ inventoryDigest: 'd'.repeat(64) }) })).toEqual(CREDENTIAL_REFUSAL);
    expect(mappingEvidence({ mapping: mapping({ inventoryDigest: 'not-a-digest' }) })).toEqual(CREDENTIAL_REFUSAL);
  });

  it('refuses a mapping selected for another node', () => {
    expect(mappingEvidence({ mapping: mapping({ nodeIdentityDigest: OTHER_NODE }) })).toEqual(CREDENTIAL_REFUSAL);
  });

  it('refuses secret values and unknown fields in the mapping', () => {
    expect(mappingEvidence({ mapping: mapping({ credentialId: 'sk_live_12345678' }) })).toEqual(CREDENTIAL_REFUSAL);
    expect(mappingEvidence({ mapping: mapping({ credentialType: '{{ $env.AUTH }}' }) })).toEqual(CREDENTIAL_REFUSAL);
    expect(mappingEvidence({ mapping: { ...mapping(), value: 'secret' } })).toEqual(CREDENTIAL_REFUSAL);
  });

  it('refuses without a caller inventory proof', () => {
    expect(validateCredentialMapping({ mapping: mapping(), inventory: undefined, nodeIdentityDigest: NODE }))
      .toEqual(CREDENTIAL_REFUSAL);
  });
});

describe('validateEndpointSelection', () => {
  it('accepts an explicit replacement with target identity and compatibility proof', () => {
    const result = endpointEvidence();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence).toEqual({ code: 'ENDPOINT_COMPATIBILITY', evidenceDigest: COMPATIBILITY });
    expect(result.selection.replacementUrl).toBe(REPLACEMENT_ENDPOINT);
    expect(Object.isFrozen(result.selection)).toBe(true);
  });

  it('refuses a stale old-endpoint digest when the workflow endpoint changed', () => {
    expect(endpointEvidence({ currentEndpoint: 'http://changed.example.com' })).toEqual(ENDPOINT_REFUSAL);
  });

  it('refuses a replacement selected for another node', () => {
    expect(endpointEvidence({ selection: selection({ nodeIdentityDigest: OTHER_NODE }) })).toEqual(ENDPOINT_REFUSAL);
  });

  it('refuses an inferred HTTP-to-HTTPS-only substitution', () => {
    const sameHost = 'https://insecure.example.com';
    expect(endpointEvidence({
      selection: selection({ replacementUrl: sameHost, targetIdentityDigest: identity(sameHost) }),
    })).toEqual(ENDPOINT_REFUSAL);
  });

  it('refuses a replacement identical to the current endpoint', () => {
    expect(endpointEvidence({
      selection: selection({
        replacementUrl: CURRENT_ENDPOINT,
        targetIdentityDigest: identity(CURRENT_ENDPOINT),
      }),
    })).toEqual(ENDPOINT_REFUSAL);
    expect(endpointEvidence({
      selection: selection({
        replacementUrl: `${CURRENT_ENDPOINT}/`,
        targetIdentityDigest: identity(`${CURRENT_ENDPOINT}/`),
      }),
    })).toEqual(ENDPOINT_REFUSAL);
  });

  it('refuses missing or inconsistent compatibility and target evidence', () => {
    expect(endpointEvidence({ selection: selection({ compatibilityDigest: 'not-a-digest' }) })).toEqual(ENDPOINT_REFUSAL);
    expect(endpointEvidence({
      selection: selection({ targetIdentityDigest: identity('https://other.example.com') }),
    })).toEqual(ENDPOINT_REFUSAL);
  });

  it('refuses credential-bearing, expression and non-HTTP replacements', () => {
    for (const replacementUrl of [
      'https://user:pass@api.example.com/v2',
      '{{ $env.ENDPOINT }}',
      'ftp://api.example.com/v2',
      'not a url',
    ]) {
      expect(endpointEvidence({
        selection: selection({ replacementUrl, targetIdentityDigest: COMPATIBILITY }),
      })).toEqual(ENDPOINT_REFUSAL);
    }
  });

  it('refuses an observation that is not a string endpoint', () => {
    expect(endpointEvidence({ currentEndpoint: { url: CURRENT_ENDPOINT } })).toEqual(ENDPOINT_REFUSAL);
    expect(endpointEvidence({ currentEndpoint: undefined })).toEqual(ENDPOINT_REFUSAL);
  });
});

describe('readJsonPointerValue', () => {
  const root = { nodes: [{ parameters: { url: CURRENT_ENDPOINT } }] };

  it('reads the exact member the suggestion resource points at', () => {
    expect(readJsonPointerValue(root, '/nodes/0/parameters/url')).toEqual({ ok: true, value: CURRENT_ENDPOINT });
    expect(readJsonPointerValue(root, '')).toEqual({ ok: true, value: root });
  });

  it('refuses malformed pointers, prototype members and non-canonical indexes', () => {
    expect(readJsonPointerValue(root, '/nodes/0~2/parameters')).toEqual({ ok: false });
    expect(readJsonPointerValue(root, '/__proto__')).toEqual({ ok: false });
    expect(readJsonPointerValue(root, '/nodes/00/parameters/url')).toEqual({ ok: false });
    expect(readJsonPointerValue(root, '/nodes/1/parameters/url')).toEqual({ ok: false });
  });
});
