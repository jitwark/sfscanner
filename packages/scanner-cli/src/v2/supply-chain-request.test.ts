import { describe, expect, it } from 'vitest';
import { validateTargetContextV3 } from '@hub/scanner-core/v2';
import { buildSupplyChainRequest, validateSupplyChainRequestV2 } from './supply-chain-request';

const target = validateTargetContextV3({
  schemaVersion: 'scanner-target-v3', edition: 'COMMUNITY', deployment: 'SELF_HOSTED', role: 'OWNER', taskRunner: 'NATIVE',
  communityPackages: [{ name: 'pkg', version: '2.0.0' }, { name: 'pkg', version: '1.2.3' }, { name: 'missing-version' }], configuration: [],
});

describe('supply-chain request v2', () => {
  it('keeps disabled, empty, unverified, and unavailable requested states distinct', () => {
    const disabled = buildSupplyChainRequest({ enabled: false, target, inventoryState: 'DECLARED' });
    const empty = buildSupplyChainRequest({ enabled: true, target: validateTargetContextV3({ schemaVersion: 'scanner-target-v3', communityPackages: [], configuration: [] }), inventoryState: 'DECLARED' });
    const unverified = buildSupplyChainRequest({ enabled: true, target, inventoryState: 'UNVERIFIED' });
    const unavailable = buildSupplyChainRequest({ enabled: true, target, inventoryState: 'DECLARED' });
    expect(disabled).toMatchObject({ status: 'DISABLED', inventoryState: 'DECLARED', evaluation: { status: 'NOT_REQUESTED', reason: 'NONE' }, packages: [] });
    expect(empty).toMatchObject({ status: 'EMPTY', evaluation: { status: 'NO_DECLARED_PACKAGES', reason: 'NONE' }, packages: [] });
    expect(unverified).toMatchObject({ status: 'REFUSED', inventoryState: 'UNVERIFIED', evaluation: { status: 'REFUSED', reason: 'INVENTORY_UNVERIFIED' }, packages: [] });
    expect(unavailable).toMatchObject({ status: 'READY', inventoryState: 'DECLARED', evaluation: { status: 'UNAVAILABLE', reason: 'NO_ADMITTED_SNAPSHOT' } });
    for (const value of [disabled, empty, unverified, unavailable]) expect(validateSupplyChainRequestV2(value)).toBe(true);
  });

  it('uses exact name/version identity and canonical order', () => {
    const request = buildSupplyChainRequest({ enabled: true, target, inventoryState: 'DECLARED' });
    expect(request.packages).toEqual([
      { state: 'UNKNOWN', name: 'missing-version', reason: 'VERSION_MISSING' },
      { state: 'KNOWN', name: 'pkg', version: '1.2.3', inventoryDigest: target.contextDigest },
      { state: 'KNOWN', name: 'pkg', version: '2.0.0', inventoryDigest: target.contextDigest },
    ]);
    expect(Object.keys(request)).toEqual(['schemaVersion', 'status', 'inventoryDigest', 'inventoryState', 'evaluation', 'packages']);
    expect(JSON.stringify(request)).not.toMatch(/provenance|rights|completeness|safe/iu);
  });

  it('freezes the request without mutating the v3 target', () => {
    const before = JSON.stringify(target);
    const request = buildSupplyChainRequest({ enabled: true, target, inventoryState: 'DECLARED' });
    expect(JSON.stringify(target)).toBe(before);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.evaluation)).toBe(true);
    expect(Object.isFrozen(request.packages)).toBe(true);
    expect(() => (request.packages as unknown[]).push({})).toThrow(TypeError);
  });
});
