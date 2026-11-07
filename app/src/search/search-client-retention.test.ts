// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSearchClientState, search, warmIndex } from './search-client';
import { resetManifestCache } from '../catalogue/manifest';

class TestWorker {
  static instance: TestWorker | undefined;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly messages: unknown[] = [];
  postMessage(message: unknown): void { this.messages.push(message); }
  terminate(): void {}
  emit(data: unknown): void { this.onmessage?.({ data }); }
  crash(): void { this.onerror?.(new Event('error')); }
}

beforeEach(() => {
  resetSearchClientState();
  resetManifestCache();
  TestWorker.instance = undefined;
});

afterEach(() => {
  resetSearchClientState();
  resetManifestCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  TestWorker.instance = undefined;
});

describe('search index retention', () => {
  it('reloads a verified index for crash recovery after the worker is ready', async () => {
    vi.stubGlobal('Worker', class extends TestWorker {
      constructor() { super(); TestWorker.instance = this; }
    });

    const data = path.resolve(__dirname, '../../public/data');
    const indexJson = fs.readFileSync(path.join(data, 'search-index.json'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(data, 'manifest.json'), 'utf8'));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return { ok: true, json: async () => manifest } as unknown as Response;
      if (url.endsWith('/data/search-index.json')) {
        return { ok: true, headers: new Headers(), body: null, text: async () => indexJson } as unknown as Response;
      }
      return { ok: false, status: 404 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const waitForWorker = async () => {
      for (let turn = 0; turn < 100 && !TestWorker.instance; turn++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const warming = warmIndex();
    await waitForWorker();
    const worker = TestWorker.instance;
    expect(worker, JSON.stringify(fetchMock.mock.calls.map(([input]) => String(input)))).toBeDefined();
    worker!.emit({ type: 'ready' });
    await warming;

    worker!.crash();
    const result = search('slack');

    await expect(result).resolves.toMatchObject({ total: expect.any(Number) });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/data/search-index.json'))).toHaveLength(2);
  });
});
