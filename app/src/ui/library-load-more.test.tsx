// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResponseData, SearchResultItem } from '../search/search-client';
import { SearchIndexError } from '../search/fetch-index';
import { readQueryState } from '../search/query-state';
import { LibraryClient } from './library-client';

/**
 * SW-0 (audit 2026-08-25): the library told the reader it held 12,923 workflows
 * and let them reach 24. The worker paginated all along; nothing in the UI ever
 * asked for a second page.
 *
 * These tests drive the control from the reader's side — click, count rows —
 * rather than asserting that an options object was forwarded, which would only
 * restate the mock.
 */

const router = vi.hoisted(() => ({ push: vi.fn(), prefetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const searchMock = vi.hoisted(() => vi.fn());
const manifestMock = vi.hoisted(() => vi.fn());
const rankingListener = vi.hoisted(() => ({ current: undefined as (() => void) | undefined }));
vi.mock('../search/search-client', () => ({
  onProgress: () => () => undefined,
  onRankingImproved: (callback: () => void) => { rankingListener.current = callback; return () => { if (rankingListener.current === callback) rankingListener.current = undefined; }; },
  search: searchMock,
  warmIndex: () => undefined,
  getLoadedSearchReleaseIdentity: () => undefined,
  getFacetsState: () => ({ status: 'ok' }),
  onFacetsStateChange: () => () => undefined,
  retryFacets: async () => ({ status: 'ok' }),
}));

vi.mock('../catalogue/manifest', () => ({
  loadManifest: manifestMock,
}));

const EMPTY_COUNTS = { rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: {}, tags: {} };

function item(id: string): SearchResultItem {
  return {
    id,
    slug: id,
    title: `Workflow ${id}`,
    summary: 'A catalogued workflow.',
    tags: [],
    integrations: [],
    triggers: [],
    capabilities: [],
    grade: 'LOW',
    rights: 'link_only',
    complexity: 'simple',
    nodeCount: 4,
  };
}

/** A corpus of 60 workflows served 24 at a time, as the worker would. */
const CORPUS = Array.from({ length: 60 }, (_, index) => item(`w-${index}`));

function servePages() {
  searchMock.mockImplementation((_query: string, _filters: unknown, options?: { page?: number; limit?: number }) => {
    const limit = options?.limit ?? 24;
    const page = options?.page ?? 1;
    const start = (page - 1) * limit;
    return Promise.resolve({
      ids: CORPUS.map((entry) => entry.id),
      total: CORPUS.length,
      counts: EMPTY_COUNTS,
      items: CORPUS.slice(start, start + limit),
    });
  });
}

/**
 * Seeded with three rows rather than a full page, so "the client's own first
 * search has landed" is observable as the count reaching 24. Seeding with 24
 * makes the server-rendered page and the client's first page indistinguishable,
 * and a click fired in between gets overwritten when that first search resolves.
 */
function renderLibrary() {
  return render(createElement(LibraryClient, {
    initialItems: CORPUS.slice(0, 3),
    initialCounts: { ...EMPTY_COUNTS, tags: { code: 3 } },
    totalCount: CORPUS.length,
  }));
}

const rowCount = () => screen.queryAllByRole('listitem').length;

/** Wait for the client's first search to replace the server-rendered rows. */
async function settled() {
  await waitFor(() => expect(rowCount()).toBe(24));
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  HTMLDialogElement.prototype.close = function close() { this.open = false; };
  window.history.replaceState({}, '', '/library/');
  searchMock.mockReset();
  manifestMock.mockReset();
  manifestMock.mockRejectedValue(new Error('manifest unavailable'));
  rankingListener.current = undefined;
  servePages();
});

afterEach(() => cleanup());

describe('library pagination', () => {
  it('distinguishes an index failure from zero results and retries the current page', async () => {
    window.history.replaceState({}, '', '/library/?q=slack&tag=code');
    searchMock.mockRejectedValueOnce(new Error('malformed index'));
    renderLibrary();

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByText(/search index unavailable/i)).toBeDefined();
    expect(screen.getByText(/Release: manifest-v1 · unavailable/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Retry search' }));
    await settled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(searchMock.mock.calls.at(-1)?.[0]).toBe('slack');
    expect(searchMock.mock.calls.at(-1)?.[1]?.tag).toEqual(['code']);
    expect(searchMock.mock.calls.at(-1)?.[2]?.page ?? 1).toBe(1);
  });

  it('explains when search data is unavailable without claiming zero results', async () => {
    searchMock.mockRejectedValueOnce(new SearchIndexError('unavailable', 'offline'));
    renderLibrary();

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByText(/check your connection/i)).toBeDefined();
    expect(screen.queryByText(/No workflows match/i)).toBeNull();
  });

  it('shows the manifest release identity when it is available', async () => {
    manifestMock.mockResolvedValueOnce({ schemaVersion: 'manifest-v1', generatedAt: '2026-08-28T00:00:00.000Z' });
    searchMock.mockRejectedValueOnce(new Error('malformed index'));
    renderLibrary();

    await waitFor(() => expect(screen.getByText(/Release: manifest-v1 · 2026-08-28T00:00:00.000Z/i)).toBeDefined());
  });

  it('appends the next page instead of replacing the current one', async () => {
    renderLibrary();
    await settled();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => expect(rowCount()).toBe(48));
    expect(screen.getByText('Workflow w-0')).toBeDefined();
    expect(screen.getByText('Workflow w-24')).toBeDefined();
  });

  it('keeps loaded rows and retries the failed append page', async () => {
    renderLibrary();
    await settled();
    searchMock.mockRejectedValueOnce(new Error('transient index failure'));

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(rowCount()).toBe(24);

    fireEvent.click(screen.getByRole('button', { name: 'Retry search' }));
    await waitFor(() => expect(rowCount()).toBe(48));
    expect(searchMock.mock.calls.at(-1)?.[2]?.page ?? 1).toBe(2);
  });

  it('persists loaded depth and restores it from the URL', async () => {
    renderLibrary();
    await settled();
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(rowCount()).toBe(48));
    expect(readQueryState().page).toBe(2);

    cleanup();
    renderLibrary();
    await waitFor(() => expect(rowCount()).toBe(48));
    expect(searchMock.mock.calls.at(-1)?.[2]?.limit ?? 0).toBe(48);
  });

  it('does not let an older query response overwrite a newer one', async () => {
    const requests: Array<(value: SearchResponseData) => void> = [];
    searchMock.mockImplementation(() => new Promise<SearchResponseData>((resolve) => requests.push(resolve)));
    renderLibrary();
    await waitFor(() => expect(requests).toHaveLength(1));

    fireEvent.change(screen.getByRole('combobox', { name: 'Search n8n workflows' }), { target: { value: 'slack' } });
    await waitFor(() => expect(requests).toHaveLength(2));
    const response = (items: SearchResultItem[]): SearchResponseData => ({ ids: items.map((entry) => entry.id), total: items.length, counts: EMPTY_COUNTS, items });

    requests[1]!(response(CORPUS.slice(24, 48)));
    await waitFor(() => expect(screen.getByText('Workflow w-24')).toBeDefined());
    requests[0]!(response(CORPUS.slice(0, 24)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText('Workflow w-24')).toBeDefined();
    expect(screen.queryByText('Workflow w-0')).toBeNull();
  });

  it('keeps the keyboard-focused item stable when semantic ranking improves', async () => {
    renderLibrary();
    await settled();
    const input = screen.getByRole('combobox', { name: 'Search n8n workflows' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('result-w-0');
    const reordered = [...CORPUS.slice(1, 24), CORPUS[0]!];
    searchMock.mockResolvedValueOnce({ ids: reordered.map((entry) => entry.id), total: CORPUS.length, counts: EMPTY_COUNTS, items: reordered });

    rankingListener.current?.();
    await waitFor(() => expect(screen.getAllByRole('listitem')[0]?.textContent).toContain('Workflow w-1'));
    expect(input.getAttribute('aria-activedescendant')).toBe('result-w-0');
  });

  it('tells the reader how far through the results they are', async () => {
    renderLibrary();
    await settled();

    expect(screen.getByText(/showing 24 of 60/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(screen.getByText(/showing 48 of 60/i)).toBeDefined());
  });

  it('withdraws the control once every result is on screen', async () => {
    renderLibrary();
    await settled();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(rowCount()).toBe(48));

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(rowCount()).toBe(60));

    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('returns to the first page when the query changes', async () => {
    renderLibrary();
    await settled();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(rowCount()).toBe(48));

    // A stale page number against a fresh result set is the obvious bug here:
    // typing a new query must not leave the reader on page 2 of the old one.
    fireEvent.change(screen.getByRole('combobox', { name: 'Search n8n workflows' }), { target: { value: 'slack' } });

    await waitFor(() => expect(rowCount()).toBe(24));
    const lastCall = searchMock.mock.calls.at(-1);
    expect(lastCall?.[2]?.page ?? 1).toBe(1);
  });
});

/**
 * R2-F2. Deleting `<FacetsNotice />` from `library-client.tsx`'s JSX passed all
 * 27 tests in this file and its sibling — the exact mistake an interrupted
 * agent already made once this session, when the component was written but
 * never wired in. The mocks were extended only to stop a crash, never to
 * assert the notice is mounted, and no E2E spec looks for `role="status"`.
 *
 * This asserts the seam itself: the degraded-state live region must exist in
 * the rendered library, so unwiring it fails a test instead of shipping.
 */
describe('facets degraded-state wiring (R2-F2)', () => {
  it('mounts the facets live region so an unwired notice cannot ship silently', async () => {
    renderLibrary();
    await waitFor(() => expect(screen.getAllByRole('status').length).toBeGreaterThan(0));
  });
});
