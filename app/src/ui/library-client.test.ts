// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResultItem } from '../search/search-client';
import { LibraryClient } from './library-client';
import { toLibraryItemFromSearch } from './library-client-model';
import { visibleQuickFilters } from './quick-filter-row';

// LibraryClient navigates with the app router now — a full page load here
// re-downloaded the search and semantic indexes the visitor had just waited for.
const router = vi.hoisted(() => ({ push: vi.fn(), prefetch: vi.fn() }));
const stopProgress = vi.hoisted(() => vi.fn());
const stopRanking = vi.hoisted(() => vi.fn());
const warmIndex = vi.hoisted(() => vi.fn());
const searchMock = vi.hoisted(() => vi.fn());
const loadedReleaseMock = vi.hoisted(() => vi.fn());
const rankingListener = vi.hoisted(() => ({ current: null as (() => void) | null }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

vi.mock('../search/search-client', () => ({
  onProgress: () => stopProgress,
  onRankingImproved: (callback: () => void) => {
    rankingListener.current = callback;
    return () => { stopRanking(); if (rankingListener.current === callback) rankingListener.current = null; };
  },
  search: searchMock,
  warmIndex,
  getLoadedSearchReleaseIdentity: loadedReleaseMock,
  getFacetsState: () => ({ status: 'ok' }),
  onFacetsStateChange: () => () => undefined,
  retryFacets: async () => ({ status: 'ok' }),
}));
const EMPTY_COUNTS = { rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: {}, tags: {} };

beforeEach(() => {
  window.history.replaceState({}, '', '/library/');
  searchMock.mockClear();
  searchMock.mockImplementation(() => new Promise(() => undefined));
  rankingListener.current = null;
  loadedReleaseMock.mockReset();
  loadedReleaseMock.mockReturnValue(undefined);
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  HTMLDialogElement.prototype.close = function close() { this.open = false; };
});

afterEach(() => cleanup());

describe('toLibraryItemFromSearch', () => {
  it('uses the search response item without requiring a catalogue shard', () => {
    const item: SearchResultItem = {
      id: 'workflow-1',
      slug: 'workflow-1',
      title: 'Send an email',
      summary: 'Sends an email after a form submission.',
      tags: ['email', 'form'],
      integrations: ['gmail'],
      triggers: ['form'],
      capabilities: [],
      grade: 'LOW',
      rights: 'link_only',
      complexity: 'simple',
      nodeCount: 3,
      descriptionSource: 'source',
      isIndexable: true,
      isPrerendered: false,
    };

    expect(toLibraryItemFromSearch(item)).toEqual(item);
  });

  it('shows the shared indexable total instead of the 24-item initial slice', () => {
    const item: SearchResultItem = {
      id: 'workflow-1', slug: 'workflow-1', title: 'Send an email', summary: 'Sends an email.',
      tags: ['email'], integrations: ['gmail'], triggers: ['form'], capabilities: [],
      grade: 'LOW', rights: 'redistributable', complexity: 'simple', nodeCount: 3,
      isIndexable: true, isPrerendered: true,
    };
    const counts = { rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: {}, tags: {} };

    render(createElement(LibraryClient, { initialItems: [item], initialCounts: counts, totalCount: 42 }));

    expect(screen.getAllByText('42 workflows').length).toBeGreaterThan(0);
  });

  it('gives the filter opener an accessible target at every width', () => {
    const counts = { rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: {}, tags: {} };

    render(createElement(LibraryClient, { initialItems: [], initialCounts: counts, totalCount: 0 }));

    const opener = screen.getByRole('button', { name: 'Filters' });
    expect(opener.className).toContain('h-11');
    expect(opener.className).toContain('focus-visible:ring-2');
    expect(opener.className).toContain('active:bg-raised');
    expect(opener.parentElement?.className).not.toContain('lg:hidden');
  });

  it('opens the facet dialog from the Filters control', async () => {
    const counts = { rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: {}, tags: {} };

    render(createElement(LibraryClient, { initialItems: [], initialCounts: counts, totalCount: 0 }));
    const opener = screen.getByRole('button', { name: 'Filters' });

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(opener);

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Filters' })).toBeDefined());
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Apply filters' })).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Clear all' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Close' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(opener);
  });

  it('does not mount closed facet options and bounds the opened integration list', async () => {
    const integrations = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`integration-${index}`, index + 1]));
    const counts = { ...EMPTY_COUNTS, integrations };

    render(createElement(LibraryClient, {
      initialItems: [], initialCounts: counts, totalCount: 100,
    }));

    expect(document.querySelector('dialog')).toBeNull();
    expect(document.querySelector('#facet-search-integration')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show 60 more integrations' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const dialog = await waitFor(() => screen.getByRole('dialog', { name: 'Filters' }));
    const integrationButtons = () => [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => (button.getAttribute('aria-label') ?? '').startsWith('Integration '));

    expect(integrationButtons()).toHaveLength(40);
    expect(screen.getByRole('button', { name: 'Integration 99 100' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Show 60 more integrations' })).toBeDefined();
  });

  it('keeps active filters and result count outside the dialog while sort stays independently URL-backed', async () => {
    const counts = { rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: { slack: 7 }, tags: {} };
    window.history.replaceState({}, '', '/library/?integration=slack&sort=quality');

    render(createElement(LibraryClient, { initialItems: [], initialCounts: counts, totalCount: 7 }));
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));
    expect(searchMock.mock.calls[0]?.[2]?.sort).toBe('quality');
    const sort = screen.getByRole('combobox', { name: 'Sort results' });
    expect((sort as HTMLSelectElement).value).toBe('quality');
    expect(screen.getByText('Ranked by quality')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    const dialog = screen.getByRole('dialog', { name: 'Filters' });
    expect(dialog.contains(screen.getByRole('button', { name: 'Remove Slack' }))).toBe(false);
    expect([...screen.getAllByText(/\d+ workflows/)].some((element) => !dialog.contains(element))).toBe(true);
    expect(dialog.contains(sort)).toBe(false);

    fireEvent.change(sort, { target: { value: 'relevance' } });
    expect(window.location.search).toContain('sort=relevance');
    expect((sort as HTMLSelectElement).value).toBe('relevance');
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(2));
    expect(searchMock.mock.calls.at(-1)?.[2]?.sort).toBe('relevance');
  });

  it('does not present a stale release as a valid empty result', async () => {
    searchMock.mockResolvedValueOnce({ ids: ['new-release'], total: 1, counts: EMPTY_COUNTS, items: [{
      id: 'new-release', slug: 'new-release', title: 'New release workflow', summary: 'Updated', tags: [], integrations: [],
      triggers: [], capabilities: [], grade: 'LOW', rights: 'link_only', complexity: 'simple', nodeCount: 4,
    }] });
    loadedReleaseMock.mockReturnValue({ schemaVersion: 'manifest-v1', generatedAt: '2026-08-30T00:00:00.000Z', searchIndexSha256: 'b'.repeat(64) });

    render(createElement(LibraryClient, {
      initialItems: [], initialCounts: EMPTY_COUNTS, totalCount: 1,
      initialReleaseIdentity: { schemaVersion: 'manifest-v1', generatedAt: '2026-08-30T00:00:00.000Z', searchIndexSha256: 'a'.repeat(64) },
    }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByText(/different releases/i)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Refresh library' })).toBeDefined();
    expect(screen.queryByText(/No workflows match/i)).toBeNull();
    expect(screen.queryByText('New release workflow')).toBeNull();
  });

  it('surfaces saved filters that are absent from the current release', async () => {
    window.history.replaceState({}, '', '/library/?integration=retired-crm&sort=quality');
    render(createElement(LibraryClient, {
      initialItems: [], initialCounts: { ...EMPTY_COUNTS, integrations: { slack: 2 } }, totalCount: 2,
    }));

    await waitFor(() => expect(screen.getByText(/not present in this release/i)).toBeDefined());
    expect(screen.getByRole('button', { name: 'Reset saved filters' })).toBeDefined();
    expect(searchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Reset saved filters' }));
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));
    expect(window.location.search).toBe('?sort=relevance');
  });

  it('summarizes active filters and exposes quick URL-backed filters', () => {
    const counts = { rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: { slack: 4 }, tags: { alerts: 3 } };
    render(createElement(LibraryClient, { initialItems: [], initialCounts: counts, totalCount: 0 }));

    expect(screen.getByRole('button', { name: /Filters/ })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Quick filter Slack 4' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Quick filter Slack 4' }));
    expect(window.location.search).toContain('integration=slack');
    expect(screen.getByRole('button', { name: /Filters \(1: Slack\)/ })).toBeDefined();
  });

  it('offers clear recovery when filters yield no results', () => {
    const counts = { rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: {}, tags: {} };
    window.history.replaceState({}, '', '/library/?grade=HIGH');
    render(createElement(LibraryClient, { initialItems: [], initialCounts: counts, totalCount: 0 }));

    expect(screen.getByText(/No workflows match/)).toBeDefined();
    const clear = screen.getByRole('button', { name: 'Clear filters' });
    expect(clear.className).toContain('min-h-11');
    expect(clear.className).toContain('hover:bg-raised');
    expect(clear.className).toContain('focus-visible:ring-2');
    expect(clear.className).toContain('active:bg-raised');
    const relaxed = screen.getByRole('button', { name: 'Try the same search with relaxed filters' });
    expect(relaxed.className).toContain('min-h-11');
    expect(relaxed.className).toContain('focus-visible:ring-2');
    expect(relaxed.className).toContain('active:bg-raised');
  });

  it('keeps a selected zero-count filter removable from the active summary', () => {
    const counts = { rights: {}, grade: {}, trigger: {}, complexity: {}, capabilities: {}, integrations: {}, tags: {} };
    window.history.replaceState({}, '', '/library/?tag=custom-tag');
    render(createElement(LibraryClient, { initialItems: [], initialCounts: counts, totalCount: 0 }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Custom Tag' }));
    expect(window.location.search).not.toContain('tag=custom-tag');
  });

  it('cleans subscriptions and fallback warm-up timers on unmount', () => {
    vi.useFakeTimers();
    stopProgress.mockClear();
    stopRanking.mockClear();
    warmIndex.mockClear();
    try {
      render(createElement(LibraryClient, { initialItems: [], initialCounts: EMPTY_COUNTS, totalCount: 0 }));
      cleanup();
      vi.advanceTimersByTime(10);
      expect(stopProgress).toHaveBeenCalledOnce();
      expect(stopRanking).toHaveBeenCalledOnce();
      expect(warmIndex).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the superseded search transport when the query changes', async () => {
    window.history.replaceState({}, '', '/library/');
    const signals: AbortSignal[] = [];
    searchMock.mockImplementation((_query: string, _filters: unknown, _options: unknown, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return new Promise(() => undefined);
    });
    render(createElement(LibraryClient, { initialItems: [], initialCounts: EMPTY_COUNTS, totalCount: 0 }));

    await waitFor(() => expect(searchMock).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole('combobox', { name: 'Search n8n workflows' }), { target: { value: 'slack' } });
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(2));

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('restores paginated results when browser history changes only the URL page', async () => {
    searchMock.mockResolvedValue({ ids: [], total: 48, counts: EMPTY_COUNTS, items: [] });
    render(createElement(LibraryClient, { initialItems: [], initialCounts: EMPTY_COUNTS, totalCount: 48 }));

    await waitFor(() => expect(searchMock).toHaveBeenCalledOnce());
    window.history.pushState({}, '', '/library/?page=2');
    window.dispatchEvent(new PopStateEvent('popstate'));

    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(2));
    expect(searchMock.mock.calls.at(-1)?.[2]).toMatchObject({ page: 1, limit: 48, sort: 'relevance' });
    expect(new URL(window.location.href).searchParams.get('page')).toBe('2');
    expect(screen.getByText('48 workflows')).toBeDefined();
  });

  it('loads the page saved in the URL before the first post-hydration search', async () => {
    window.history.replaceState({}, '', '/library/?page=5');
    searchMock.mockResolvedValue({ ids: [], total: 240, counts: EMPTY_COUNTS, items: [] });

    render(createElement(LibraryClient, { initialItems: [], initialCounts: EMPTY_COUNTS, totalCount: 240 }));

    await waitFor(() => expect(searchMock).toHaveBeenCalledOnce());
    expect(searchMock.mock.calls[0]?.[2]).toMatchObject({ page: 1, limit: 120 });
  });
});

describe('LibraryClient hydration', () => {
  it('renders the static default tree before applying a saved query', () => {
    window.history.replaceState({}, '', '/library/?q=slack');

    const html = renderToString(createElement(LibraryClient, {
      initialItems: [], initialCounts: EMPTY_COUNTS, totalCount: 42,
    }));

    expect(html).toContain('value=""');
    expect(html).toContain('42<!-- --> workflows');
    expect(html).not.toContain('No workflows match');
  });
});

describe('ranking refreshes', () => {
  it('keeps the keyboard-active item addressable when reranking drops it from the page slice', async () => {
    const focused = {
      id: 'focused', slug: 'focused', title: 'Focused workflow', summary: 'Focused', tags: [], integrations: [],
      triggers: [], capabilities: [], grade: 'LOW' as const, rights: 'redistributable' as const, complexity: 'simple' as const,
      nodeCount: 2, isIndexable: true, isPrerendered: true,
    };
    const replacement = { ...focused, id: 'replacement', slug: 'replacement', title: 'Replacement workflow' };
    searchMock.mockResolvedValueOnce({ ids: [focused.id, replacement.id], total: 2, counts: EMPTY_COUNTS, items: [focused, replacement] });
    searchMock.mockResolvedValueOnce({ ids: [replacement.id], total: 2, counts: EMPTY_COUNTS, items: [replacement] });

    render(createElement(LibraryClient, { initialItems: [], initialCounts: EMPTY_COUNTS, totalCount: 2 }));
    const input = await waitFor(() => screen.getByRole('combobox', { name: 'Search n8n workflows' }));
    await waitFor(() => expect(screen.getByText('Focused workflow')).toBeDefined());
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('result-focused');

    rankingListener.current?.();
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(input.getAttribute('aria-activedescendant')).toBe('result-focused'));
  });
});

describe('visibleQuickFilters', () => {
  it('returns the highest-count integrations and tags without a static corpus cap', () => {
    const filters = visibleQuickFilters({ integrations: { slack: 4, github: 8 }, tags: { alerts: 6, custom: 2 } }, 3);
    expect(filters.map((filter) => `${filter.group}:${filter.slug}`)).toEqual([
      'integration:github', 'intent:alerts', 'integration:slack',
    ]);
  });
});
