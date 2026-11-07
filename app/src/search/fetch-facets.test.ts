// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { fetchFacetsResult } from './fetch-facets';
import { resetManifestCache } from '../catalogue/manifest';

function hash(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

const artifact = (path: string, entryCount: number) => ({
  path,
  byteSize: 1,
  sha256: '0'.repeat(64),
  entryCount,
});

/**
 * `totalEntries` counts the whole catalogue; the two search index artifacts count the
 * *searchable* universe. They legitimately differ (13,221 vs 12,923 in the current
 * release), so the default fixture keeps them distinct — a facets payload describing the
 * searchable universe must be accepted, not flagged incomplete.
 *
 * `extraArtifacts` defaults to empty, which — for every test in the first describe block
 * below — means the manifest has no `facets.json` entry at all. That is deliberate: those
 * tests exercise the `total` cross-check in isolation, and AUDIT-SEARCH-003's sha256
 * binding must degrade to "unverified" (not block) whenever the manifest lacks the entry,
 * so this fixture doubles as coverage for that degrade path everywhere it's reused.
 */
const manifestResponse = (totalEntries: number, primary = 2000, extended = 10923, extraArtifacts: unknown[] = []) => ({
  ok: true,
  json: async () => ({
    schemaVersion: 'manifest-v1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    totalEntries,
    catalogueShards: {},
    artifacts: [
      artifact('search-index.json', primary),
      artifact('search-index-extended.json', extended),
      ...extraArtifacts,
    ],
  }),
});

function facetsJsonText(total: number): string {
  return JSON.stringify({
    total,
    counts: { rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: {}, tags: {} },
    bitsets: {},
    ordinals: Array.from({ length: total }, (_, index) => `entry-${index}`),
  });
}

const facetsResponse = (total: number) => ({ ok: true, text: async () => facetsJsonText(total) });
const facetsArtifact = (text: string) => ({ path: 'facets.json', byteSize: text.length, sha256: hash(text) });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetManifestCache();
});

/**
 * AUDIT-SEARCH-002. Facets are optional for filtering, but their absence or
 * corruption must never be swallowed into an undifferentiated `undefined` —
 * the caller (search-client-runtime) needs a typed, retryable reason to
 * expose a degraded state to the UI instead of a silent, normal-looking
 * catalogue that quietly lost most of its filter counts.
 */
describe('fetchFacetsResult failure classification', () => {
  it('classifies a missing artifact as absent and terminal', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('manifest.json')) return manifestResponse(2) as unknown as Response;
      return { ok: false, status: 404 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchFacetsResult()).resolves.toEqual({ ok: false, reason: 'absent', retryable: false });
  });

  it('classifies a network failure as unavailable and retryable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('manifest.json')) return manifestResponse(2) as unknown as Response;
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchFacetsResult()).resolves.toEqual({ ok: false, reason: 'unavailable', retryable: true });
  });

  it('classifies a 500 as an http failure and retryable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('manifest.json')) return manifestResponse(2) as unknown as Response;
      return { ok: false, status: 503 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchFacetsResult()).resolves.toEqual({ ok: false, reason: 'http', retryable: true });
  });

  it('classifies malformed JSON as malformed and terminal', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('manifest.json')) return manifestResponse(2) as unknown as Response;
      return { ok: true, text: async () => '{not-json}' } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchFacetsResult()).resolves.toEqual({ ok: false, reason: 'malformed', retryable: false });
  });

  it('classifies a schema-invalid payload as malformed and terminal', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('manifest.json')) return manifestResponse(2) as unknown as Response;
      return { ok: true, text: async () => JSON.stringify({ total: 'not-a-number' }) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchFacetsResult()).resolves.toEqual({ ok: false, reason: 'malformed', retryable: false });
  });

  /**
   * A schema-valid facets payload whose `total` undercounts the release's
   * true entry count (from the manifest) is exactly the "stale artifact"
   * scenario the audit flagged: it will never crash, and it looks like a
   * normal, complete response — the only way to catch it is comparing
   * against an independent total.
   */
  it('classifies a schema-valid but undercounted payload as incomplete and retryable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // Searchable universe is 4 + 2 = 6; the facets payload describes only 2.
      if (url.includes('manifest.json')) return manifestResponse(8, 4, 2) as unknown as Response;
      return facetsResponse(2) as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchFacetsResult()).resolves.toEqual({ ok: false, reason: 'incomplete', retryable: true });
  });

  /**
   * Regression: the cross-check must use the searchable universe (primary + extended
   * index entry counts), not `totalEntries`. The current release ships 13,221 catalogue
   * entries but only 12,923 searchable ones, so comparing against `totalEntries` rejected
   * every well-formed facets payload in production and silently disabled all filtering.
   */
  it('accepts a facets payload describing the searchable universe, not the whole catalogue', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('manifest.json')) return manifestResponse(13221, 2000, 10923) as unknown as Response;
      return facetsResponse(12923) as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchFacetsResult();
    expect(result.ok).toBe(true);
  });

  it('accepts a schema-valid payload whose total matches the manifest', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('manifest.json')) return manifestResponse(4, 1, 1) as unknown as Response;
      return facetsResponse(2) as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchFacetsResult();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.total).toBe(2);
  });

  it('accepts a schema-valid payload when the manifest itself is unavailable, rather than blocking on it', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('manifest.json')) return { ok: false, status: 500 } as Response;
      return facetsResponse(2) as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchFacetsResult();
    expect(result.ok).toBe(true);
  });
});

