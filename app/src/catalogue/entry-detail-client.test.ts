import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCANNER_RESULT_SCHEMA_VERSION, type Entry } from '@hub/contracts';
import {
  clearDetailIndexCache,
  fetchEntryById,
  loadEntryDetail,
} from './entry-detail-client';
import { MANIFEST_SCHEMA_VERSION, resetManifestCache } from './manifest';

const ID_A = 'aaaaaaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbbbbbb';
const UNKNOWN_ID = 'ffffffffffffffff';

function manifestResponse(
  catalogueShards: Record<string, number>,
  generatedAt = '2026-01-01T00:00:00.000Z',
  detailIndexHash = '',
) {
  return {
    ok: true,
    json: async () => ({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      generatedAt,
      totalEntries: 1,
      artifacts: detailIndexHash ? [{ path: 'details/detail-index-0.json', byteSize: 1, sha256: detailIndexHash }] : [],
      catalogueShards,
    }),
  } as Response;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function rangeResponse(status: number, body: string, opts: { cancel?: () => void } = {}) {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    body: { cancel: opts.cancel ?? (() => undefined) },
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

function detailEntry(id: string, title = 'Workflow'): Entry {
  return {
    id, slug: id, title, summary: 'A summary', description: 'A description', descriptionSource: 'upstream',
    source: { kind: 'github', repo: 'owner/repo', permalink: 'https://github.com/owner/repo/blob/abc/workflow.json', fetchedAt: '2026-01-01' },
    rights: { status: 'redistributable', licence: 'MIT', licenceUrl: 'https://spdx.org/licenses/MIT.html', reason: 'evidence' },
    structure: { nodeCount: 1, rawNodeCount: 1, annotationNodeCount: 0, connectionCount: 0, nodeTypes: ['n8n-nodes-base.manualTrigger'], integrations: [], trigger: 'Manual', isSubWorkflow: false, complexity: 'simple', hasCode: false, hasAI: false, hasWebhook: false },
    security: { grade: 'LOW', score: 100, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: [], hardenedExtra: 0, scannerVersion: '1.0.0', profile: 'beta-default', schemaVersion: SCANNER_RESULT_SCHEMA_VERSION },
    tags: ['automation'], dedup: { fingerprint: `fp-${id}`, structuralHash: `sh-${id}`, canonical: true, alsoFoundIn: [] },
  };
}

describe('loadEntryDetail', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearDetailIndexCache();
    resetManifestCache();
  });

  it('reports not-found without index/range fetch for an unknown valid ID', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(manifestResponse({}));
    await expect(loadEntryDetail(UNKNOWN_ID)).resolves.toEqual({ ok: false, reason: 'not-found' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each(['constructor', '__proto__', 'not-an-artifact-id'])('rejects malformed ID %s before loading an index', async (id) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(manifestResponse({}));
    await expect(loadEntryDetail(id)).resolves.toEqual({ ok: false, reason: 'not-found' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not resolve an inherited per-shard index entry', async () => {
    const inheritedRef = { offset: 0, length: 1, sha256: '0'.repeat(64) };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 });
      if (url.endsWith('/detail-index-0.json')) {
        Object.defineProperty(Object.prototype, ID_A, { configurable: true, value: inheritedRef });
        return { ok: true, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    try {
      await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: false, reason: 'not-found' });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      delete (Object.prototype as Record<string, unknown>)[ID_A];
    }
  });

  it('range-fetches exactly the entry\'s bytes and validates the hash on a 206', async () => {
    const entry = detailEntry(ID_A, 'Workflow A');
    const line = JSON.stringify(entry);
    const hash = await sha256Hex(line);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 });
      if (url.endsWith('/detail-index-0.json')) {
        return { ok: true, json: async () => ({ [ID_A]: { offset: 0, length: line.length, sha256: hash } }) } as Response;
      }
      if (url.endsWith('/detail-0.jsonl')) {
        expect((init?.headers as Record<string, string>).Range).toBe(`bytes=0-${line.length - 1}`);
        return rangeResponse(206, line);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: true, entry });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('reuses the cached detail index across two lookups in the same shard', async () => {
    const entry = detailEntry(ID_A);
    const line = JSON.stringify(entry);
    const hash = await sha256Hex(line);
    const index = { [ID_A]: { offset: 0, length: line.length, sha256: hash }, [ID_B]: { offset: 999, length: 3, sha256: '0'.repeat(64) } };
    const indexHash = await sha256Hex(JSON.stringify(index));
    let indexFetches = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0, [ID_B]: 0 }, '2026-01-01T00:00:00.000Z', indexHash);
      if (url.endsWith('/detail-index-0.json')) {
        indexFetches += 1;
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(index)).buffer } as Response;
      }
      if (url.endsWith('/detail-0.jsonl')) return rangeResponse(206, line);
      throw new Error(`unexpected fetch: ${url}`);
    });

    await loadEntryDetail(ID_A);
    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: true, entry });
    expect(indexFetches).toBe(1);
  });

  it('treats a 200 (Range ignored) as range-unsupported and cancels the body without reading it', async () => {
    const cancel = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 });
      if (url.endsWith('/detail-index-0.json')) {
        return { ok: true, json: async () => ({ [ID_A]: { offset: 0, length: 5, sha256: '0'.repeat(64) } }) } as Response;
      }
      if (url.endsWith('/detail-0.jsonl')) {
        return {
          status: 200,
          body: { cancel },
          arrayBuffer: async () => { throw new Error('must never read the whole shard'); },
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: false, reason: 'range-unsupported' });
    expect(cancel).toHaveBeenCalled();
  });

  it('retries once on a short body, then succeeds', async () => {
    const entry = detailEntry(ID_A);
    const line = JSON.stringify(entry);
    const hash = await sha256Hex(line);
    let rangeCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 });
      if (url.endsWith('/detail-index-0.json')) {
        return { ok: true, json: async () => ({ [ID_A]: { offset: 0, length: line.length, sha256: hash } }) } as Response;
      }
      if (url.endsWith('/detail-0.jsonl')) {
        rangeCalls += 1;
        return rangeCalls === 1 ? rangeResponse(206, line.slice(0, 2)) : rangeResponse(206, line);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: true, entry });
    expect(rangeCalls).toBe(2);
  });

  it('gives up after a second short body with reason short-body', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 });
      if (url.endsWith('/detail-index-0.json')) {
        return { ok: true, json: async () => ({ [ID_A]: { offset: 0, length: 100, sha256: '0'.repeat(64) } }) } as Response;
      }
      if (url.endsWith('/detail-0.jsonl')) return rangeResponse(206, 'short');
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: false, reason: 'short-body' });
  });

  it('retries once on a network error, then succeeds', async () => {
    const entry = detailEntry(ID_A);
    const line = JSON.stringify(entry);
    const hash = await sha256Hex(line);
    let rangeCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 });
      if (url.endsWith('/detail-index-0.json')) {
        return { ok: true, json: async () => ({ [ID_A]: { offset: 0, length: line.length, sha256: hash } }) } as Response;
      }
      if (url.endsWith('/detail-0.jsonl')) {
        rangeCalls += 1;
        if (rangeCalls === 1) throw new Error('connection reset');
        return rangeResponse(206, line);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: true, entry });
    expect(rangeCalls).toBe(2);
  });

  it('gives up after a second network error with reason network', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 });
      if (url.endsWith('/detail-index-0.json')) {
        return { ok: true, json: async () => ({ [ID_A]: { offset: 0, length: 5, sha256: '0'.repeat(64) } }) } as Response;
      }
      if (url.endsWith('/detail-0.jsonl')) throw new Error('offline');
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: false, reason: 'network' });
  });

  it('reports hash-mismatch without retrying when the bytes are the right length but wrong content', async () => {
    const line = JSON.stringify({ id: ID_A });
    let rangeCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 });
      if (url.endsWith('/detail-index-0.json')) {
        return { ok: true, json: async () => ({ [ID_A]: { offset: 0, length: line.length, sha256: 'deadbeef'.repeat(8) } }) } as Response;
      }
      if (url.endsWith('/detail-0.jsonl')) {
        rangeCalls += 1;
        return rangeResponse(206, line);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: false, reason: 'hash-mismatch' });
    expect(rangeCalls).toBe(1);
  });

  it('reports malformed when the hashed bytes are not the entry they claim to be', async () => {
    const line = JSON.stringify(detailEntry('not-a'));
    const hash = await sha256Hex(line);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 });
      if (url.endsWith('/detail-index-0.json')) {
        return { ok: true, json: async () => ({ [ID_A]: { offset: 0, length: line.length, sha256: hash } }) } as Response;
      }
      if (url.endsWith('/detail-0.jsonl')) return rangeResponse(206, line);
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: false, reason: 'malformed' });
  });

  it('reports aborted, distinctly from network, when the caller cancels', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 });
      if (url.endsWith('/detail-index-0.json')) {
        return { ok: true, json: async () => ({ [ID_A]: { offset: 0, length: 5, sha256: '0'.repeat(64) } }) } as Response;
      }
      if (url.endsWith('/detail-0.jsonl')) {
        const err = new DOMException('aborted', 'AbortError');
        throw err;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadEntryDetail(ID_A, controller.signal)).resolves.toEqual({ ok: false, reason: 'aborted' });
  });

  it.each([
    ['network', 4],
    ['short-body', 4],
    ['range-unsupported', 2],
    ['malformed', 2],
    ['hash-mismatch', 2],
  ] as const)('does not cache a %s detail body after failure', async (failure, expectedBodyCalls) => {
    const entry = detailEntry(ID_A);
    const validLine = JSON.stringify(entry);
    const validHash = await sha256Hex(validLine);
    const malformedLine = 'x'.repeat(validLine.length);
    const body = failure === 'malformed' ? malformedLine : validLine;
    const ref = {
      offset: 0,
      length: new TextEncoder().encode(validLine).byteLength,
      sha256: failure === 'malformed' ? await sha256Hex(body) : validHash,
    };
    const index = { [ID_A]: ref };
    const indexBody = JSON.stringify(index);
    const indexHash = await sha256Hex(indexBody);
    let bodyCalls = 0;
    let indexCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 }, '2026-01-01T00:00:00.000Z', indexHash);
      if (url.endsWith('/detail-index-0.json')) {
        indexCalls += 1;
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode(indexBody).buffer } as Response;
      }
      if (url.endsWith('/detail-0.jsonl')) {
        bodyCalls += 1;
        if (failure === 'network') throw new Error('offline');
        if (failure === 'range-unsupported') {
          return { status: 200, body: { cancel: vi.fn() } } as unknown as Response;
        }
        if (failure === 'short-body') return rangeResponse(206, validLine.slice(0, 2));
        return rangeResponse(206, failure === 'hash-mismatch' ? 'z'.repeat(validLine.length) : body);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: false, reason: failure });
    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: false, reason: failure });
    expect(indexCalls).toBe(1);
    expect(bodyCalls).toBe(expectedBodyCalls);
  });
});

