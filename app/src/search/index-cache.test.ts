import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictStaleArtifacts, getCachedFacets, getCachedIndex, setCachedFacets, setCachedIndex } from './index-cache';

describe('index-cache', () => {
  const store = new Map<string, unknown>();

  const mockDb = {
    transaction: () => ({
      objectStore: () => ({
        get: (key: string) => {
          const req = { result: store.get(key), onsuccess: null as any, onerror: null as any };
          setTimeout(() => req.onsuccess?.({ target: req }), 0);
          return req;
        },
        put: (val: any) => {
          store.set(val.key, val);
          const req = { onsuccess: null as any, onerror: null as any };
          setTimeout(() => req.onsuccess?.({ target: req }), 0);
          return req;
        },
        openCursor: () => {
          const keys = Array.from(store.keys());
          let idx = 0;
          const req = { result: null as any, onsuccess: null as any, onerror: null as any };
          const step = () => {
            if (idx < keys.length) {
              const k = keys[idx++];
              req.result = {
                value: store.get(k),
                delete: () => store.delete(k),
                continue: () => setTimeout(step, 0),
              };
            } else {
              req.result = null;
            }
            req.onsuccess?.({ target: req });
          };
          setTimeout(step, 0);
          return req;
        },
      }),
    }),
    close: vi.fn(),
  };

  beforeEach(() => {
    store.clear();
    (globalThis as any).indexedDB = {
      open: () => {
        const req = {
          result: mockDb,
          onsuccess: null as any,
          onerror: null as any,
          onupgradeneeded: null as any,
        };
        setTimeout(() => {
          req.onupgradeneeded?.({ target: { result: { createObjectStore: vi.fn(), objectStoreNames: { contains: () => false } } } });
          req.onsuccess?.({ target: req });
        }, 0);
        return req;
      },
    };
  });

  afterEach(() => {
    delete (globalThis as any).indexedDB;
  });

  it('returns null on cache miss and retrieves stored index on hit', async () => {
    const miss = await getCachedIndex('hash-123');
    expect(miss).toBeNull();

    await setCachedIndex('hash-123', '{"items":[]}');
    const hit = await getCachedIndex('hash-123');
    expect(hit).toBe('{"items":[]}');
  });

  it('stores and retrieves facets data', async () => {
    const facets = { total: 10, counts: { trigger: { cron: 5 } } } as any;
    await setCachedFacets('hash-123', facets);
    const hit = await getCachedFacets('hash-123');
    expect(hit).toEqual(facets);
  });

  it('evicts stale artifacts when sha does not match', async () => {
    await setCachedIndex('old-hash', '{"old":true}');
    await setCachedIndex('current-hash', '{"current":true}');

    await evictStaleArtifacts('current-hash');
    expect(await getCachedIndex('old-hash')).toBeNull();
    expect(await getCachedIndex('current-hash')).toBe('{"current":true}');
  });

  it('gracefully handles missing or failing indexedDB without throwing', async () => {
    delete (globalThis as any).indexedDB;
    expect(await getCachedIndex('hash-1')).toBeNull();
    expect(await getCachedFacets('hash-1')).toBeNull();
    await expect(setCachedIndex('hash-1', '{}')).resolves.toBeUndefined();
    await expect(setCachedFacets('hash-1', {} as any)).resolves.toBeUndefined();
    await expect(evictStaleArtifacts('hash-1')).resolves.toBeUndefined();
  });

  it('gracefully handles indexedDB open onerror', async () => {
    (globalThis as any).indexedDB = {
      open: () => {
        const req = { onsuccess: null as any, onerror: null as any, error: new Error('Permission denied') };
        setTimeout(() => req.onerror?.({ target: req }), 0);
        return req;
      },
    };
    expect(await getCachedIndex('hash-1')).toBeNull();
    expect(await getCachedFacets('hash-1')).toBeNull();
    await expect(setCachedIndex('hash-1', '{}')).resolves.toBeUndefined();
  });
});