/**
 * AUDIT-SEARCH-003. `total` matching an independent count (above) proves the
 * payload describes the right *number* of documents; it says nothing about
 * whether these are the release's actual bytes. A CDN edge or cache mixing
 * releases can serve a `facets.json` that is schema-valid and even
 * total-correct by coincidence while still carrying a stale title or a
 * missing ordinal for the entries it does list — mutation probes confirmed
 * exactly that. Binding the fetched bytes to the manifest's sha256 closes
 * that gap the same way the primary and extended search indexes are bound.
 */
describe('fetchFacetsResult release binding', () => {
  it('accepts a facets payload whose bytes match the manifest hash', async () => {
    const text = facetsJsonText(2);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('manifest.json')) return manifestResponse(4, 1, 1, [facetsArtifact(text)]) as unknown as Response;
      return { ok: true, text: async () => text } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchFacetsResult();
    expect(result.ok).toBe(true);
  });

  it('classifies facets bytes that do not match the manifest hash as stale and retryable', async () => {
    const manifestText = facetsJsonText(2);
    const servedText = facetsJsonText(2).replace('"total":2', '"total":2 '); // same total, different bytes
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('manifest.json')) return manifestResponse(4, 1, 1, [facetsArtifact(manifestText)]) as unknown as Response;
      return { ok: true, text: async () => servedText } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchFacetsResult()).resolves.toEqual({ ok: false, reason: 'stale', retryable: true });
  });

  it('accepts a facets payload unverified when the manifest has no hash entry for facets.json', async () => {
    const text = facetsJsonText(2);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('manifest.json')) return manifestResponse(4, 1, 1) as unknown as Response;
      return { ok: true, text: async () => text } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchFacetsResult();
    expect(result.ok).toBe(true);
  });

  it('recovers when a corrected facets payload is fetched after an earlier stale response', async () => {
    const correctText = facetsJsonText(2);
    const staleText = facetsJsonText(2).replace('"total":2', '"total":2 ');
    let served = staleText;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('manifest.json')) return manifestResponse(4, 1, 1, [facetsArtifact(correctText)]) as unknown as Response;
      return { ok: true, text: async () => served } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchFacetsResult()).resolves.toEqual({ ok: false, reason: 'stale', retryable: true });

    resetManifestCache();
    served = correctText;
    const result = await fetchFacetsResult();
    expect(result.ok).toBe(true);
  });
});
