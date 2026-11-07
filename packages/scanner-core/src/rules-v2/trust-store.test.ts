import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TEST_PUBLIC_KEY_A,
  TEST_PUBLIC_KEY_B,
  encodeUnpaddedBase64Url,
  keyIdFor,
  trustKey,
  trustStoreDocument,
} from './__fixtures__/trust-fixtures';
import { decodeUnpaddedBase64UrlV2, lookupTrustKeyV2, validateTrustStoreV2, type TrustKeyV2, type TrustStoreV2 } from './trust-store';

const INVALID = { ok: false, code: 'TRUST_STORE_INVALID', errors: ['TRUST_STORE_INVALID'] };

function admittedStore(version: string, keys: readonly TrustKeyV2[]): TrustStoreV2 {
  const result = validateTrustStoreV2(trustStoreDocument(version, keys));
  if (!result.ok) throw new Error('fixture trust store was rejected');
  return result.store;
}

type SchemaNode = Record<string, unknown>;

function schemaRefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaRefs);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(key === '$ref' && typeof item === 'string' ? [item] : []),
    ...schemaRefs(item),
  ]);
}

/** Deliberately partial JSON Schema (Draft 2020-12) evaluator: exactly the keywords this schema uses. */
function schemaErrors(node: SchemaNode, value: unknown, defs: Record<string, SchemaNode>, path = ''): string[] {
  if (typeof node.$ref === 'string') {
    const target = defs[node.$ref.slice('#/$defs/'.length)];
    return target === undefined ? [`${path}: unresolved $ref`] : schemaErrors(target, value, defs, path);
  }
  const errors: string[] = [];
  if ('const' in node && value !== node.const) errors.push(`${path}: const`);
  if (Array.isArray(node.enum) && !(node.enum as unknown[]).includes(value)) errors.push(`${path}: enum`);
  if (node.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [...errors, `${path}: type object`];
    const properties = (node.properties ?? {}) as Record<string, SchemaNode>;
    for (const name of (node.required ?? []) as string[]) if (!(name in value)) errors.push(`${path}/required: ${name}`);
    for (const [name, child] of Object.entries(value)) {
      const property = properties[name];
      if (property === undefined) {
        if (node.additionalProperties === false) errors.push(`${path}/${name}: additionalProperty`);
      } else errors.push(...schemaErrors(property, child, defs, `${path}/${name}`));
    }
  }
  if (node.type === 'array') {
    if (!Array.isArray(value)) return [...errors, `${path}: type array`];
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) errors.push(`${path}: maxItems`);
    if (typeof node.minItems === 'number' && value.length < node.minItems) errors.push(`${path}: minItems`);
    const items = node.items as SchemaNode | undefined;
    if (items !== undefined) value.forEach((item, index) => errors.push(...schemaErrors(items, item, defs, `${path}/${index}`)));
  }
  if (typeof value === 'string') {
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern).test(value)) errors.push(`${path}: pattern`);
    if (typeof node.minLength === 'number' && value.length < node.minLength) errors.push(`${path}: minLength`);
    if (typeof node.maxLength === 'number' && value.length > node.maxLength) errors.push(`${path}: maxLength`);
  }
  return errors;
}

function readSchema(): { schema: SchemaNode; errors: (value: unknown) => string[] } {
  const schema = JSON.parse(readFileSync(new URL('../../../../schemas/scanner-trust-store-v2.schema.json', import.meta.url), 'utf8')) as SchemaNode;
  const defs = (schema.$defs ?? {}) as Record<string, SchemaNode>;
  return { schema, errors: (value) => schemaErrors(schema, value, defs) };
}