describe('detail index cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearDetailIndexCache();
    resetManifestCache();
  });

  it('re-issues an index request after a failure instead of replaying the rejection (SW-3)', async () => {
    const indexHash = await sha256Hex('{}');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 }, '2026-01-01T00:00:00.000Z', indexHash);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 }, '2026-01-01T00:00:00.000Z', indexHash);
      if (url.endsWith('/detail-index-0.json')) throw new Error('connection reset');
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: false, reason: 'network' });

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 }, '2026-01-01T00:00:00.000Z', indexHash);
      if (url.endsWith('/detail-index-0.json')) {
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode('{}').buffer } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: false, reason: 'not-found' });
  });

  it('keys successful index entries by release identity instead of shard alone', async () => {
    let generatedAt = '2026-01-01T00:00:00.000Z';
    const indexHash = await sha256Hex('{}');
    let indexCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 }, generatedAt, indexHash);
      if (url.endsWith('/detail-index-0.json')) {
        indexCalls += 1;
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode('{}').buffer } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: false, reason: 'not-found' });
    resetManifestCache();
    generatedAt = '2026-01-02T00:00:00.000Z';
    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: false, reason: 'not-found' });

    expect(indexCalls).toBe(2);
  });

  it('does not retain an index whose bytes do not match the manifest hash', async () => {
    const entry = detailEntry(ID_A);
    const line = JSON.stringify(entry);
    const entryHash = await sha256Hex(line);
    const validIndex = { [ID_A]: { offset: 0, length: line.length, sha256: entryHash } };
    const validIndexHash = await sha256Hex(JSON.stringify(validIndex));
    let indexCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 }, '2026-01-01T00:00:00.000Z', validIndexHash);
      if (url.endsWith('/detail-index-0.json')) {
        indexCalls += 1;
        const body = JSON.stringify(indexCalls === 1 ? {} : validIndex);
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode(body).buffer } as Response;
      }
      if (url.endsWith('/detail-0.jsonl')) return rangeResponse(206, line);
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: false, reason: 'network' });
    await expect(loadEntryDetail(ID_A)).resolves.toEqual({ ok: true, entry });
    expect(indexCalls).toBe(2);
  });
});

