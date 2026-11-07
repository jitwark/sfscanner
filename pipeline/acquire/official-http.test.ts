import { describe, expect, it, vi } from 'vitest';
import { createHttpState, mapPool, requestJson } from './official-http.js';

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('mapPool', () => {
  it('never exceeds the limit and preserves input order', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 40 }, (_, i) => i);

    const out = await mapPool(
      items,
      async (n) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 1));
        active -= 1;
        return n * 2;
      },
      () => 6,
    );

    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1);
    expect(out).toEqual(items.map((n) => n * 2));
  });

  it('re-reads the limit between dispatches, so a 429 can shrink it mid-run', async () => {
    let limit = 8;
    let active = 0;
    let peakAfterDrop = 0;
    let done = 0;

    await mapPool(
      Array.from({ length: 30 }, (_, i) => i),
      async () => {
        active += 1;
        if (limit === 1) peakAfterDrop = Math.max(peakAfterDrop, active);
        await new Promise((r) => setTimeout(r, 1));
        done += 1;
        if (done === 8) limit = 1;
        active -= 1;
        return null;
      },
      () => limit,
    );

    expect(peakAfterDrop).toBeLessThanOrEqual(1);
  });

  it('returns an empty array for no items', async () => {
    expect(await mapPool([], async () => 1, () => 4)).toEqual([]);
  });
});

describe('requestJson', () => {
  it('returns the parsed body on success', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ hello: 'world' }));
    const state = createHttpState(12);
    const body = await requestJson('https://example.test/x', { fetchImpl, sleep: async () => {} }, state);
    expect(body).toEqual({ hello: 'world' });
    expect(state.concurrency).toBe(12);
  });

  it('retries a 429, backs off, and halves the concurrency for the rest of the run', async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, status: 429, json: async () => ({}) } as Response;
      return okResponse({ ok: true });
    });
    let slept = 0;
    const state = createHttpState(12);

    await requestJson(
      'https://example.test/x',
      { fetchImpl, sleep: async (ms) => { slept += ms; }, random: () => 0 },
      state,
    );

    expect(attempts).toBe(2);
    expect(slept).toBeGreaterThan(0);
    expect(state.concurrency).toBe(6);
  });

  it('never drops concurrency below one', async () => {
    const state = createHttpState(2);
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 4) return { ok: false, status: 429, json: async () => ({}) } as Response;
      return okResponse({});
    });
    await requestJson('https://example.test/x', { fetchImpl, sleep: async () => {}, random: () => 0 }, state);
    expect(state.concurrency).toBe(1);
  });

  it('does not retry a 404', async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    await expect(
      requestJson('https://example.test/x', { fetchImpl, sleep: async () => {} }, createHttpState(4)),
    ).rejects.toThrow(/404/);
    expect(attempts).toBe(1);
  });

  it('gives up after maxRetries and throws', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
    await expect(
      requestJson(
        'https://example.test/x',
        { fetchImpl, sleep: async () => {}, maxRetries: 2, random: () => 0 },
        createHttpState(4),
      ),
    ).rejects.toThrow(/official API request failed/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
