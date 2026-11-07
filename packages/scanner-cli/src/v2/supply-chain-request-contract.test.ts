import { describe, expect, it } from 'vitest';
import { validateSupplyChainRequestV2 } from './supply-chain-request';

const digest = 'a'.repeat(64);
const valid = (packages: readonly unknown[] = []) => ({
  schemaVersion: 'supply-chain-request-v2', status: packages.length === 0 ? 'EMPTY' : 'READY',
  inventoryDigest: digest, inventoryState: 'DECLARED',
  evaluation: packages.length === 0 ? { status: 'NO_DECLARED_PACKAGES', reason: 'NONE' } : { status: 'UNAVAILABLE', reason: 'NO_ADMITTED_SNAPSHOT' },
  packages,
});
const known = (name: string, version: string) => ({ state: 'KNOWN', name, version, inventoryDigest: digest });

describe('supply-chain-request-v2 closed carrier', () => {
  it('accepts exactly the six required keys and rejects unknown keys or symbols', () => {
    expect(validateSupplyChainRequestV2(valid([known('pkg', '1.0.0')]))).toBe(true);
    expect(validateSupplyChainRequestV2({ ...valid(), extra: true })).toBe(false);
    const symbol = valid(); Object.defineProperty(symbol, Symbol('x'), { value: true });
    expect(validateSupplyChainRequestV2(symbol)).toBe(false);
  });

  it('rejects a v1 reader document and mismatched evaluation states', () => {
    expect(validateSupplyChainRequestV2({ ...valid(), schemaVersion: 'supply-chain-request-v1' })).toBe(false);
    expect(validateSupplyChainRequestV2({ ...valid(), inventoryState: 'UNVERIFIED' })).toBe(false);
    expect(validateSupplyChainRequestV2({ ...valid(), status: 'READY' })).toBe(false);
    expect(validateSupplyChainRequestV2({ ...valid([known('pkg', '1.0.0')]), evaluation: { status: 'UNAVAILABLE', reason: 'SNAPSHOT_VALID' } })).toBe(false);
  });

  it('rejects accessors before invocation and malformed package pairs', () => {
    let accessed = false;
    const hostile = { ...valid([known('pkg', '1.0.0')]) };
    Object.defineProperty(hostile, 'packages', { enumerable: true, get: () => { accessed = true; return []; } });
    expect(validateSupplyChainRequestV2(hostile)).toBe(false);
    expect(accessed).toBe(false);
    expect(validateSupplyChainRequestV2(valid([known('pkg', 'v1.0.0')]))).toBe(false);
    expect(validateSupplyChainRequestV2(valid([known('Bad', '1.0.0')]))).toBe(false);
    expect(validateSupplyChainRequestV2(valid([{ state: 'UNKNOWN', name: 'pkg', reason: 'VERSION_INVALID' }]))).toBe(false);
  });
});
