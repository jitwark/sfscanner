import { describe, expect, it } from 'vitest';
import { validateScannerResultV2 } from '@hub/contracts/scanner-v2-result';
import { scanWorkflowV2 } from '../v2/scan-workflow';
import { validateTargetContextV3 } from './target-context';
import { createTargetContextDigestV3 } from '@hub/contracts/scanner-target-v3';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJsonBytes } from '../canonical-json';

const scan = (target: unknown) => {
  const outcome = scanWorkflowV2({ bytes: new TextEncoder().encode('{"nodes":[],"connections":{}}'),
    profile: { id: 'beta-default', version: '2.0.0' }, target,
    advisoryRequest: { requested: true, inventoryState: 'DECLARED' } });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(outcome.code);
  expect(validateScannerResultV2(outcome.result).ok).toBe(true);
  return structuredClone(outcome.result);
};

describe('published target content binding', () => {
  it.each([
    { n8nVersion: '9.9.9' }, { edition: 'ENTERPRISE' }, { deployment: 'CLOUD' },
    { role: 'ADMIN' }, { taskRunner: 'NATIVE' }, { configuration: [{ key: 'alpha', state: 'ENABLED' }] },
  ])('binds all remaining target fields: %j', (mutation) => {
    const result = scan({ schemaVersion: 'scanner-target-v3' });
    Object.assign(result.target, mutation);
    expect(validateScannerResultV2(result)).toEqual({ ok: false, errors: ['target.contextDigest does not match target contents'] });
  });

  it('rejects a changed target and matching coverage pair with the stale admitted digest', () => {
    const result = scan({ schemaVersion: 'scanner-target-v3', communityPackages: [{ name: 'pkg', version: '1.2.3' }] });
    result.target.communityPackages = [{ name: 'evil', version: '9.9.9' }];
    const coverage = result.facts.find((fact) => fact.kind === 'advisory.package-coverage.v1')!;
    coverage.properties = { ...coverage.properties, packageName: 'evil', packageVersion: '9.9.9' };
    expect(() => validateTargetContextV3(result.target)).toThrow('CONTEXT_DIGEST_MISMATCH');
    const checked = validateScannerResultV2(result);
    expect(checked).toEqual({ ok: false, errors: ['target.contextDigest does not match target contents'] });
  });

  it('accepts normalized pair order independently of input and object-key order', () => {
    const input = { schemaVersion: 'scanner-target-v3', communityPackages: [
      { version: '2.0.0', name: 'pkg' }, { version: '1.2.3', name: 'pkg' },
    ] };
    const result = scan(input);
    const reordered = validateTargetContextV3({ ...input, communityPackages: [...input.communityPackages].reverse() });
    expect(result.target).toEqual(reordered);
    expect(result.target.communityPackages.map((pair) => pair.version)).toEqual(['1.2.3', '2.0.0']);
  });

  it('preserves the existing canonical bytes and Unicode code-point configuration order', () => {
    const normalized = validateTargetContextV3({ schemaVersion: 'scanner-target-v3', n8nVersion: '1.2.3-RC.1+Build.7',
      communityPackages: [{ name: 'z' }, { name: 'pkg', version: '2.0.0' }, { name: 'pkg', version: '1.2.3' }],
      configuration: [{ key: '\u{10000}', state: 'ENABLED' }, { key: '\ue000', state: 'DISABLED' }, { key: 'alpha' }] });
    expect(normalized.configuration.map((item) => item.key)).toEqual(['alpha', '\ue000', '\u{10000}']);
    const { contextDigest, ...body } = normalized;
    expect(contextDigest).toBe(bytesToHex(sha256(canonicalJsonBytes(body))));
    expect(createTargetContextDigestV3({ ...body, configuration: [...body.configuration].reverse(),
      communityPackages: [...body.communityPackages].reverse() })).toBe(contextDigest);
    expect(() => createTargetContextDigestV3({ ...body, schemaVersion: 'scanner-target-v2' } as never)).toThrow('INVALID_SCHEMA_VERSION');
  });
});
