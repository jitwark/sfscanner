import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRetryableSearchClientLoader, HomeSearch } from './home-search';
import { IdlePrefetch } from './idle-prefetch';
import type { SearchResultItem } from '../search/search-client';

const router = vi.hoisted(() => ({ prefetch: vi.fn(), push: vi.fn() }));
const searchClientMock = vi.hoisted(() => ({ loaded: vi.fn(), search: vi.fn(), warmIndex: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));
vi.mock('../search/search-client', () => {
  searchClientMock.loaded();
  return { search: searchClientMock.search, warmIndex: searchClientMock.warmIndex };
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };
type SearchFixture = Pick<SearchResultItem, 'id' | 'slug' | 'title' | 'tags'>;
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

describe('HomeSearch', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('retries loading the search client after a failed import', async () => {
    const searchModule = { search: searchClientMock.search, warmIndex: searchClientMock.warmIndex } as unknown as typeof import('../search/search-client');
    const importClient = vi.fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValueOnce(searchModule);
    const loadSearchClient = createRetryableSearchClientLoader(importClient);
    const firstAttempt = loadSearchClient();

    expect(loadSearchClient()).toBe(firstAttempt);
    await expect(firstAttempt).rejects.toThrow('chunk unavailable');
    await expect(loadSearchClient()).resolves.toBe(searchModule);
    expect(importClient).toHaveBeenCalledTimes(2);
  });

  it('keeps search lazy on landing and warms it when the user focuses search', async () => {
    searchClientMock.search.mockResolvedValue({ items: [] } as never);
    searchClientMock.warmIndex.mockResolvedValue(undefined);
    render(<><IdlePrefetch /><HomeSearch /></>);

    const input = screen.getByRole('combobox');
    expect(searchClientMock.loaded).not.toHaveBeenCalled();
    fireEvent.focus(input);
    await waitFor(() => expect(searchClientMock.warmIndex).toHaveBeenCalledTimes(1));
    expect(searchClientMock.loaded).toHaveBeenCalledTimes(1);
    expect(searchClientMock.search).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'slack' } });
    await waitFor(() => expect(searchClientMock.search).toHaveBeenCalled());
    expect(searchClientMock.loaded).toHaveBeenCalledTimes(1);
  });

  it('does not show a slow search response after the query is cleared', async () => {
    const pending = deferred<{ items: SearchFixture[] }>();
    vi.mocked(searchClientMock.search).mockReturnValue(pending.promise as never);
    render(<HomeSearch />);

    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'slack' } });
    expect(screen.getByRole('status').textContent).toContain('Loading suggestions');
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByRole('status')).toBeNull();
    pending.resolve({ items: [{ id: '1', slug: 'slack', title: 'Slack workflow', tags: ['slack'] }] });
    await pending.promise;

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBeNull();
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('shows immediate pending feedback until suggestions return', async () => {
    const pending = deferred<{ items: SearchFixture[] }>();
    vi.mocked(searchClientMock.search).mockReturnValue(pending.promise as never);
    render(<HomeSearch />);

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'slack' } });
    expect(screen.getByRole('status').textContent).toContain('Loading suggestions');

    pending.resolve({ items: [{ id: '1', slug: 'slack', title: 'Slack workflow', tags: ['slack'] }] });
    await screen.findByRole('option', { name: /Slack workflow/ });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps pending feedback for the latest query when an older search resolves', async () => {
    const first = deferred<{ items: SearchFixture[] }>();
    const second = deferred<{ items: SearchFixture[] }>();
    vi.mocked(searchClientMock.search).mockReturnValueOnce(first.promise as never).mockReturnValueOnce(second.promise as never);
    render(<HomeSearch />);

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'slack' } });
    await waitFor(() => expect(searchClientMock.search).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: 'github' } });
    await waitFor(() => expect(searchClientMock.search).toHaveBeenCalledTimes(2));

    first.resolve({ items: [{ id: '1', slug: 'slack', title: 'Old Slack result', tags: [] }] });
    await first.promise;
    expect(screen.getByRole('status').textContent).toContain('Loading suggestions');
    expect(screen.queryByRole('option')).toBeNull();

    second.resolve({ items: [{ id: '2', slug: 'github', title: 'GitHub workflow', tags: [] }] });
    await screen.findByRole('option', { name: /GitHub workflow/ });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not show a stale search failure after the query is cleared', async () => {
    const pending = deferred<{ items: SearchFixture[] }>();
    vi.mocked(searchClientMock.search).mockReturnValue(pending.promise as never);
    render(<HomeSearch />);

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'slack' } });
    fireEvent.change(input, { target: { value: '' } });
    pending.reject(new Error('offline'));
    await pending.promise.catch(() => undefined);

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('announces a failed search and retries the current query', async () => {
    vi.mocked(searchClientMock.search)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [] } as never);
    render(<HomeSearch />);

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'slack' } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Suggestions could not be loaded.');
    expect(screen.queryByRole('status')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry suggestions' }));
    await waitFor(() => expect(vi.mocked(searchClientMock.search)).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the popup collapsed when a search returns no suggestions', async () => {
    vi.mocked(searchClientMock.search).mockResolvedValue({ items: [] } as never);
    render(<HomeSearch />);

    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'no matches' } });
    await waitFor(() => expect(vi.mocked(searchClientMock.search)).toHaveBeenCalled());

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBeNull();
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('removes a visible search failure when the query is cleared', async () => {
    vi.mocked(searchClientMock.search).mockRejectedValue(new Error('offline'));
    render(<HomeSearch />);

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'slack' } });
    await screen.findByRole('alert');
    fireEvent.change(input, { target: { value: '' } });

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opens suggestions as a combobox and enters the highlighted result', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/community-hub');
    vi.mocked(searchClientMock.search).mockResolvedValue({ items: [
      { id: '1', slug: 'slack', title: 'Slack workflow', tags: ['slack'], rightsStatus: 'redistributable', isPrerendered: true },
      { id: '2', slug: 'github', title: 'GitHub workflow', tags: ['github'], rightsStatus: 'redistributable', isPrerendered: true },
    ] } as never);
    render(<HomeSearch />);

    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'slack' } });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe('search-results-list');
    // No base path: the app router calls `addBasePath` itself, so passing a
    // prefixed path here asked for `/community-hub/community-hub/library/`.
    expect(router.prefetch).toHaveBeenCalledWith('/library/');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe('search-result-1');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(router.push).toHaveBeenCalledWith('/w/github/');

    const listbox = screen.getByRole('listbox');
    const viewAll = screen.getByRole('link', { name: 'View all results' });
    expect(listbox.contains(viewAll)).toBe(false);
    expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(screen.getByRole('option', { name: /GitHub workflow/ }).className).toContain('min-h-11');
    expect(screen.getByRole('option', { name: /GitHub workflow/ }).className).toContain('focus-visible:outline');
    expect(screen.getByRole('option', { name: /GitHub workflow/ }).className).toContain('bg-raised');
    expect(viewAll.className).toContain('min-h-11');
    expect(viewAll.className).toContain('focus-visible:outline');
  });

  it('leaves the base path to the router when Enter submits an unhighlighted query', () => {
    // This asserted `/community-hub/library/?q=slack`, and the component
    // produced it — by wrapping the push in `sitePath`. The app router calls
    // `addBasePath` itself (`next/dist/client/components/app-router-instance.js`),
    // so on a real Pages build that navigated to
    // `/community-hub/community-hub/library/`. A raw path is what `push` wants;
    // `sitePath` belongs on anchors and on `window.location`.
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/community-hub');
    render(<HomeSearch />);

    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'slack' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(router.push).toHaveBeenCalledWith('/library/?q=slack');
  });

  it('keeps the base path on the anchors, which no router touches', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/community-hub');
    vi.mocked(searchClientMock.search).mockResolvedValue({ items: [
      { id: '1', slug: 'slack', title: 'Slack workflow', tags: ['slack'], rightsStatus: 'redistributable', isPrerendered: false },
    ] } as never);
    render(<HomeSearch />);

    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'slack' } });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());

    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    const options = screen.getAllByRole('option').map((a) => a.getAttribute('href'));
    expect(hrefs.length).toBeGreaterThan(0);
    expect([...hrefs, ...options].every((href) => href?.startsWith('/community-hub/'))).toBe(true);
  });
});
