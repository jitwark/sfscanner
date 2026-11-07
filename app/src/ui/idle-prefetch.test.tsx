import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdlePrefetch } from './idle-prefetch';

const searchClientMock = vi.hoisted(() => ({ loaded: vi.fn(), warmIndex: vi.fn() }));
vi.mock('../search/search-client', () => {
  searchClientMock.loaded();
  return { warmIndex: searchClientMock.warmIndex };
});

describe('IdlePrefetch', () => {
  const originalConnection = Object.getOwnPropertyDescriptor(navigator, 'connection');

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    if (originalConnection) {
      Object.defineProperty(navigator, 'connection', originalConnection);
    } else {
      delete (navigator as unknown as { connection?: unknown }).connection;
    }
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
    delete (window as unknown as { cancelIdleCallback?: unknown }).cancelIdleCallback;
  });

  it('keeps search unloaded when the landing page sits idle', () => {
    const idleCallback = vi.fn();
    (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = idleCallback;
    vi.useFakeTimers();
    try {
      render(<IdlePrefetch />);
      vi.advanceTimersByTime(3000);
      expect(idleCallback).not.toHaveBeenCalled();
      expect(searchClientMock.loaded).not.toHaveBeenCalled();
      expect(searchClientMock.warmIndex).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips prefetching when navigator.connection.saveData is true', () => {
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true },
      configurable: true,
    });
    const idleSpy = vi.fn();
    (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = idleSpy;

    render(<IdlePrefetch />);
    expect(idleSpy).not.toHaveBeenCalled();
    expect(searchClientMock.loaded).not.toHaveBeenCalled();
  });

  it('skips prefetching when effectiveType is slow-2g or 2g', () => {
    for (const slowType of ['slow-2g', '2g']) {
      cleanup();
      Object.defineProperty(navigator, 'connection', {
        value: { effectiveType: slowType },
        configurable: true,
      });
      const idleSpy = vi.fn();
      (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = idleSpy;

      render(<IdlePrefetch />);
      expect(idleSpy).not.toHaveBeenCalled();
      expect(searchClientMock.loaded).not.toHaveBeenCalled();
    }
  });

  it('prefetches workflow document links on mouseover and touchstart', () => {
    const { container } = render(<IdlePrefetch />);
    const link = document.createElement('a');
    link.href = '/w/test-workflow-123/';
    const touchLink = document.createElement('a');
    touchLink.href = '/w/test-workflow-456/';
    container.append(link, touchLink);
    link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    touchLink.dispatchEvent(new Event('touchstart', { bubbles: true }));

    for (const href of ['/w/test-workflow-123/', '/w/test-workflow-456/']) {
      const prefetchLink = document.querySelector(`link[rel="prefetch"][href="${href}"]`);
      expect(prefetchLink).not.toBeNull();
      expect(prefetchLink?.getAttribute('as')).toBe('document');
    }
  });
});
