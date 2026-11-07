import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { validateSupplyChainSnapshot } from './supply-chain-snapshot';

import { fixture, record, capturedAt } from './supply-chain-fixture.test-helper';
const now = Date.parse(capturedAt) + 60_000;
describe('supply-chain snapshot v1', () => {
  it('validates a pinned synthetic snapshot without wall-clock or environment reads', () => {
    const { bytes, pin } = fixture();
    const first = validateSupplyChainSnapshot(bytes, pin, now);
    const second = validateSupplyChainSnapshot(bytes, pin, now);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true, snapshot: { sourceId: 'synthetic-source', capturedAt, version: '1.0.0', records: 1 } });
    if (first.ok) expect(first.snapshot.sha256).toBe(pin.sha256);
  });

  it('rejects impossible pinned calendar dates and times while accepting valid leap-day captures and refusing non-ms instants', () => {
    const impossible = fixture(undefined, '2026-02-30T00:00:00Z');
    expect(validateSupplyChainSnapshot(impossible.bytes, impossible.pin, Date.parse('2026-03-02T00:00:00.000Z') + 60_000))
      .toMatchObject({ ok: false, reason: 'PIN_INVALID' });
    const hour24 = fixture(undefined, '2026-10-25T24:00:00Z');
    expect(validateSupplyChainSnapshot(hour24.bytes, hour24.pin, Date.parse('2026-10-26T00:00:00.000Z') + 60_000))
      .toMatchObject({ ok: false, reason: 'PIN_INVALID' });
    const leap = fixture(undefined, '2024-02-29T00:00:00.000Z');
    expect(validateSupplyChainSnapshot(leap.bytes, leap.pin, Date.parse('2024-02-29T00:00:00.000Z') + 60_000)).toMatchObject({ ok: true });
    const seconds = fixture(undefined, '2026-10-24T00:00:00Z');
    expect(validateSupplyChainSnapshot(seconds.bytes, seconds.pin, Date.parse('2026-10-24T00:00:00Z') + 60_000)).toMatchObject({ ok: false, reason: 'PIN_INVALID' });
  });

  it('rejects digest, source, capture and time-window mismatches as unavailable', () => {
    const { bytes, pin } = fixture();
    expect(validateSupplyChainSnapshot(bytes, { ...pin, sha256: 'b'.repeat(64) }, now)).toMatchObject({ ok: false, reason: 'DIGEST_MISMATCH' });
    expect(validateSupplyChainSnapshot(bytes, { ...pin, sourceId: 'other' }, now)).toMatchObject({ ok: false, reason: 'SOURCE_MISMATCH' });
    expect(validateSupplyChainSnapshot(bytes, { ...pin, capturedAt: '2026-10-24T00:00:01.000Z' }, now)).toMatchObject({ ok: false, reason: 'CAPTURE_MISMATCH' });
    expect(validateSupplyChainSnapshot(bytes, pin, now + 4_000_000)).toMatchObject({ ok: false, reason: 'SNAPSHOT_STALE' });
    expect(validateSupplyChainSnapshot(bytes, pin, Date.parse(capturedAt) - 1)).toMatchObject({ ok: false, reason: 'SNAPSHOT_FUTURE' });
  });

  it('rejects malformed bytes, JSON, schema, records and duplicate advisory IDs', () => {
    const { bytes, pin } = fixture();
    expect(validateSupplyChainSnapshot(new Uint8Array(5 * 1024 * 1024 + 1), pin, now)).toMatchObject({ ok: false, reason: 'SIZE_EXCEEDED' });
    const invalidJson = new TextEncoder().encode('{');
    expect(validateSupplyChainSnapshot(invalidJson, { ...pin, sha256: bytesToHex(sha256(invalidJson)) }, now)).toMatchObject({ ok: false, reason: 'INVALID_JSON' });
    const invalidUtf8 = new Uint8Array([0xff]);
    expect(validateSupplyChainSnapshot(invalidUtf8, { ...pin, sha256: bytesToHex(sha256(invalidUtf8)) }, now)).toMatchObject({ ok: false, reason: 'INVALID_UTF8' });
    const duplicate = fixture([record(), record()]);
    expect(validateSupplyChainSnapshot(duplicate.bytes, duplicate.pin, now)).toMatchObject({ ok: false, reason: 'DUPLICATE_ADVISORY' });
    const duplicateKeyBytes = new TextEncoder().encode(`{"schemaVersion":"scanner-advisories-v2","version":"1","sourceId":"synthetic-source","capturedAt":"${capturedAt}","records":[{"id":"ADV-1","packageName":"example-nodes","affected":{"clauses":[[{"op":"LT","version":"1.2.3"}]]},"fixedVersions":["1.2.3"],"reviewState":"WITHDRAWN","reviewState":"ADMITTED","sourceUrl":"https://example.test/advisories/ADV-1","sourceDigest":"${'a'.repeat(64)}","reviewedAt":"${capturedAt}"}]}`);
    expect(validateSupplyChainSnapshot(duplicateKeyBytes, { ...pin, sha256: bytesToHex(sha256(duplicateKeyBytes)) }, now)).toMatchObject({ ok: false, reason: 'DUPLICATE_KEY' });
    const malformed = fixture([record({ affected: { clauses: [[{ op: 'NEAR', version: '1.2.3' }]] } })]);
    expect(validateSupplyChainSnapshot(malformed.bytes, malformed.pin, now)).toMatchObject({ ok: false, reason: 'RECORD_INVALID' });
    const badVersion = fixture([record({ fixedVersions: ['1.2'] })]);
    expect(validateSupplyChainSnapshot(badVersion.bytes, badVersion.pin, now)).toMatchObject({ ok: false, reason: 'RECORD_INVALID' });
  });

  it('preserves full prerelease and build components in fixedVersions conversion', () => {
    const raw = record({ fixedVersions: ['1.2.3-rc.1+build.4'] });
    const test = fixture([raw]);
    const admitted = validateSupplyChainSnapshot(test.bytes, test.pin, now);
    const advisory = admitted.ok ? admitted.advisories?.[0] : undefined;
    expect(advisory).toBeDefined();
    expect(advisory?.fixedVersions).toEqual([
      { major: 1, minor: 2, patch: 3, prerelease: ['rc', '1'], build: ['build', '4'] },
    ]);
  });

  it('refuses catalogue versions that cannot round-trip without loss', () => {
    const test = fixture([record({ fixedVersions: ['9007199254740992.0.0'] })]);
    expect(validateSupplyChainSnapshot(test.bytes, test.pin, now)).toMatchObject({ ok: false, reason: 'RECORD_INVALID' });
    const malformed = fixture([record({ fixedVersions: ['01.2.3'] })]);
    expect(validateSupplyChainSnapshot(malformed.bytes, malformed.pin, now)).toMatchObject({ ok: false, reason: 'RECORD_INVALID' });
  });
});
