// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureDeferredPayloads,
  createDeferredPayloadController,
  requestSemanticVectorsFor,
  resetDeferredPayloads,
} from './deferred-payloads';
import { resetManifestCache } from '../catalogue/manifest';

afterEach(() => {
  resetDeferredPayloads();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetManifestCache();
});

describe('deferred payload state', () => {
  it('isolates latches, targets, and resets between factory-created controllers', async () => {
    const firstFetch = vi.fn(async () => ({ ok: true, text: async () => '{"version":1,"documents":[]}' }));
    const secondFetch = vi.fn(async () => ({ ok: true, text: async () => '{"version":1,"documents":[]}' }));
    const firstDeliver = vi.fn(() => false);
    const secondDeliver = vi.fn(() => false);
    let now = 0;
    const first = createDeferredPayloadController({ fetch: firstFetch, now: () => now, validateSemanticIndex: () => undefined });
    const second = createDeferredPayloadController({ fetch: secondFetch, now: () => now, validateSemanticIndex: () => undefined });

    first.configure({ deliverExtended: () => false, deliverSemantic: firstDeliver, version: () => 0 });
    second.configure({ deliverExtended: () => false, deliverSemantic: secondDeliver, version: () => 0 });

    first.requestSemanticVectorsFor('slack');
    second.requestSemanticVectorsFor('slack');
    await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(secondFetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(firstDeliver).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(secondDeliver).toHaveBeenCalledTimes(1));

    first.requestSemanticVectorsFor('slack again');
    second.requestSemanticVectorsFor('slack again');
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).toHaveBeenCalledTimes(1);

    first.reset();
    first.requestSemanticVectorsFor('slack after reset');
    await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledTimes(2));
    expect(secondFetch).toHaveBeenCalledTimes(1);
  });

  it('contains synchronous extended adapter failures and permits a backoff retry', () => {
    let now = 0;
    const fetchExtended = vi.fn(() => { throw new Error('offline'); });
    const controller = createDeferredPayloadController({ fetchExtended, now: () => now });
    controller.configure({ deliverExtended: () => false, deliverSemantic: () => false, version: () => 0 });

    expect(() => controller.requestExtendedTier()).not.toThrow();
    expect(fetchExtended).toHaveBeenCalledTimes(1);

    controller.requestExtendedTier();
    expect(fetchExtended).toHaveBeenCalledTimes(1);
    now = 1_000;
    controller.requestExtendedTier();
    expect(fetchExtended).toHaveBeenCalledTimes(2);
  });

  it('fails closed on malformed semantic data without retrying every query', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => '{not-json}',
    }));
    const deliverSemantic = vi.fn(() => true);
    vi.stubGlobal('fetch', fetchMock);
    configureDeferredPayloads({
      deliverExtended: () => false,
      deliverSemantic,
      version: () => 0,
    });
    requestSemanticVectorsFor('slack');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(deliverSemantic).not.toHaveBeenCalled();

    requestSemanticVectorsFor('slack again');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a missing semantic artifact as terminal for this release', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    configureDeferredPayloads({ deliverExtended: () => false, deliverSemantic: () => false, version: () => 0 });

    requestSemanticVectorsFor('slack');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    requestSemanticVectorsFor('slack again');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats other semantic client errors as terminal for this release', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    configureDeferredPayloads({ deliverExtended: () => false, deliverSemantic: () => false, version: () => 0 });

    requestSemanticVectorsFor('slack');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    requestSemanticVectorsFor('slack again');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('backs off transient semantic failures before retrying', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);
    configureDeferredPayloads({ deliverExtended: () => false, deliverSemantic: () => false, version: () => 0 });

    requestSemanticVectorsFor('slack');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    requestSemanticVectorsFor('slack again');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    requestSemanticVectorsFor('slack retry');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

const semanticJson = '{"version":1,"dimensions":96,"documents":[]}';

/**
 * AUDIT-SEARCH-003. Schema validation alone accepts any well-formed
 * `semantic-index.json`, including a stale one served from a mismatched CDN
 * edge or cache. Binding it to the manifest's sha256 closes that gap the
 * same way the primary and extended search indexes, and facets, are bound.
 * Unlike a malformed payload (terminal for the release — see the block
 * above), a hash mismatch is treated as recoverable: the artifact might
 * simply not have propagated to this edge yet, so it schedules the same
 * backoff retry as a transient network failure instead of giving up.
 */
describe('semantic index release binding', () => {
  it('delivers the semantic index once its hash matches the manifest', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => semanticJson }));
    const verifySemanticIndexHash = vi.fn(async () => 'match' as const);
    const deliverSemantic = vi.fn(() => true);
    const controller = createDeferredPayloadController({ fetch: fetchMock, verifySemanticIndexHash });
    controller.configure({ deliverExtended: () => false, deliverSemantic, version: () => 0 });

    controller.requestSemanticVectorsFor('slack');
    await vi.waitFor(() => expect(deliverSemantic).toHaveBeenCalledWith(semanticJson));
    expect(verifySemanticIndexHash).toHaveBeenCalledWith(semanticJson);
  });

  it('treats a semantic index hash mismatch as retryable rather than terminal, and recovers once corrected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => semanticJson }));
    const verifySemanticIndexHash = vi.fn()
      .mockResolvedValueOnce('mismatch' as const)
      .mockResolvedValueOnce('match' as const);
    const deliverSemantic = vi.fn(() => true);
    const controller = createDeferredPayloadController({ fetch: fetchMock, verifySemanticIndexHash });
    controller.configure({ deliverExtended: () => false, deliverSemantic, version: () => 0 });

    controller.requestSemanticVectorsFor('slack');
    await vi.waitFor(() => expect(verifySemanticIndexHash).toHaveBeenCalledTimes(1));
    expect(deliverSemantic).not.toHaveBeenCalled();

    // Immediate re-request while backoff hasn't elapsed does not refetch.
    controller.requestSemanticVectorsFor('slack again');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    controller.requestSemanticVectorsFor('slack retry');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(deliverSemantic).toHaveBeenCalledWith(semanticJson));
  });

  it('accepts the semantic index unverified when the manifest has no entry for it', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('manifest.json')) {
        return {
          ok: true,
          json: async () => ({
            schemaVersion: 'manifest-v1',
            generatedAt: '2026-08-30T00:00:00.000Z',
            totalEntries: 0,
            catalogueShards: {},
            artifacts: [],
          }),
        } as unknown as Response;
      }
      return { ok: true, text: async () => semanticJson } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const deliverSemantic = vi.fn(() => true);
    configureDeferredPayloads({ deliverExtended: () => false, deliverSemantic, version: () => 0 });

    requestSemanticVectorsFor('slack');
    await vi.waitFor(() => expect(deliverSemantic).toHaveBeenCalledWith(semanticJson));
  });

  it('accepts the semantic index unverified when the manifest itself is unavailable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('manifest.json')) return { ok: false, status: 500 } as Response;
      return { ok: true, text: async () => semanticJson } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const deliverSemantic = vi.fn(() => true);
    configureDeferredPayloads({ deliverExtended: () => false, deliverSemantic, version: () => 0 });

    requestSemanticVectorsFor('slack');
    await vi.waitFor(() => expect(deliverSemantic).toHaveBeenCalledWith(semanticJson));
  });
});
