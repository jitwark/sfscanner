import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@hub/contracts';
import { WorkflowViewClient } from './view-client';
import { useSearchParams, type ReadonlyURLSearchParams } from 'next/navigation';

// This project does not enable Vitest globals, so Testing Library's automatic
// per-test cleanup never registers and renders accumulate in one document.
// Mock call history accumulates the same way, so clear it too.
afterEach(() => { cleanup(); vi.clearAllMocks(); });

vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
}));
vi.mock('../../../src/catalogue/manifest', () => ({
  loadManifest: vi.fn(async () => ({ artifacts: [{ path: 'catalogue-0.json' }] })),
  shardForId: vi.fn(() => 0),
}));
vi.mock('../../../src/catalogue/entry-detail-client', () => ({
  // WorkflowContent resolves entries through fetchEntryById.
  fetchEntryById: vi.fn(),
}));
vi.mock('../../../src/ui/detail/detail-body', () => ({
  DetailBody: ({ entry, related }: { entry: Entry; related?: Entry[] }) => (
    <div data-testid="detail-entry" data-related={(related ?? []).map((item) => item.id).join(',')}>{entry.id}</div>
  ),
}));

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

/** A key-aware stub — the real `ReadonlyURLSearchParams.get` is too, and this
 * route now reads both `id` and `related` from it. */
function fakeSearchParams(values: Record<string, string | null>): ReadonlyURLSearchParams {
  return { get: (key: string) => values[key] ?? null } as unknown as ReadonlyURLSearchParams;
}

const entry = (id: string) => ({ id } as Entry);
const { fetchEntryById } = vi.mocked(await import('../../../src/catalogue/entry-detail-client'));

describe('WorkflowViewClient', () => {
  it('does not leak an earlier workflow entry after the id changes', async () => {
    let currentId = 'first';
    vi.mocked(useSearchParams).mockImplementation(() => fakeSearchParams({ id: currentId }));
    const requests: Array<Deferred<Entry | null>> = [];
    fetchEntryById.mockImplementation((id: string) => {
      void id;
      const request = deferred<Entry | null>();
      requests.push(request);
      return request.promise;
    });

    const { rerender } = render(<WorkflowViewClient />);
    await waitFor(() => expect(requests).toHaveLength(1));

    currentId = 'second';
    rerender(<WorkflowViewClient />);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(vi.mocked(fetchEntryById).mock.calls[0]?.[1]?.aborted).toBe(true);

    await act(async () => { requests[0]!.resolve(entry('first')); await requests[0]!.promise; });
    expect(screen.queryByTestId('detail-entry')).toBeNull();

    await act(async () => { requests[1]!.resolve(entry('second')); await requests[1]!.promise; });
    expect((await screen.findByTestId('detail-entry')).textContent).toContain('second');
  });

  /**
   * P5.4 fix: this route used to call `computeRelated(entry, [entry])` — a
   * candidate pool of exactly the entry itself, which `computeRelated` always
   * excludes, so related workflows were silently empty on every visit here.
   * The fix carries the correctly computed related ids on the URL
   * (`detail-href.ts`'s `interactiveHref`) and resolves each one through the
   * same bounded per-entry fetch used for the main entry.
   */
  it('resolves related ids carried on the URL through the byte-addressed per-entry fetch', async () => {
    vi.mocked(useSearchParams).mockImplementation(() => fakeSearchParams({ id: 'main', related: 'r1,r2' }));
    const byId: Record<string, Entry | null> = { main: entry('main'), r1: entry('r1'), r2: entry('r2') };
    fetchEntryById.mockImplementation(async (id: string) => byId[id] ?? null);

    render(<WorkflowViewClient />);

    const node = await screen.findByTestId('detail-entry');
    expect(node.textContent).toBe('main');
    expect(node.getAttribute('data-related')).toBe('r1,r2');
    expect(fetchEntryById).toHaveBeenCalledWith('main', expect.any(AbortSignal));
    expect(fetchEntryById).toHaveBeenCalledWith('r1', expect.any(AbortSignal));
    expect(fetchEntryById).toHaveBeenCalledWith('r2', expect.any(AbortSignal));
  });

  it('shows an explicit empty related list, rather than crashing, when the URL carries none', async () => {
    vi.mocked(useSearchParams).mockImplementation(() => fakeSearchParams({ id: 'main' }));
    fetchEntryById.mockImplementation(async (id: string) => (id === 'main' ? entry('main') : null));

    render(<WorkflowViewClient />);

    const node = await screen.findByTestId('detail-entry');
    expect(node.getAttribute('data-related')).toBe('');
    // No fetches were spent looking for related workflows that were never named.
    expect(fetchEntryById).toHaveBeenCalledTimes(1);
  });

  it('drops a related id that fails to resolve, rather than losing the whole page', async () => {
    vi.mocked(useSearchParams).mockImplementation(() => fakeSearchParams({ id: 'main', related: 'r1,broken' }));
    fetchEntryById.mockImplementation(async (id: string) => {
      if (id === 'main') return entry('main');
      if (id === 'r1') return entry('r1');
      throw new Error('network error');
    });

    render(<WorkflowViewClient />);

    const node = await screen.findByTestId('detail-entry');
    expect(node.getAttribute('data-related')).toBe('r1');
  });

  it('does not render its own <main> for the not-found state, because the shell owns it', () => {
    vi.mocked(useSearchParams).mockImplementation(() => fakeSearchParams({}));

    const { container } = render(<WorkflowViewClient />);

    expect(screen.getByText('This view needs a workflow id.')).toBeTruthy();
    expect(container.querySelector('main')).toBeNull();
  });

  it('never lets the current entry appear in its own related list', async () => {
    vi.mocked(useSearchParams).mockImplementation(() => fakeSearchParams({ id: 'main', related: 'main,r1' }));
    fetchEntryById.mockImplementation(async (id: string) => entry(id));

    render(<WorkflowViewClient />);

    const node = await screen.findByTestId('detail-entry');
    expect(node.getAttribute('data-related')).toBe('r1');
  });
});