describe('scanner-core trust store authority', () => {
  it('admits a store whose digest covers its canonically ordered keys', () => {
    const result = validateTrustStoreV2(trustStoreDocument('2.0.0', [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]));
    if (!result.ok) throw new Error('expected admission');
    expect(result.store.schemaVersion).toBe('scanner-trust-store-v2');
    expect(result.store.version).toBe('2.0.0');
    expect(result.store.minimumVersion).toBe('2.0.0');
    expect(result.store.keys).toHaveLength(1);
    expect(result.store.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(result.store)).toBe(true);
    expect(Object.isFrozen(result.store.keys)).toBe(true);
    expect(Object.isFrozen(result.store.keys[0])).toBe(true);
  });

  it('orders keys canonically so document key order cannot change the digest', () => {
    const keys = [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE'), trustKey(TEST_PUBLIC_KEY_B, 'REVOKED')];
    const document = trustStoreDocument('2.0.0', keys);
    const forward = validateTrustStoreV2(document);
    const reversed = validateTrustStoreV2({ ...document, keys: [...keys].reverse() });
    if (!forward.ok || !reversed.ok) throw new Error('expected admission');
    expect(forward.store).toEqual(reversed.store);
    const order = forward.store.keys.map((key) => key.keyId);
    expect(order).toEqual([...order].sort());
  });

  it('rejects a digest that does not match the canonically ordered keys', () => {
    const document = trustStoreDocument('2.0.0', [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    expect(validateTrustStoreV2({ ...document, digest: '0'.repeat(64) })).toEqual(INVALID);
  });

  it('rejects a key id that is not the derived public-key hash', () => {
    const mislabeled = trustStoreDocument('2.0.0', [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE', keyIdFor(TEST_PUBLIC_KEY_B))]);
    const nonHex = trustStoreDocument('2.0.0', [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE', 'KEY-1')]);
    expect(validateTrustStoreV2(mislabeled)).toEqual(INVALID);
    expect(validateTrustStoreV2(nonHex)).toEqual(INVALID);
  });

  it('rejects malformed unpadded base64url public keys', () => {
    const encoded = encodeUnpaddedBase64Url(new Uint8Array(32).fill(1));
    const malformed = [`${encoded}=`, `${encoded.slice(0, 42)}+`, `${encoded.slice(0, 30)} ${encoded.slice(31)}`];
    for (const publicKey of malformed) {
      const key = { ...trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE'), publicKey };
      expect(validateTrustStoreV2(trustStoreDocument('2.0.0', [key]))).toEqual(INVALID);
    }
  });

  it('rejects a public key that is not exactly 32 bytes', () => {
    for (const length of [31, 33]) {
      const key = { ...trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE'), publicKey: encodeUnpaddedBase64Url(new Uint8Array(length).fill(1)) };
      expect(validateTrustStoreV2(trustStoreDocument('2.0.0', [key]))).toEqual(INVALID);
    }
  });

  it('rejects duplicate key ids and the same id presented over two public keys', () => {
    const key = trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE');
    const ambiguousKey = trustKey(TEST_PUBLIC_KEY_B, 'REVOKED', keyIdFor(TEST_PUBLIC_KEY_A));
    expect(validateTrustStoreV2(trustStoreDocument('2.0.0', [key, key]))).toEqual(INVALID);
    expect(validateTrustStoreV2(trustStoreDocument('2.0.0', [key, ambiguousKey]))).toEqual(INVALID);
  });

  it('rejects an unsupported key algorithm value', () => {
    const key = { ...trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE'), algorithm: 'ES256' } as unknown as TrustKeyV2;
    expect(validateTrustStoreV2(trustStoreDocument('2.0.0', [key]))).toEqual(INVALID);
  });

  it('rejects unknown or missing document fields', () => {
    const document = trustStoreDocument('2.0.0', [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    const { digest: _digest, ...withoutDigest } = document;
    expect(validateTrustStoreV2(withoutDigest)).toEqual(INVALID);
    expect(validateTrustStoreV2({ ...document, extra: true })).toEqual(INVALID);
  });

  it('rejects a store version below the recorded floor (rollback)', () => {
    const document = trustStoreDocument('1.9.0', [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    expect(validateTrustStoreV2(document, { minimumVersion: '2.0.0' })).toEqual({
      ok: false,
      code: 'TRUST_STORE_ROLLBACK',
      errors: ['TRUST_STORE_ROLLBACK'],
    });
  });

  it('rejects a store whose version is below its own recorded floor without any caller-supplied floor', () => {
    const document = trustStoreDocument('1.0.0', [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')], '2.0.0');
    expect(validateTrustStoreV2(document)).toEqual({
      ok: false,
      code: 'TRUST_STORE_ROLLBACK',
      errors: ['TRUST_STORE_ROLLBACK'],
    });
  });

  it('rejects a store when the caller raises the floor above the store version', () => {
    const document = trustStoreDocument('2.0.0', [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')], '2.0.0');
    expect(validateTrustStoreV2(document, { minimumVersion: '2.1.0' })).toEqual({
      ok: false,
      code: 'TRUST_STORE_ROLLBACK',
      errors: ['TRUST_STORE_ROLLBACK'],
    });
  });

  it('does not let a caller-supplied floor below the recorded floor disable it', () => {
    const document = trustStoreDocument('2.0.0', [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')], '2.1.0');
    expect(validateTrustStoreV2(document, { minimumVersion: '1.0.0' })).toEqual({
      ok: false,
      code: 'TRUST_STORE_ROLLBACK',
      errors: ['TRUST_STORE_ROLLBACK'],
    });
  });

  it('rejects a lowered floor whose digest was not recomputed, because the digest covers it', () => {
    const document = trustStoreDocument('2.0.0', [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')], '2.0.0');
    expect(validateTrustStoreV2({ ...document, minimumVersion: '1.0.0' })).toEqual(INVALID);
  });

  it('admits the recorded floor version itself, later versions, and an option floor at or below the store version', () => {
    const key = trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE');
    expect(validateTrustStoreV2(trustStoreDocument('2.0.0', [key]), { minimumVersion: '2.0.0' }).ok).toBe(true);
    expect(validateTrustStoreV2(trustStoreDocument('2.0.1', [key]), { minimumVersion: '2.0.0' }).ok).toBe(true);
    expect(validateTrustStoreV2(trustStoreDocument('0.1.0', [key])).ok).toBe(true);
  });

  it('fails closed on a malformed or unknown option instead of throwing', () => {
    const document = trustStoreDocument('2.0.0', [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    expect(() => validateTrustStoreV2(document, { minimumVersion: 'not-semver' })).not.toThrow();
    expect(validateTrustStoreV2(document, { minimumVersion: 'not-semver' })).toEqual(INVALID);
    expect(validateTrustStoreV2(document, { extra: true } as never)).toEqual(INVALID);
  });

  it('keeps an all-revoked store structurally valid while it admits nothing', () => {
    const result = validateTrustStoreV2(trustStoreDocument('2.1.0', [
      trustKey(TEST_PUBLIC_KEY_A, 'REVOKED'),
      trustKey(TEST_PUBLIC_KEY_B, 'REVOKED'),
    ]));
    if (!result.ok) throw new Error('expected a structurally valid all-revoked store');
    expect(lookupTrustKeyV2(result.store, keyIdFor(TEST_PUBLIC_KEY_A)).status).toBe('REVOKED');
  });

  it('looks up an absent key id as UNKNOWN', () => {
    expect(lookupTrustKeyV2(admittedStore('2.0.0', [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]), 'f'.repeat(32))).toEqual({ status: 'UNKNOWN' });
  });

  it('returns undefined instead of throwing for a non-string base64url value', () => {
    expect(decodeUnpaddedBase64UrlV2(null as unknown as string, 64)).toBeUndefined();
    expect(decodeUnpaddedBase64UrlV2(undefined as unknown as string, 32)).toBeUndefined();
    expect(decodeUnpaddedBase64UrlV2({ length: 43 } as unknown as string, 32)).toBeUndefined();
  });
});

describe('scanner-core trust store schema artifact', () => {
  it('declares a closed Draft 2020-12 schema with local definitions only', () => {
    const { schema } = readSchema();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('scanner-trust-store-v2.schema.json');
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['schemaVersion', 'id', 'version', 'minimumVersion', 'keys', 'digest']);
    expect(schema.properties).toMatchObject({
      schemaVersion: { const: 'scanner-trust-store-v2' },
      minimumVersion: { $ref: '#/$defs/semver' },
    });
    expect(schema.$defs).toEqual(expect.objectContaining({ text: expect.anything(), semver: expect.anything(), key: expect.anything() }));
    expect(schemaRefs(schema).every((ref) => ref.startsWith('#/'))).toBe(true);
  });

  it('accepts a canonical trust-store document and fails an invalid status enum and key length', () => {
    const { errors } = readSchema();
    const document = trustStoreDocument('2.0.0', [trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE')]);
    expect(errors(document)).toEqual([]);
    const rejected = { ...document, keys: [{ ...trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE'), status: 'DISABLED' }] };
    expect(errors(rejected)).toContain('/keys/0/status: enum');
    const shortKey = { ...document, keys: [{ ...trustKey(TEST_PUBLIC_KEY_A, 'ACTIVE'), publicKey: encodeUnpaddedBase64Url(new Uint8Array(31)) }] };
    expect(errors(shortKey)).toContain('/keys/0/publicKey: pattern');
    const { minimumVersion: _minimumVersion, ...withoutFloor } = document;
    expect(errors(withoutFloor)).toContain('/required: minimumVersion');
  });
});
