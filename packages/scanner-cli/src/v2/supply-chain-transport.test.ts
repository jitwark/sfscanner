import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinnedSnapshotTransport } from './supply-chain-transport.js';
import { fetchSupplyChainSnapshot } from './supply-chain-fetch.js';

const pin = { sourceId: 'test-fixture', url: 'https://example.invalid/frozen.json', sha256: 'a'.repeat(64), schemaVersion: 'scanner-advisories-v2' as const, capturedAt: '2026-11-03T00:00:00.000Z', maxAgeMs: 60_000 };
const request = (maxBytes = 16, signal = new AbortController().signal) => ({ url: pin.url, signal, timeoutMs: 100, maxBytes });
afterEach(() => vi.unstubAllGlobals());

describe('pinned CLI-only snapshot wire adapter', () => {
  it('makes one anonymous fixed URL request and retains bounded bytes', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('snapshot'));
    vi.stubGlobal('fetch', fetcher);
    const result = await createPinnedSnapshotTransport(pin)(request());
    expect(new TextDecoder().decode(result.bytes)).toBe('snapshot');
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(pin.url, expect.objectContaining({ method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { accept: 'application/json' } }));
  });
  it('rejects URL substitution, invalid pins and unbounded requests before network', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(() => createPinnedSnapshotTransport({ ...pin, url: 'http://example.invalid' })).toThrow();
    const transport = createPinnedSnapshotTransport(pin);
    await expect(transport({ ...request(), url: pin.url + '/other' })).rejects.toThrow();
    await expect(transport(request(5 * 1024 * 1024 + 1))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not follow redirects or consume error bodies', async () => {
    const cancel = vi.fn(); const fetcher = vi.fn().mockResolvedValue({ status: 302, body: { cancel }, headers: new Headers() });
    vi.stubGlobal('fetch', fetcher);
    expect(await createPinnedSnapshotTransport(pin)(request())).toEqual({ status: 302, bytes: new Uint8Array() });
    expect(cancel).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects oversized declared and streamed bodies, cancelling the reader', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('small', { headers: { 'content-length': '999' } })));
    await expect(createPinnedSnapshotTransport(pin)(request())).rejects.toThrow('byte bound');
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(17)); }, cancel });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
    await expect(createPinnedSnapshotTransport(pin)(request())).rejects.toThrow('byte bound');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('refuses an already cancelled request without network', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController(); controller.abort();
    await expect(createPinnedSnapshotTransport(pin)(request(16, controller.signal))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preserves an explicit oversized refusal through the acquisition boundary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('oversized', { headers: { 'content-length': '999' } })));
    expect(await fetchSupplyChainSnapshot({ pin, transport: createPinnedSnapshotTransport(pin), now: Date.parse(pin.capturedAt), maxBytes: 16 })).toEqual({ ok: false, reason: 'OVERSIZED' });
  });
});
