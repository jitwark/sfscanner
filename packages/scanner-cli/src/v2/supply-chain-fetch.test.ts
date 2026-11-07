import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import { fetchSupplyChainSnapshot, type SnapshotTransportV1 } from './supply-chain-fetch';

import { fixture, capturedAt } from './supply-chain-fixture.test-helper';
const now = Date.parse(capturedAt) + 1_000;

describe('pinned supply-chain fetch', () => {
  it('performs one injected request and validates the returned bytes', async () => {
    const { bytes, pin } = fixture();
    let request: Parameters<SnapshotTransportV1>[0] | undefined;
    let calls = 0;
    const transport: SnapshotTransportV1 = async (value) => { calls += 1; request = value; return { status: 200, bytes }; };
    const result = await fetchSupplyChainSnapshot({ pin, transport, now });
    expect(result).toMatchObject({ ok: true, snapshot: { sourceId: 'synthetic-source', records: 1 } });
    expect(calls).toBe(1);
    expect(request).toMatchObject({ url: pin.url, timeoutMs: 10_000, maxBytes: 5 * 1024 * 1024 });
  });

  it('refuses an invalid pin before the transport is called', async () => {
    const { pin } = fixture();
    let calls = 0;
    const transport: SnapshotTransportV1 = async () => { calls += 1; return { status: 200, bytes: new Uint8Array() }; };
    await expect(fetchSupplyChainSnapshot({ pin: { ...pin, url: 'http://example.test/snapshot.json' }, now, transport })).resolves.toMatchObject({ ok: false, reason: 'PIN_INVALID' });
    await expect(fetchSupplyChainSnapshot({ pin: { ...pin, sha256: 'not-a-digest' }, now, transport })).resolves.toMatchObject({ ok: false, reason: 'PIN_INVALID' });
    await expect(fetchSupplyChainSnapshot({ pin: { ...pin, sha256: `${pin.sha256}\n` }, now, transport })).resolves.toMatchObject({ ok: false, reason: 'PIN_INVALID' });
    expect(calls).toBe(0);
  });

  it('settles CANCELLED promptly when a transport ignores the abort signal', async () => {
    const { pin } = fixture();
    const controller = new AbortController();
    const never: SnapshotTransportV1 = () => new Promise(() => {});
    const pending = fetchSupplyChainSnapshot({ pin, now, signal: controller.signal, timeoutMs: 10_000, transport: never });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'CANCELLED' });
  });

  it('refuses redirects, non-200 responses and oversized bodies', async () => {
    const { bytes, pin } = fixture();
    await expect(fetchSupplyChainSnapshot({ pin, now, transport: async () => ({ status: 302, bytes }) })).resolves.toMatchObject({ ok: false, reason: 'REDIRECT' });
    await expect(fetchSupplyChainSnapshot({ pin, now, transport: async () => ({ status: 500, bytes }) })).resolves.toMatchObject({ ok: false, reason: 'STATUS' });
    await expect(fetchSupplyChainSnapshot({ pin, now, maxBytes: 1, transport: async () => ({ status: 200, bytes }) })).resolves.toMatchObject({ ok: false, reason: 'OVERSIZED' });
  });

  it('fails closed on timeout, abort and transport rejection without retrying', async () => {
    const { pin } = fixture();
    const never: SnapshotTransportV1 = () => new Promise(() => {});
    await expect(fetchSupplyChainSnapshot({ pin, now, timeoutMs: 10, transport: never })).resolves.toMatchObject({ ok: false, reason: 'TIMEOUT' });
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn(async () => ({ status: 200, bytes: new Uint8Array() }));
    await expect(fetchSupplyChainSnapshot({ pin, now, signal: controller.signal, transport })).resolves.toMatchObject({ ok: false, reason: 'CANCELLED' });
    expect(transport).not.toHaveBeenCalled();
    await expect(fetchSupplyChainSnapshot({ pin, now, transport: async () => { throw new Error('offline'); } })).resolves.toMatchObject({ ok: false, reason: 'TRANSPORT_FAILED' });
  });

  it('returns the validator reason for a mismatched body', async () => {
    const { pin } = fixture();
    await expect(fetchSupplyChainSnapshot({ pin, now, transport: async () => ({ status: 200, bytes: new TextEncoder().encode('{}') }) })).resolves.toMatchObject({ ok: false, reason: 'DIGEST_MISMATCH' });
  });
});
