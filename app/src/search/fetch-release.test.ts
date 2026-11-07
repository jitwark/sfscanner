// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { resetManifestCache } from '../catalogue/manifest';
import { fetchSearchIndexWithRelease } from './fetch-index';

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

function hash(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

function manifestFor(indexJson: string) {
  return {
    schemaVersion: 'manifest-v1',
    generatedAt: '2026-08-30T00:00:00.000Z',
    totalEntries: 0,
    catalogueShards: {},
    artifacts: [{ path: 'search-index.json', byteSize: indexJson.length, sha256: hash(indexJson) }],
  };
}

function response(text: string): Response {
  return { ok: true, headers: new Headers(), body: null, text: async () => text } as unknown as Response;
}

afterEach(() => {
  resetManifestCache();
  vi.restoreAllMocks();
});

describe('search release identity', () => {
  it('returns the manifest identity after validating the fetched search bytes', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => manifestFor(emptyIndex) } as Response)
      .mockResolvedValueOnce(response(emptyIndex));

    await expect(fetchSearchIndexWithRelease(vi.fn())).resolves.toMatchObject({
      indexJson: emptyIndex,
      identity: {
        schemaVersion: 'manifest-v1',
        generatedAt: '2026-08-30T00:00:00.000Z',
        searchIndexSha256: hash(emptyIndex),
      },
    });
  });

  // This is the boundary that actually guards a moved release (AUDIT-SEARCH-004
  // / R3-F3), not `resetSearchClientState()`: a mismatched-release artifact is
  // rejected here, on arrival, by hash comparison against the manifest that
  // named it — not cleared later by a reset that has no production caller.
  it('classifies bytes that do not belong to the loaded release as stale', async () => {
    const differentIndex = emptyIndex.replace('"nextId":0', '"nextId":1');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => manifestFor(emptyIndex) } as Response)
      .mockResolvedValueOnce(response(differentIndex));

    await expect(fetchSearchIndexWithRelease(vi.fn())).rejects.toMatchObject({ kind: 'stale-release' });
  });

  it('classifies an unsupported manifest schema separately', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ schemaVersion: 'manifest-v2' }),
    } as Response);

    await expect(fetchSearchIndexWithRelease(vi.fn())).rejects.toMatchObject({ kind: 'schema' });
  });
});
