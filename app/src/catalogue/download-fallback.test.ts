import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '@hub/contracts';
import { makeEntry } from '../test-support/make-entry';
import { MANIFEST_SCHEMA_VERSION, type Manifest } from './manifest';
import { contentRangeFor, mockRangeResponse } from './download-test-support';
import { fetchWorkflowJson } from './download';

const workflow = {
  name: 'Fallback workflow',
  nodes: [{ id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
  connections: {},
};
const jsonText = JSON.stringify(workflow);
const jsonBytes = new TextEncoder().encode(jsonText);
const packedBytes = new TextEncoder().encode(`${jsonText}\n`);
const packedLength = packedBytes.byteLength;
const hash = createHash('sha256').update(jsonBytes).digest('hex');

function makeFallbackEntry(sha256 = hash, length = packedLength): Entry {
  return makeEntry({
    id: 'fallback-entry',
    slug: 'fallback-entry',
    rights: { status: 'redistributable', licence: 'MIT' },
    structure: {
      nodeCount: 1, rawNodeCount: 1, connectionCount: 0,
      nodeTypes: ['n8n-nodes-base.manualTrigger'], integrations: [], trigger: '',
      complexity: 'simple', hasCode: false, hasAI: false, hasWebhook: false,
    },
    download: { pack: 0, line: 0, offset: 0, length, sha256 },
  });
}

function makeManifest(byteSize = packedLength, length = packedLength): Manifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: '2026-09-03T00:00:00.000Z',
    totalEntries: 1,
    catalogueShards: { 'fallback-entry': 0 },
    artifacts: [{
      path: 'packs/pack-0.jsonl', byteSize, sha256: '0'.repeat(64),
      entryCount: 1, entryRange: [0, 0], offsets: [0], lengths: [length],
    }],
  };
}

describe('full-pack download fallback boundaries', () => {
  it('rejects a fallback record whose canonical JSONL newline is missing', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.headers) return { status: 416 } as Response;
      return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => jsonBytes.buffer, text: async () => jsonText } as Response;
    });

    try {
      await expect(fetchWorkflowJson(makeFallbackEntry(hash, jsonBytes.byteLength), makeManifest(jsonBytes.byteLength, jsonBytes.byteLength)))
        .rejects.toMatchObject({ message: expect.stringMatching(/canonical JSONL newlines/i) });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts a correctly hashed record from the full-pack fallback', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.headers) return { status: 416 } as Response;
      return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => packedBytes.buffer } as Response;
    });

    try {
      await expect(fetchWorkflowJson(makeFallbackEntry(), makeManifest())).resolves.toMatchObject({ jsonText });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects an incorrectly hashed record from the full-pack fallback', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.headers) return { status: 416 } as Response;
      return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => packedBytes.buffer } as Response;
    });

    try {
      await expect(fetchWorkflowJson(makeFallbackEntry('0'.repeat(64)), makeManifest()))
        .rejects.toMatchObject({ code: 'CONTENT_HASH_MISMATCH' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * W-007.2: a host that ignores `Range` must cost one cancelled body and one
   * full-pack read, never a buffered 200 *and* the fallback. The spy is on
   * `arrayBuffer`, because the damage this prevents is the allocation, not the
   * status code.
   */
  it('never reads a 200 range body and falls back exactly once', async () => {
    const arrayBuffer = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ status: 200, ok: true, body: { cancel }, arrayBuffer } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => packedBytes.buffer,
      } as Response);

    try {
      await expect(fetchWorkflowJson(makeFallbackEntry(), makeManifest())).resolves.toMatchObject({ jsonText });
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  /**
   * W-007.3: the 32 MiB bound sits after the ranged attempt, so it refuses only
   * the whole-pack fallback. Reaching it costs exactly one fetch — the ranged
   * one that the host answered with `200`.
   */
  it('refuses a full-pack fallback above the bound without fetching the pack', async () => {
    const totalSize = 33 * 1024 * 1024;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockRangeResponse(200, packedBytes));

    try {
      await expect(fetchWorkflowJson(makeFallbackEntry(), makeManifest(totalSize)))
        .rejects.toThrow(/bounded pack size/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  /**
   * W-007.3's other half: a pack above the bound is a legitimate download when
   * the host honours `Range`. This is the case that fails if the bound is
   * hoisted to the top of `fetchWorkflowJson`.
   */
  it('still resolves a valid >32 MiB pack through a verified ranged read', async () => {
    const totalSize = 33 * 1024 * 1024;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockRangeResponse(206, packedBytes, contentRangeFor(0, packedLength, totalSize)));

    try {
      await expect(fetchWorkflowJson(makeFallbackEntry(), makeManifest(totalSize)))
        .resolves.toMatchObject({ jsonText });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
