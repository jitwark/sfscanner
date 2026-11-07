// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as indexCache from './index-cache';
import { fetchSearchIndexWithRelease } from './fetch-index';
import { fetchFacetsResult } from './fetch-facets';
import { resetManifestCache } from '../catalogue/manifest';

describe('search index & facets cache integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetManifestCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetManifestCache();
  });

  it('uses cached search index when present and skips network fetch', async () => {
    const mockManifest = {
      schemaVersion: 'manifest-v1',
      generatedAt: '2026-09-05T00:00:00Z',
      totalEntries: 10,
      catalogueShards: {},
      artifacts: [{ path: 'search-index.json', byteSize: 100, sha256: 'a'.repeat(64) }],
    };

    vi.spyOn(indexCache, 'getCachedIndex').mockResolvedValueOnce('{"version":1,"items":[]}');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      if (String(url).includes('manifest.json')) {
        return new Response(JSON.stringify(mockManifest), { status: 200 });
      }
      throw new Error(`Unexpected network fetch: ${String(url)}`);
    });

    const report = vi.fn();
    const result = await fetchSearchIndexWithRelease(report);
    expect(result.indexJson).toBe('{"version":1,"items":[]}');
    expect(result.identity.searchIndexSha256).toBe('a'.repeat(64));
    expect(report).toHaveBeenCalledWith(1, 1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('manifest.json');
  });

  it('uses cached facets when present and skips network fetch', async () => {
    const mockManifest = {
      schemaVersion: 'manifest-v1',
      generatedAt: '2026-09-05T00:00:00Z',
      totalEntries: 10,
      catalogueShards: {},
      artifacts: [
        { path: 'search-index.json', byteSize: 100, sha256: 'a'.repeat(64), entryCount: 10 },
        { path: 'search-index-extended.json', byteSize: 100, sha256: 'b'.repeat(64), entryCount: 0 },
        { path: 'facets.json', byteSize: 100, sha256: 'c'.repeat(64) },
      ],
    };
    const cachedFacets: indexCache.FacetsData = {
      total: 10,
      counts: {},
      bitsets: {},
      ordinals: [],
    };

    vi.spyOn(indexCache, 'getCachedFacets').mockResolvedValueOnce(cachedFacets);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      if (String(url).includes('manifest.json')) {
        return new Response(JSON.stringify(mockManifest), { status: 200 });
      }
      throw new Error(`Unexpected network fetch: ${String(url)}`);
    });

    const result = await fetchFacetsResult();
    expect(result).toEqual({ ok: true, data: cachedFacets });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('manifest.json');
  });

  it('persists fetched index to cache and evicts stale artifacts on network fetch', async () => {
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
    const [{ sha256 }, { bytesToHex }] = await Promise.all([
      import('@noble/hashes/sha2.js'),
      import('@noble/hashes/utils.js'),
    ]);
    const indexSha = bytesToHex(sha256(new TextEncoder().encode(emptyIndex)));

    const mockManifest = {
      schemaVersion: 'manifest-v1',
      generatedAt: '2026-09-05T00:00:00Z',
      totalEntries: 0,
      catalogueShards: {},
      artifacts: [{ path: 'search-index.json', byteSize: emptyIndex.length, sha256: indexSha }],
    };

    vi.spyOn(indexCache, 'getCachedIndex').mockResolvedValueOnce(null);
    const setCachedSpy = vi.spyOn(indexCache, 'setCachedIndex').mockResolvedValue();
    const evictSpy = vi.spyOn(indexCache, 'evictStaleArtifacts').mockResolvedValue();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes('manifest.json')) {
        return new Response(JSON.stringify(mockManifest), { status: 200 });
      }
      if (urlStr.includes('search-index.json')) {
        return new Response(emptyIndex, { status: 200, headers: { 'content-length': String(emptyIndex.length) } });
      }
      throw new Error(`Unexpected network fetch: ${urlStr}`);
    });

    const report = vi.fn();
    const result = await fetchSearchIndexWithRelease(report);
    expect(result.indexJson).toBe(emptyIndex);
    expect(setCachedSpy).toHaveBeenCalledWith(indexSha, emptyIndex);
    expect(evictSpy).toHaveBeenCalledWith(indexSha);
  });

  it('persists fetched facets to cache on network fetch', async () => {
    const facetsJson = JSON.stringify({
      total: 2,
      counts: { rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: {}, tags: {} },
      bitsets: {},
      ordinals: ['e1', 'e2'],
    });
    const [{ sha256 }, { bytesToHex }] = await Promise.all([
      import('@noble/hashes/sha2.js'),
      import('@noble/hashes/utils.js'),
    ]);
    const facetsSha = bytesToHex(sha256(new TextEncoder().encode(facetsJson)));

    const mockManifest = {
      schemaVersion: 'manifest-v1',
      generatedAt: '2026-09-05T00:00:00Z',
      totalEntries: 2,
      catalogueShards: {},
      artifacts: [
        { path: 'search-index.json', byteSize: 100, sha256: 'a'.repeat(64), entryCount: 2 },
        { path: 'search-index-extended.json', byteSize: 100, sha256: 'b'.repeat(64), entryCount: 0 },
        { path: 'facets.json', byteSize: facetsJson.length, sha256: facetsSha },
      ],
    };

    vi.spyOn(indexCache, 'getCachedFacets').mockResolvedValueOnce(null);
    const setFacetsSpy = vi.spyOn(indexCache, 'setCachedFacets').mockResolvedValue();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes('manifest.json')) {
        return new Response(JSON.stringify(mockManifest), { status: 200 });
      }
      if (urlStr.includes('facets.json')) {
        return new Response(facetsJson, { status: 200 });
      }
      throw new Error(`Unexpected network fetch: ${urlStr}`);
    });

    const result = await fetchFacetsResult();
    expect(result.ok).toBe(true);
    expect(setFacetsSpy).toHaveBeenCalledWith(facetsSha, expect.objectContaining({ total: 2 }));
  });
});
