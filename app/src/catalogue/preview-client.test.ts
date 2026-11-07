import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPreviewCache, loadPreviewById } from './preview-client';
import { MANIFEST_SCHEMA_VERSION, resetManifestCache } from './manifest';

const ID_A = 'aaaaaaaaaaaaaaaa';
const UNKNOWN_ID = 'ffffffffffffffff';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>Safe</text></svg>';
async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function response(status: number, body: string) {
  const bytes = new TextEncoder().encode(body);
  return { status, body: { cancel: vi.fn() }, arrayBuffer: async () => bytes.buffer } as unknown as Response;
}

describe('loadPreviewById', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearPreviewCache();
    resetManifestCache();
  });

  it.each(['constructor', '__proto__', 'not-an-artifact-id'])('rejects malformed ID %s before loading an index', async (id) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ schemaVersion: MANIFEST_SCHEMA_VERSION, generatedAt: '2026-01-01T00:00:00.000Z', totalEntries: 1, artifacts: [], catalogueShards: {} }),
    } as Response);

    await expect(loadPreviewById(id)).resolves.toEqual({ ok: false, reason: 'not-found' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not resolve an inherited per-shard index entry', async () => {
    const inheritedRef = { offset: 0, length: 1, sha256: '0'.repeat(64) };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return {
        ok: true,
        json: async () => ({ schemaVersion: MANIFEST_SCHEMA_VERSION, generatedAt: '2026-01-01T00:00:00.000Z', totalEntries: 1, artifacts: [], catalogueShards: { [ID_A]: 0 } }),
      } as Response;
      if (url.endsWith('/preview-index-0.json')) {
        Object.defineProperty(Object.prototype, ID_A, { configurable: true, value: inheritedRef });
        return { ok: true, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    try {
      await expect(loadPreviewById(ID_A)).resolves.toEqual({ ok: false, reason: 'not-found' });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      delete (Object.prototype as Record<string, unknown>)[ID_A];
    }
  });

  it('range-fetches and validates the preview line and embedded SVG hash', async () => {
    const preview = {
      schemaVersion: 'svg-preview-v1', tier: 'A', svg,
      nodeList: [{ id: ID_A, name: 'Start', type: 'n8n-nodes-base.manualTrigger', category: 'trigger' }],
      contentHash: await hash(svg), unresolvedEdgeCount: 0,
    };
    const line = JSON.stringify({ id: ID_A, ...preview });
    const lineHash = await hash(line);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return { ok: true, json: async () => ({ schemaVersion: MANIFEST_SCHEMA_VERSION, generatedAt: '2026-01-01T00:00:00.000Z', totalEntries: 1, artifacts: [], catalogueShards: { [ID_A]: 0 } }) } as Response;
      if (url.endsWith('/preview-index-0.json')) return { ok: true, json: async () => ({ [ID_A]: { offset: 0, length: new TextEncoder().encode(line).byteLength, sha256: lineHash } }) } as Response;
      if (url.endsWith('/preview-0.jsonl')) return response(206, line);
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadPreviewById(ID_A)).resolves.toMatchObject({ ok: true, preview });
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/preview-0.jsonl'), expect.objectContaining({ headers: { Range: expect.stringContaining('bytes=0-') } }));
  });

  it('does not inject a hash-valid line containing unsafe SVG', async () => {
    const line = JSON.stringify({
      id: ID_A, schemaVersion: 'svg-preview-v1', tier: 'A',
      svg: '<svg><script>alert(1)</script></svg>', nodeList: [], contentHash: 'a'.repeat(64), unresolvedEdgeCount: 0,
    });
    const lineHash = await hash(line);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return { ok: true, json: async () => ({ schemaVersion: MANIFEST_SCHEMA_VERSION, generatedAt: '2026-01-01T00:00:00.000Z', totalEntries: 1, artifacts: [], catalogueShards: { [ID_A]: 0 } }) } as Response;
      if (url.endsWith('/preview-index-0.json')) return { ok: true, json: async () => ({ [ID_A]: { offset: 0, length: line.length, sha256: lineHash } }) } as Response;
      if (url.endsWith('/preview-0.jsonl')) return response(206, line);
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadPreviewById(ID_A)).resolves.toEqual({ ok: false, reason: 'malformed' });
  });

  it('reports an ignored Range response as a bounded transport failure', async () => {
    const cancel = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return { ok: true, json: async () => ({ schemaVersion: MANIFEST_SCHEMA_VERSION, generatedAt: '2026-01-01T00:00:00.000Z', totalEntries: 1, artifacts: [], catalogueShards: { [ID_A]: 0 } }) } as Response;
      if (url.endsWith('/preview-index-0.json')) return { ok: true, json: async () => ({ [ID_A]: { offset: 0, length: 10, sha256: 'a'.repeat(64) } }) } as Response;
      if (url.endsWith('/preview-0.jsonl')) return { status: 200, body: { cancel }, arrayBuffer: async () => { throw new Error('whole shard must not be read'); } } as unknown as Response;
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadPreviewById(ID_A)).resolves.toEqual({ ok: false, reason: 'range-unsupported' });
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    ['network', 4],
    ['short-body', 4],
    ['range-unsupported', 2],
    ['malformed', 2],
    ['hash-mismatch', 2],
  ] as const)('does not cache a %s preview body after failure', async (failure, expectedBodyCalls) => {
    const preview = {
      schemaVersion: 'svg-preview-v1', tier: 'A', svg,
      nodeList: [{ id: ID_A, name: 'Start', type: 'n8n-nodes-base.manualTrigger', category: 'trigger' }],
      contentHash: await hash(svg), unresolvedEdgeCount: 0,
    };
    const validLine = JSON.stringify({ id: ID_A, ...preview });
    const validHash = await hash(validLine);
    const malformedLine = 'x'.repeat(validLine.length);
    const body = failure === 'malformed' ? malformedLine : validLine;
    const ref = {
      offset: 0,
      length: new TextEncoder().encode(validLine).byteLength,
      sha256: failure === 'malformed' ? await hash(body) : validHash,
    };
    const indexBody = JSON.stringify({ [ID_A]: ref });
    const indexHash = await hash(indexBody);
    let bodyCalls = 0;
    let indexCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return {
        ok: true,
        json: async () => ({
          schemaVersion: MANIFEST_SCHEMA_VERSION,
          generatedAt: '2026-01-01T00:00:00.000Z',
          totalEntries: 1,
          catalogueShards: { [ID_A]: 0 },
          artifacts: [{ path: 'previews/preview-index-0.json', byteSize: 1, sha256: indexHash }],
        }),
      } as Response;
      if (url.endsWith('/preview-index-0.json')) {
        indexCalls += 1;
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode(indexBody).buffer } as Response;
      }
      if (url.endsWith('/preview-0.jsonl')) {
        bodyCalls += 1;
        if (failure === 'network') throw new Error('offline');
        if (failure === 'range-unsupported') return response(200, validLine);
        if (failure === 'short-body') return response(206, validLine.slice(0, 2));
        return response(206, failure === 'hash-mismatch' ? 'z'.repeat(validLine.length) : body);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadPreviewById(ID_A)).resolves.toEqual({ ok: false, reason: failure });
    await expect(loadPreviewById(ID_A)).resolves.toEqual({ ok: false, reason: failure });
    expect(indexCalls).toBe(1);
    expect(bodyCalls).toBe(expectedBodyCalls);
  });

  it('rejects an index range that exceeds the manifest artifact size', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return {
        ok: true,
        json: async () => ({
          schemaVersion: MANIFEST_SCHEMA_VERSION,
          generatedAt: '2026-01-01T00:00:00.000Z',
          totalEntries: 1,
          catalogueShards: { [ID_A]: 0 },
          artifacts: [{ path: 'previews/preview-0.jsonl', byteSize: 1, sha256: 'a'.repeat(64) }],
        }),
      } as Response;
      if (url.endsWith('/preview-index-0.json')) return {
        ok: true,
        json: async () => ({ [ID_A]: { offset: 0, length: 2, sha256: 'a'.repeat(64) } }),
      } as Response;
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadPreviewById(ID_A)).resolves.toEqual({ ok: false, reason: 'malformed' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('keys successful preview indexes by release identity instead of shard alone', async () => {
    let generatedAt = '2026-01-01T00:00:00.000Z';
    const indexHash = await hash('{}');
    let indexCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return {
        ok: true,
        json: async () => ({
          schemaVersion: MANIFEST_SCHEMA_VERSION,
          generatedAt,
          totalEntries: 1,
          catalogueShards: { [ID_A]: 0 },
          artifacts: [{ path: 'previews/preview-index-0.json', byteSize: 1, sha256: indexHash }],
        }),
      } as Response;
      if (url.endsWith('/preview-index-0.json')) {
        indexCalls += 1;
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode('{}').buffer } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadPreviewById(ID_A)).resolves.toEqual({ ok: false, reason: 'not-found' });
    resetManifestCache();
    generatedAt = '2026-01-02T00:00:00.000Z';
    await expect(loadPreviewById(ID_A)).resolves.toEqual({ ok: false, reason: 'not-found' });

    expect(indexCalls).toBe(2);
  });

  it('re-issues an index request after a failure instead of retaining the rejected promise', async () => {
    const indexHash = await hash('{}');
    let indexCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return {
        ok: true,
        json: async () => ({
          schemaVersion: MANIFEST_SCHEMA_VERSION,
          generatedAt: '2026-01-01T00:00:00.000Z',
          totalEntries: 1,
          catalogueShards: { [ID_A]: 0 },
          artifacts: [{ path: 'previews/preview-index-0.json', byteSize: 1, sha256: indexHash }],
        }),
      } as Response;
      if (url.endsWith('/preview-index-0.json')) {
        indexCalls += 1;
        if (indexCalls === 1) throw new Error('connection reset');
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode('{}').buffer } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadPreviewById(ID_A)).resolves.toEqual({ ok: false, reason: 'network' });
    await expect(loadPreviewById(ID_A)).resolves.toEqual({ ok: false, reason: 'not-found' });
    expect(indexCalls).toBe(2);
  });

  it('does not retain an index whose bytes do not match the manifest hash', async () => {
    const preview = {
      schemaVersion: 'svg-preview-v1', tier: 'A', svg,
      nodeList: [{ id: ID_A, name: 'Start', type: 'n8n-nodes-base.manualTrigger', category: 'trigger' }],
      contentHash: await hash(svg), unresolvedEdgeCount: 0,
    };
    const line = JSON.stringify({ id: ID_A, ...preview });
    const validIndex = { [ID_A]: { offset: 0, length: new TextEncoder().encode(line).byteLength, sha256: await hash(line) } };
    const validIndexHash = await hash(JSON.stringify(validIndex));
    let indexCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return {
        ok: true,
        json: async () => ({
          schemaVersion: MANIFEST_SCHEMA_VERSION,
          generatedAt: '2026-01-01T00:00:00.000Z',
          totalEntries: 1,
          catalogueShards: { [ID_A]: 0 },
          artifacts: [{ path: 'previews/preview-index-0.json', byteSize: 1, sha256: validIndexHash }],
        }),
      } as Response;
      if (url.endsWith('/preview-index-0.json')) {
        indexCalls += 1;
        const body = JSON.stringify(indexCalls === 1 ? {} : validIndex);
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode(body).buffer } as Response;
      }
      if (url.endsWith('/preview-0.jsonl')) return response(206, line);
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadPreviewById(ID_A)).resolves.toEqual({ ok: false, reason: 'network' });
    await expect(loadPreviewById(ID_A)).resolves.toMatchObject({ ok: true, preview });
    expect(indexCalls).toBe(2);
  });
});
