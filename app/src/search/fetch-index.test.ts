// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { resetManifestCache } from '../catalogue/manifest';
import { fetchExtendedIndex, fetchSearchIndex, SearchIndexError } from './fetch-index';

afterEach(() => {
  vi.restoreAllMocks();
  resetManifestCache();
});

describe('fetchSearchIndex failure classification', () => {
  it('classifies fetch/network failures as unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    await expect(fetchSearchIndex(vi.fn())).rejects.toMatchObject({
      name: 'SearchIndexError',
      kind: 'unavailable',
    } satisfies Partial<SearchIndexError>);
  });

  it('keeps an HTTP failure distinct from unavailable data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response);

    await expect(fetchSearchIndex(vi.fn())).rejects.toMatchObject({ kind: 'http' });
  });

  it('classifies an invalid index payload as malformed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers(),
      body: null,
      text: async () => '{not-json}',
    } as unknown as Response);

    await expect(fetchSearchIndex(vi.fn())).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('reports one honest completion event when content length is unavailable', async () => {
    const report = vi.fn();
    const emptyIndex = JSON.stringify({
      documentCount: 0,
      nextId: 0,
      documentIds: {},
      fieldIds: { id: 0, title: 1, summary: 2, tags: 3, integrations: 4, triggers: 5, capabilities: 6, content: 7 },
      fieldLength: {},
      averageFieldLength: [],
      storedFields: {},
      dirtCount: 0,
      index: [],
      serializationVersion: 2,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers(),
      body: null,
      text: async () => emptyIndex,
    } as unknown as Response);

    await expect(fetchSearchIndex(report)).resolves.toBe(emptyIndex);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(1, 1);
  });
});

describe('fetchExtendedIndex failure classification', () => {
  it('returns a typed malformed result for an invalid optional payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '{}',
    } as unknown as Response);

    await expect(fetchExtendedIndex()).resolves.toEqual({ ok: false, reason: 'malformed', retryable: false });
  });

  it('classifies a missing optional artifact as terminal for the release', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404 } as Response);

    await expect(fetchExtendedIndex()).resolves.toEqual({ ok: false, reason: 'absent', retryable: false });
  });

  it('marks a server failure as retryable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response);

    await expect(fetchExtendedIndex()).resolves.toEqual({ ok: false, reason: 'http', retryable: true });
  });
});

/**
 * AUDIT-SEARCH-003. The extended index is schema-valid on its own the moment
 * it parses as a search index — that check alone cannot tell a document that
 * belongs to this release from a stale one served by a mismatched CDN edge
 * or cache. Binding it to the manifest's sha256 (and byteSize, checked first
 * as a cheap short-circuit) closes that gap the same way the primary index
 * is already bound in `fetchSearchIndexWithRelease`.
 */
describe('fetchExtendedIndex release binding', () => {
  const extendedIndex = JSON.stringify({
    documentCount: 0,
    nextId: 0,
    documentIds: {},
    fieldIds: { id: 0, title: 1, summary: 2, tags: 3, integrations: 4, triggers: 5, capabilities: 6, content: 7 },
    fieldLength: {},
    averageFieldLength: [],
    storedFields: {},
    dirtCount: 0,
    index: [],
    serializationVersion: 2,
  });

  function hash(text: string): string {
    return bytesToHex(sha256(new TextEncoder().encode(text)));
  }

  function stubFetch(manifestArtifacts: { path: string; byteSize: number; sha256: string }[], indexText = extendedIndex, manifestOk = true) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('manifest.json')) {
        return manifestOk
          ? ({ ok: true, json: async () => ({
              schemaVersion: 'manifest-v1',
              generatedAt: '2026-08-30T00:00:00.000Z',
              totalEntries: 0,
              catalogueShards: {},
              artifacts: manifestArtifacts,
            }) } as unknown as Response)
          : ({ ok: false, status: 500, statusText: 'err' } as Response);
      }
      return { ok: true, text: async () => indexText } as unknown as Response;
    });
  }

  it('accepts an extended index whose bytes match the manifest', async () => {
    stubFetch([{ path: 'search-index-extended.json', byteSize: extendedIndex.length, sha256: hash(extendedIndex) }]);

    await expect(fetchExtendedIndex()).resolves.toEqual({ ok: true, json: extendedIndex });
  });

  it('classifies extended index bytes that do not match the manifest as stale-release and retryable', async () => {
    stubFetch([{ path: 'search-index-extended.json', byteSize: extendedIndex.length, sha256: 'f'.repeat(64) }]);

    await expect(fetchExtendedIndex()).resolves.toEqual({ ok: false, reason: 'stale-release', retryable: true });
  });

  it('accepts an extended index unverified when the manifest has no entry for it', async () => {
    stubFetch([{ path: 'search-index.json', byteSize: 1, sha256: 'a'.repeat(64) }]);

    await expect(fetchExtendedIndex()).resolves.toEqual({ ok: true, json: extendedIndex });
  });

  it('accepts an extended index unverified when the manifest itself is unavailable', async () => {
    stubFetch([], extendedIndex, false);

    await expect(fetchExtendedIndex()).resolves.toEqual({ ok: true, json: extendedIndex });
  });

  it('recovers once a corrected extended index is fetched after an earlier stale response', async () => {
    stubFetch([{ path: 'search-index-extended.json', byteSize: extendedIndex.length, sha256: 'f'.repeat(64) }]);
    await expect(fetchExtendedIndex()).resolves.toEqual({ ok: false, reason: 'stale-release', retryable: true });

    resetManifestCache();
    stubFetch([{ path: 'search-index-extended.json', byteSize: extendedIndex.length, sha256: hash(extendedIndex) }]);
    await expect(fetchExtendedIndex()).resolves.toEqual({ ok: true, json: extendedIndex });
  });
});
