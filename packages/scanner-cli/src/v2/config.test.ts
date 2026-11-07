import { describe, expect, it } from 'vitest';
import {
  ADMITTED_PROFILE_V2,
  BUILTIN_AUTHORITIES_V2,
  DEFAULT_SCAN_CONFIG_V2,
  loadExplicitConfig,
  type ScanConfigV2,
} from './config';

const base: ScanConfigV2 = { schemaVersion: 'n8n-scan-config-v2' };

function load(value: unknown, cli?: unknown) {
  return loadExplicitConfig(value, { configDirectory: 'C:\\workspace\\configs', cli });
}

describe('CLI v2 explicit configuration', () => {
  it('resolves a closed config with deterministic defaults', () => {
    const result = load(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual(DEFAULT_SCAN_CONFIG_V2);
    expect(result.config.profile).toBe('beta-default');
    expect(result.config).toEqual(expect.objectContaining({ format: 'json', failOn: 'INFO', concurrency: 1 }));
    expect(Object.isFrozen(result.config)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.config.include)).toBe(true);
  });

  it('accepts the pinned profile and built-in authority markers only', () => {
    const result = load({ ...base, profile: `${ADMITTED_PROFILE_V2.id}@${ADMITTED_PROFILE_V2.version}`, rules: 'builtin', catalogue: 'builtin' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.profile).toBe('beta-default');
    expect(BUILTIN_AUTHORITIES_V2.rules.signatureStatus).toBe('VERIFIED');
    expect(BUILTIN_AUTHORITIES_V2.semantics.id).toBe('scanner-core-builtins');
  });

  it('replaces config scalars and arrays with CLI values', () => {
    const result = load({ ...base, format: 'table', concurrency: 8, include: ['config/*.json'], exclude: ['config/node_modules/**'] }, {
      format: 'ndjson', concurrency: 2, include: ['cli/*.json'], exclude: ['cli/.git/**'], noColor: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual(expect.objectContaining({ format: 'ndjson', concurrency: 2, include: ['cli/*.json'], exclude: ['cli/.git/**'], noColor: true }));
  });

  it('normalizes local paths without exposing the config directory', () => {
    const result = load({ ...base, limits: '.\\limits.json', target: 'targets/../target.json', output: 'reports\\scan.json', inputs: ['workflows\\one.json'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual(expect.objectContaining({ limits: 'limits.json', target: 'target.json', output: 'reports/scan.json', inputs: ['workflows/one.json'] }));
    expect(JSON.stringify(result)).not.toContain('C:\\workspace');
    expect(JSON.stringify(result)).not.toContain('source');
  });

  it.each([
    ['unknown key', { ...base, future: true }],
    ['wrong type', { ...base, concurrency: '2' }],
    ['invalid range', { ...base, concurrency: 0 }],
    ['absolute artifact', { ...base, limits: 'C:\\secrets\\limits.json' }],
    ['remote artifact', { ...base, target: 'https://example.test/target.json' }],
    ['external rules', { ...base, rules: './rules.json' }],
    ['external catalogue', { ...base, catalogue: '../catalogue.json' }],
  ])('rejects %s before producing a config', (_name, value) => {
    const result = load(value);
    expect(result).toMatchObject({ ok: false, code: 'INVALID_CONFIG' });
    if (result.ok) return;
    expect(result.errors.join(' ')).not.toMatch(/C:\\|https?:|secrets|example|source-content/i);
    expect(Object.isFrozen(result.errors) && Object.isFrozen(result)).toBe(true);
  });

  it('rejects duplicate JSON keys and repeated config paths', () => {
    const duplicate = load('{"schemaVersion":"n8n-scan-config-v2","profile":"beta-default","profile":"beta-default"}');
    expect(duplicate).toMatchObject({ ok: false, code: 'INVALID_CONFIG' });
    const repeated = load(base, { configPath: 'one.json', config: 'two.json' });
    expect(repeated).toMatchObject({ ok: false, code: 'INVALID_CONFIG' });
  });

  it('keeps unsigned development disabled unless explicitly requested', () => {
    const implicit = load(base);
    expect(implicit.ok && implicit.config.allowUnsignedDevelopmentRules).toBe(false);
    const explicit = load({ ...base, allowUnsignedDevelopmentRules: true });
    expect(explicit.ok && explicit.config.allowUnsignedDevelopmentRules).toBe(true);
  });

  it('rejects unsafe arrays, paths, and excessive concurrency deterministically', () => {
    const values = [
      { ...base, include: ['../outside/**'] },
      { ...base, output: '//server/share/report.json' },
      { ...base, concurrency: 17 },
      { ...base, include: new Array(1025).fill('*.json') },
    ];
    for (const value of values) expect(load(value)).toMatchObject({ ok: false, code: 'INVALID_CONFIG' });
  });
  it('rejects accessor-backed and prototype-polluting inputs without reading them', () => {
    const values: unknown[] = [];
    Object.defineProperty(values, '0', { get: () => { throw new Error('must not read'); }, enumerable: true });
    expect(load({ ...base, include: values })).toMatchObject({ ok: false, code: 'INVALID_CONFIG' });
    expect(load('{"schemaVersion":"n8n-scan-config-v2","__proto__":{"leaked":true}}')).toMatchObject({ ok: false, code: 'INVALID_CONFIG' });
  });

  it('normalizes approvedDomains to lowercase, deduplicated, sorted order', () => {
    const loaded = loadExplicitConfig({ schemaVersion: 'n8n-scan-config-v2', approvedDomains: ['B.example', 'a.example', 'b.example'] });
    expect(loaded).toMatchObject({ ok: true, config: { approvedDomains: ['a.example', 'b.example'] } });
  });

  it('rejects an invalid approvedDomains item', () => {
    expect(loadExplicitConfig({ schemaVersion: 'n8n-scan-config-v2', approvedDomains: ['https://bad.example'] }).ok).toBe(false);
  });
});