describe('fetchEntryById', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearDetailIndexCache();
    resetManifestCache();
  });

  it('resolves null for an unknown ID', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(manifestResponse({}));
    await expect(fetchEntryById(UNKNOWN_ID)).resolves.toBeNull();
  });

  it('resolves the entry on success', async () => {
    const entry = detailEntry(ID_A);
    const line = JSON.stringify(entry);
    const hash = await sha256Hex(line);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 });
      if (url.endsWith('/detail-index-0.json')) {
        return { ok: true, json: async () => ({ [ID_A]: { offset: 0, length: line.length, sha256: hash } }) } as Response;
      }
      if (url.endsWith('/detail-0.jsonl')) return rangeResponse(206, line);
      throw new Error(`unexpected fetch: ${url}`);
    });
    await expect(fetchEntryById(ID_A)).resolves.toEqual(entry);
  });

  it('throws a descriptive error for a non-recoverable failure, for the existing error-banner caller contract', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return manifestResponse({ [ID_A]: 0 });
      if (url.endsWith('/detail-index-0.json')) {
        return { ok: true, json: async () => ({ [ID_A]: { offset: 0, length: 5, sha256: '0'.repeat(64) } }) } as Response;
      }
      if (url.endsWith('/detail-0.jsonl')) throw new Error('offline');
      throw new Error(`unexpected fetch: ${url}`);
    });
    await expect(fetchEntryById(ID_A)).rejects.toThrow(/network/i);
  });
});
