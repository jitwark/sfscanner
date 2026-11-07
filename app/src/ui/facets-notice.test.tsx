// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FacetsState } from '../search/search-client';
import { FacetsNotice } from './facets-notice';

const stateRef = vi.hoisted(() => ({ current: { status: 'ok' } as FacetsState }));
const listeners = vi.hoisted(() => new Set<(state: FacetsState) => void>());
const unsubscribe = vi.hoisted(() => vi.fn());
const retryFacetsMock = vi.hoisted(() => vi.fn());
const emit = (next: FacetsState) => { stateRef.current = next; for (const listener of listeners) listener(next); };

vi.mock('../search/search-client', () => ({
  getFacetsState: () => stateRef.current,
  onFacetsStateChange: (callback: (state: FacetsState) => void) => {
    listeners.add(callback);
    return () => { unsubscribe(); listeners.delete(callback); };
  },
  retryFacets: retryFacetsMock,
}));

beforeEach(() => {
  stateRef.current = { status: 'ok' };
  listeners.clear();
  unsubscribe.mockClear();
  retryFacetsMock.mockReset();
});

afterEach(() => cleanup());

describe('FacetsNotice', () => {
  it('renders nothing announced when facets are ok', () => {
    render(<FacetsNotice />);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('announces a degraded notice that results are still complete', () => {
    stateRef.current = { status: 'degraded', reason: 'http', retryable: true };
    render(<FacetsNotice />);
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/limited/i);
    expect(status.textContent).toMatch(/results are complete/i);
  });

  it('offers a focusable, named retry button only when retryable', () => {
    stateRef.current = { status: 'degraded', reason: 'http', retryable: true };
    render(<FacetsNotice />);
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();

    // The component reads `getFacetsState` once on mount and takes every later
    // value from the subscription, so a state change has to be emitted — a bare
    // `rerender` leaves the mounted state untouched and proves nothing.
    act(() => emit({ status: 'degraded', reason: 'absent', retryable: false }));
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/reload/i);
  });

  it('calls retryFacets when the retry button is clicked, and clears the notice on success', async () => {
    stateRef.current = { status: 'degraded', reason: 'unavailable', retryable: true };
    retryFacetsMock.mockImplementation(async () => { emit({ status: 'ok' }); return { status: 'ok' } as FacetsState; });
    render(<FacetsNotice />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retryFacetsMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('button', { name: /retry/i })).toBeNull());
    expect(screen.getByRole('status').textContent).not.toMatch(/limited/i);
  });

  it('keeps the notice visible when a retry fails to recover', async () => {
    stateRef.current = { status: 'degraded', reason: 'unavailable', retryable: true };
    retryFacetsMock.mockImplementation(async () => {
      emit({ status: 'degraded', reason: 'unavailable', retryable: true });
      return { status: 'degraded', reason: 'unavailable', retryable: true } as FacetsState;
    });
    render(<FacetsNotice />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(retryFacetsMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status').textContent).toMatch(/limited/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
  });

  it('unsubscribes from facets state changes on unmount', () => {
    const { unmount } = render(<FacetsNotice />);
    expect(listeners.size).toBe(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it('does not move focus when the notice first appears', () => {
    stateRef.current = { status: 'degraded', reason: 'http', retryable: true };
    render(<FacetsNotice />);
    expect(document.activeElement).toBe(document.body);
  });

  it('restores focus to the status region if the retry button had focus when it recovers', async () => {
    stateRef.current = { status: 'degraded', reason: 'unavailable', retryable: true };
    retryFacetsMock.mockImplementation(async () => { emit({ status: 'ok' }); return { status: 'ok' } as FacetsState; });
    render(<FacetsNotice />);
    const button = screen.getByRole('button', { name: /retry/i });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole('button', { name: /retry/i })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('status'));
  });
});
