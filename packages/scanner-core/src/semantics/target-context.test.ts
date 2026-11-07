import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTargetDigest, validateTargetContextV3 } from './target-context';

const body = {
  schemaVersion: 'scanner-target-v3' as const,
  n8nVersion: '1.2.3',
  edition: 'COMMUNITY' as const,
  deployment: 'SELF_HOSTED' as const,
  role: 'OWNER' as const,
  taskRunner: 'NATIVE' as const,
  communityPackages: [
    { name: '@scope/z-package', version: '2.0.0' },
    { name: 'a-package' },
  ],
  configuration: [
    { key: 'zeta', state: 'DISABLED' as const },
    { key: 'alpha', state: 'ENABLED' as const },
  ],
};

const withDigest = (value: object = body) => ({ ...value, contextDigest: createTargetDigest(value as never) });

describe('TargetContextV3 validation', () => {
  it('normalizes valid target data and returns a deeply frozen defensive copy', () => {
    const result = validateTargetContextV3(withDigest(), { allowedConfigurationKeys: ['alpha', 'zeta'] });
    expect(result).toEqual({
      ...body,
      communityPackages: [
        { name: '@scope/z-package', version: '2.0.0' },
        { name: 'a-package' },
      ],
      configuration: [
        { key: 'alpha', state: 'ENABLED' },
        { key: 'zeta', state: 'DISABLED' },
      ],
      contextDigest: createTargetDigest(body),
    });
    expect(Object.keys(result)).toEqual(['schemaVersion', 'n8nVersion', 'edition', 'deployment', 'role', 'taskRunner', 'communityPackages', 'configuration', 'contextDigest']);
    expect(Object.keys(result.communityPackages[0]!)).toEqual(['name', 'version']);
    expect(Object.keys(result.configuration[0]!)).toEqual(['key', 'state']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.communityPackages)).toBe(true);
    expect(Object.isFrozen(result.communityPackages[0])).toBe(true);
    expect(Object.isFrozen(result.configuration)).toBe(true);
    expect(Object.isFrozen(result.configuration[0])).toBe(true);
  });

  it('defaults absent known facts and computes the digest', () => {
    const result = validateTargetContextV3({ schemaVersion: 'scanner-target-v3' });
    expect(result).toEqual({
      schemaVersion: 'scanner-target-v3',
      edition: 'UNKNOWN',
      deployment: 'UNKNOWN',
      role: 'UNKNOWN',
      taskRunner: 'UNKNOWN',
      communityPackages: [],
      configuration: [],
      contextDigest: createTargetDigest({
        schemaVersion: 'scanner-target-v3', edition: 'UNKNOWN', deployment: 'UNKNOWN', role: 'UNKNOWN', taskRunner: 'UNKNOWN', communityPackages: [], configuration: [],
      }),
    });
  });

  it('accepts an omitted package version and treats omitted configuration state as unknown', () => {
    const result = validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: [{ name: 'example' }], configuration: [{ key: 'feature' }] });
    expect(result.communityPackages).toEqual([{ name: 'example' }]);
    expect(result.configuration).toEqual([{ key: 'feature', state: 'UNKNOWN' }]);
  });

  it('sorts package and configuration arrays with Unicode code-point ordering', () => {
    const result = validateTargetContextV3({
      schemaVersion: 'scanner-target-v3',
      communityPackages: [{ name: 'z' }, { name: 'a' }],
      configuration: [{ key: 'z' }, { key: 'a' }],
    });
    expect(result.communityPackages.map((item) => item.name)).toEqual(['a', 'z']);
    expect(result.configuration.map((item) => item.key)).toEqual(['a', 'z']);
  });

  it('recomputes and verifies contextDigest without hashing itself', () => {
    const digest = createTargetDigest(body);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(validateTargetContextV3({ ...body, contextDigest: digest }, { allowedConfigurationKeys: ['alpha', 'zeta'] }).contextDigest).toBe(digest);
    expect(createTargetDigest({ ...body, contextDigest: 'f'.repeat(64) } as never)).toBe(digest);
    expect(() => validateTargetContextV3({ ...body, contextDigest: 'f'.repeat(64) })).toThrow(/CONTEXT_DIGEST/);
  });

  it.each([
    'v1.2.3', '1.2', '01.2.3', '1.2.3-alpha..1', '1.2.3+build_1',
  ])('rejects malformed n8n SemVer %j', (version) => {
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', n8nVersion: version })).toThrow(TypeError);
  });

  it.each([
    'Uppercase', 'N8N-NODES-BASE', '@Scope/name', '@scope/', '@/name', '@@pkg', '@scope%2Fpkg', '@scope\\pkg', 'a%2fb', 'a\\b', '.hidden', '_hidden',
    '@scope/.hidden', '@scope/_hidden', 'cafe\u0301', 'e\u0301-pkg',
  ])('rejects non-canonical npm package name %j', (name) => {
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: [{ name }] })).toThrow(TypeError);
  });

  it.each([
    'v1.2.3', '1.2', '01.2.3', '1.2.3-alpha..1', '1.2.3+build_1',
  ])('rejects malformed community package SemVer %j', (version) => {
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: [{ name: 'example', version }] })).toThrow(TypeError);
  });

  it('admits two exact versions of one package as distinct pairs', () => {
    const result = validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: [{ name: 'same', version: '2.0.0' }, { name: 'same', version: '1.0.0' }] });
    expect(result.communityPackages).toEqual([{ name: 'same', version: '1.0.0' }, { name: 'same', version: '2.0.0' }]);
  });

  it('rejects duplicate pairs, versionless conflicts, and configuration keys', () => {
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: [{ name: 'same', version: '1.0.0' }, { name: 'same', version: '1.0.0' }] })).toThrow(/DUPLICATE_PACKAGE/);
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: [{ name: 'same' }, { name: 'same', version: '1.0.0' }] })).toThrow(/DUPLICATE_PACKAGE/);
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', configuration: [{ key: 'same' }, { key: 'same', state: 'ENABLED' }] })).toThrow(/DUPLICATE_CONFIGURATION_KEY/);
  });

  it('rejects unknown target keys before reading nested values', () => {
    let invoked = false;
    const input = { extra: true } as Record<string, unknown>;
    Object.defineProperty(input, 'communityPackages', {
      enumerable: true,
      get: () => { invoked = true; return []; },
    });
    expect(() => validateTargetContextV3(input)).toThrow(/UNKNOWN_KEY: target.extra/);
    expect(invoked).toBe(false);
  });

  it('rejects unknown nested keys before reading their values', () => {
    let invoked = false;
    const packageValue = { name: 'example', extra: true } as Record<string, unknown>;
    Object.defineProperty(packageValue, 'name', {
      enumerable: true,
      get: () => { invoked = true; return 'example'; },
    });
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: [packageValue] })).toThrow(/UNKNOWN_KEY: communityPackages\[0\]\.extra/);
    expect(invoked).toBe(false);
  });

  it('reads Set vocabularies without invoking an overridden iterator', () => {
    let invoked = false;
    const allowed = new Set(['known']);
    Object.defineProperty(allowed, Symbol.iterator, {
      configurable: true,
      get: () => { invoked = true; throw new Error('iterator'); },
    });
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', configuration: [{ key: 'known' }] }, { allowedConfigurationKeys: allowed })).not.toThrow();
    expect(invoked).toBe(false);
  });

  it('declares a closed serialized target shape with explicit collection requirements', () => {
    const schema = JSON.parse(readFileSync(new URL('../../../../schemas/scanner-target-v3.schema.json', import.meta.url), 'utf8')) as {
      additionalProperties: boolean;
      required: string[];
      $defs: Record<string, { additionalProperties?: boolean }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['schemaVersion', 'communityPackages', 'configuration', 'contextDigest']);
    expect(schema.$defs.package.additionalProperties).toBe(false);
    expect(schema.$defs.configuration.additionalProperties).toBe(false);
  });

  it('rejects unknown configuration keys when a catalogue vocabulary is supplied', () => {
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', configuration: [{ key: 'not-admitted' }] }, { allowedConfigurationKeys: ['known'] })).toThrow(/UNKNOWN_CONFIGURATION_KEY/);
  });

  it.each([
    ['lone high surrogate', '\ud800'],
    ['lone low surrogate', '\udc00'],
    ['NFD text', 'cafe\u0301'],
    ['NUL control', '\u0000'],
    ['unit-separator control', '\u001f'],
    ['DEL control', '\u007f'],
  ])('rejects unsafe configuration text in keys and allowed vocabularies (%s)', (_label, value) => {
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', configuration: [{ key: value }] })).toThrow(/INVALID_TEXT/);
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3' }, { allowedConfigurationKeys: [value] })).toThrow(/INVALID_TEXT/);
  });

  it('rejects unsafe validation options before invoking accessors', () => {
    let invoked = false;
    const options = {} as Record<string, unknown>;
    Object.defineProperty(options, 'allowedConfigurationKeys', {
      enumerable: true,
      get: () => { invoked = true; return ['known']; },
    });
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3' }, options)).toThrow(TypeError);
    expect(invoked).toBe(false);
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3' }, { extra: true } as never)).toThrow(/UNKNOWN_KEY: options.extra/);
  });

  it('enforces text and collection bounds', () => {
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', configuration: [{ key: 'x'.repeat(4097) }] })).toThrow(/INVALID_TEXT/);
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', configuration: Array.from({ length: 100_001 }, () => ({ key: 'x' })) })).toThrow(/UNSAFE_INPUT: configuration/);
  });


  it('rejects unknown keys, invalid enums, and invalid states', () => {
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', extra: true })).toThrow(/UNKNOWN_KEY/);
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', edition: 'OTHER' })).toThrow(TypeError);
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', configuration: [{ key: 'x', state: 'OTHER' }] })).toThrow(TypeError);
  });

  it('rejects accessor-backed records before invoking getters', () => {
    let invoked = false;
    const value = {} as Record<string, unknown>;
    Object.defineProperty(value, 'edition', { get: () => { invoked = true; return 'COMMUNITY'; }, enumerable: true });
    expect(() => validateTargetContextV3(value)).toThrow(TypeError);
    expect(invoked).toBe(false);
  });

  it('rejects hostile proxies without reading through them', () => {
    let read = false;
    const hostile = new Proxy({ edition: 'COMMUNITY' }, {
      get: () => { read = true; throw new Error('getter'); },
      ownKeys: () => { throw new Error('ownKeys'); },
    });
    expect(() => validateTargetContextV3(hostile)).toThrow(TypeError);
    expect(read).toBe(false);
  });

  it('rejects sparse and non-canonical arrays', () => {
    const sparse = [] as unknown[];
    sparse.length = 1;
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: sparse })).toThrow(TypeError);
    expect(() => validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: Object.freeze([{ name: 'a' }]) })).not.toThrow();
  });

  it('rejects symbol properties and prototype pollution keys', () => {
    const symbolValue = { communityPackages: [] };
    Object.defineProperty(symbolValue, Symbol('hidden'), { value: true });
    expect(() => validateTargetContextV3(symbolValue)).toThrow(TypeError);
    const polluted = JSON.parse('{"__proto__":{},"communityPackages":[]}');
    expect(() => validateTargetContextV3(polluted)).toThrow(/UNKNOWN_KEY/);
  });
});
